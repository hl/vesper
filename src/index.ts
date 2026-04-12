import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { runAgent } from "./agent.js";
import { CompletionTracker } from "./completion.js";
import { type AgentConfig, loadConfig, resolveAgent } from "./config.js";
import { exitWithError, VesperError } from "./errors.js";
import { writeComplete, writeFailed } from "./signals.js";

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .command("$0 <agent>", "Run a Vesper agent", (y) =>
      y.positional("agent", {
        type: "string",
        demandOption: true,
        describe: "Name of the agent to run",
      }),
    )
    .option("cwd", {
      type: "string",
      default: process.cwd(),
      describe: "Working directory",
    })
    .strict()
    .parse();

  const agentName = argv.agent as string;
  const cwd = argv.cwd as string;

  // Resolve and load config
  let configPath: string;
  let configDir: string;
  try {
    const resolved = resolveAgent(agentName, cwd);
    configPath = resolved.configPath;
    configDir = resolved.configDir;
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

  // Read system prompt from the path specified in the YAML config
  const systemPromptFile = Bun.file(`${configDir}/${config.system_prompt}`);
  if (!(await systemPromptFile.exists())) {
    exitWithError(`System prompt file not found: ${configDir}/${config.system_prompt}`);
  }
  const systemPrompt = await systemPromptFile.text();

  // Early completion check: if watch file is configured and already empty/missing,
  // write complete signal and exit without making any API calls
  if (config.completion.watch_file !== null) {
    const tracker = new CompletionTracker(
      config.completion.watch_file,
      config.completion.no_progress_limit,
      cwd,
    );
    const status = await tracker.check();
    if (status === "complete") {
      await writeComplete(cwd);
      process.exit(0);
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
    await writeFailed(cwd, agentName, "error", `Unexpected error: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[vesper] Fatal: ${message}\n`);
  process.exit(1);
});
