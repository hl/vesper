import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Argv } from "yargs";
import { runAgent } from "./agent.js";
import { type AgentConfig, loadConfig, resolveAgent } from "./config.js";
import { exitWithError, VesperError } from "./errors.js";
import { init } from "./init.js";
import { isContained } from "./permissions.js";
import { checkStaleSignals, getSignalPaths, writeFailed } from "./signals.js";
import { VERSION } from "./version.js";

export const RESERVED_NAMES = ["init", "run", "help", "version"];

export function loadContextFiles(
  files: string[],
  cwd: string,
): { content: string; loaded: string[]; skipped: string[] } {
  const loaded: string[] = [];
  const skipped: string[] = [];
  let content = "";
  const realCwd = realpathSync(cwd);
  for (const file of files) {
    const filePath = resolve(cwd, file);
    if (existsSync(filePath)) {
      let realPath: string;
      try {
        realPath = realpathSync(filePath);
      } catch {
        skipped.push(file);
        continue;
      }
      if (!isContained(realPath, realCwd)) {
        process.stderr.write(`[vesper] skipped context file outside cwd: ${file}\n`);
        skipped.push(file);
        continue;
      }
      const text = readFileSync(realPath, "utf-8");
      if (text.trim().length > 0) {
        content += `\n\n# ${file}\n\n${text}`;
        loaded.push(file);
      } else {
        skipped.push(file);
      }
    } else {
      skipped.push(file);
    }
  }
  return { content, loaded, skipped };
}

interface ParsedRunArgs {
  _: string[];
  agent: string;
  cwd: string;
  prompt?: string[];
  task?: string;
}

interface ParsedInitArgs {
  _: string[];
  cwd: string;
  force: boolean;
  global: boolean;
}

type ParsedArgs = ParsedRunArgs | ParsedInitArgs;

export function buildParser(argv: Argv): Argv {
  return argv
    .scriptName("vesper")
    .version(VERSION)
    .option("cwd", {
      type: "string",
      default: process.cwd(),
      describe: "Working directory",
      global: true,
    })
    .command("run <agent> [prompt..]", "Run a Vesper agent", (y: Argv) =>
      y
        .positional("agent", {
          type: "string",
          demandOption: true,
          describe: "Name of the agent to run",
        })
        .positional("prompt", {
          type: "string",
          array: true,
          describe: "Task prompt words. If omitted, stdin is used",
        })
        .option("task", {
          alias: "t",
          type: "string",
          describe: "Task prompt. If omitted, stdin is used",
        }),
    )
    .command("init", "Scaffold a .vesper/ project directory", (y: Argv) =>
      y
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Overwrite existing example files",
        })
        .option("global", {
          type: "boolean",
          default: false,
          describe: "Scaffold ~/.config/vesper/ instead of .vesper/",
        }),
    )
    .command("$0 [agent] [prompt..]", false, (y: Argv) =>
      y
        .positional("agent", {
          type: "string",
          describe: "Name of the agent to run",
        })
        .positional("prompt", {
          type: "string",
          array: true,
          describe: "Task prompt words. If omitted, stdin is used",
        })
        .option("task", {
          alias: "t",
          type: "string",
          describe: "Task prompt. If omitted, stdin is used",
        }),
    )
    .strict();
}

export function checkReservedName(agentName: string): void {
  if (RESERVED_NAMES.includes(agentName)) {
    throw new VesperError(
      `"${agentName}" is a reserved command name and cannot be used as an agent name`,
    );
  }
}

export function getTaskPromptFromArgs(args: {
  prompt?: string[];
  task?: string;
}): string | undefined {
  const positionalPrompt =
    args.prompt !== undefined && args.prompt.length > 0 ? args.prompt.join(" ") : undefined;

  if (args.task !== undefined && positionalPrompt !== undefined) {
    throw new VesperError(
      "Provide the task prompt either as --task or positional arguments, not both",
      1,
    );
  }

  return args.task ?? positionalPrompt;
}

