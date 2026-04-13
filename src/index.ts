import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Argv } from "yargs";
import { runAgent } from "./agent.js";
import { type AgentConfig, loadConfig, resolveAgent } from "./config.js";
import { exitWithError, VesperError } from "./errors.js";
import { init } from "./init.js";
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
  for (const file of files) {
    const filePath = resolve(cwd, file);
    if (existsSync(filePath)) {
      const text = readFileSync(filePath, "utf-8");
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
    .command("run <agent>", "Run a Vesper agent", (y: Argv) =>
      y.positional("agent", {
        type: "string",
        demandOption: true,
        describe: "Name of the agent to run",
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
    .command("$0 [agent]", false, (y: Argv) =>
      y.positional("agent", {
        type: "string",
        describe: "Name of the agent to run",
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

async function handleRun(agentName: string, cwd: string): Promise<void> {
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

  // Read system prompt — path in YAML is relative to vesperDir (.vesper/ or ~/.config/vesper/)
  const systemPromptFile = Bun.file(`${vesperDir}/${config.system_prompt}`);
  if (!(await systemPromptFile.exists())) {
    exitWithError(`System prompt file not found: ${vesperDir}/${config.system_prompt}`);
  }
  let systemPrompt = await systemPromptFile.text();

  // Append context files to system prompt (paths resolved relative to cwd)
  if (config.context_files.length > 0) {
    const result = loadContextFiles(config.context_files, cwd);
    if (result.content.length > 0) {
      systemPrompt += result.content;
    }
  }

  // Read task prompt from stdin
  const taskPrompt = await Bun.stdin.text();
  if (!taskPrompt.trim()) {
    exitWithError("No task prompt provided on stdin");
  }

  // Run the agent
  try {
    const result = await runAgent(config, systemPrompt, taskPrompt, cwd, agentName);
    process.exit(result.exitCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeFailed(signalPaths, agentName, "error", `Unexpected error: ${message}`);
    process.exit(1);
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
    await handleRun((argv as ParsedRunArgs).agent, cwd);
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
    await handleRun(argv.agent, cwd);
  } else {
    parser.showHelp();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[vesper] Fatal: ${message}\n`);
  process.exit(1);
});