export function resolveTaskPrompt(cliTaskPrompt: string | undefined, stdinPrompt: string): string {
  const taskPrompt = cliTaskPrompt ?? stdinPrompt;
  if (!taskPrompt.trim()) {
    throw new VesperError("No task prompt provided. Pass one as arguments or on stdin", 1);
  }
  return taskPrompt;
}

async function handleRun(agentName: string, cwd: string, cliTaskPrompt?: string): Promise<void> {
  // Reserved name check
  checkReservedName(agentName);

  // Resolve and load config
  let configPath: string;
  let vesperDir: string;
  try {
    const resolved = resolveAgent(agentName, cwd);
    configPath = resolved.configPath;
    vesperDir = resolved.vesperDir;
  } catch (err) {
    if (err instanceof VesperError) {
      exitWithError(err.message, err.code);
    }
    throw err;
  }

  let config: AgentConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    if (err instanceof VesperError) {
      exitWithError(err.message, err.code);
    }
    throw err;
  }

  // Resolve signal paths from config
  const signalPaths = getSignalPaths(cwd, config.signals);

  // Check for stale signal files — exit 1 if any exist (R4)
  const stale = checkStaleSignals(signalPaths);
  if (stale !== null) {
    exitWithError(`Stale signal file found: ${stale}. Clean up signal files before re-running.`);
  }

  // All I/O from here can fail — wrap in try-catch to emit signal files on error
  try {
    // Read system prompt — path in YAML is relative to vesperDir (.vesper/ or ~/.config/vesper/)
    const systemPromptPath = resolve(vesperDir, config.system_prompt);
    const realVesperDir = realpathSync(vesperDir);
    let realSystemPromptPath: string;
    try {
      realSystemPromptPath = realpathSync(systemPromptPath);
    } catch {
      throw new VesperError(`System prompt file not found: ${systemPromptPath}`, 1);
    }
    if (!isContained(realSystemPromptPath, realVesperDir)) {
      throw new VesperError(
        `System prompt path "${config.system_prompt}" resolves outside vesper directory`,
        1,
      );
    }
    let systemPrompt = readFileSync(realSystemPromptPath, "utf-8");

    // Append context files to system prompt (paths resolved relative to cwd)
    if (config.context_files.length > 0) {
      const result = loadContextFiles(config.context_files, cwd);
      if (result.content.length > 0) {
        systemPrompt += result.content;
      }
    }

    // Prefer a CLI prompt; fall back to stdin for existing orchestrator integrations.
    const stdinPrompt = cliTaskPrompt === undefined ? await Bun.stdin.text() : "";
    const taskPrompt = resolveTaskPrompt(cliTaskPrompt, stdinPrompt);

    // Run the agent
    const result = await runAgent(config, systemPrompt, taskPrompt, cwd, agentName);
    process.exit(result.exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeFailed(signalPaths, agentName, "error", message);
    exitWithError(message);
  }
}

async function main(): Promise<void> {
  const yargsModule = await import("yargs");
  const { hideBin } = await import("yargs/helpers");
  const parser = buildParser(yargsModule.default(hideBin(process.argv)));
  const argv = (await parser.parse()) as unknown as ParsedArgs;

  const command = argv._[0] as string | undefined;
  const cwd = argv.cwd;

  if (command === "run") {
    const runArgs = argv as ParsedRunArgs;
    await handleRun(runArgs.agent, cwd, getTaskPromptFromArgs(runArgs));
  } else if (command === "init") {
    const initArgs = argv as ParsedInitArgs;
    try {
      await init({ force: initArgs.force, global: initArgs.global, cwd: cwd });
    } catch (err) {
      if (err instanceof VesperError) {
        exitWithError(err.message, err.code);
      }
      throw err;
    }
  } else if ("agent" in argv && argv.agent) {
    // Default command: vesper <agent> alias
    const runArgs = argv as ParsedRunArgs;
    await handleRun(runArgs.agent, cwd, getTaskPromptFromArgs(runArgs));
  } else {
    parser.showHelp();
  }
}

main().catch((err) => {
  if (err instanceof VesperError) {
    exitWithError(err.message, err.code);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[vesper] Fatal: ${message}\n`);
  process.exit(1);
});
