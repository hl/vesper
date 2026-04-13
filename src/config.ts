import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { VesperError } from "./errors.js";

export interface SignalConfig {
  complete: string;
  needs_approval: string;
  failed: string;
}

export interface AgentConfig {
  system_prompt: string;
  token_budget: number;
  log_denied_calls: boolean;
  model: string | undefined;
  reveal_permissions: boolean;
  log_events: boolean;
  command_timeout: number;
  command_env: string[];
  max_tool_result_size: number;
  scratchpad: string | null;
  skills: string | null;
  context_files: string[];
  default_signal: "complete" | "none";
  signals: SignalConfig;
  tools: {
    read: string[];
    write: string[];
    delete: string[];
    commands: string[];
  };
}

export interface ResolvedAgent {
  configPath: string;
  vesperDir: string;
}

export function resolveAgent(name: string, cwd: string, home?: string): ResolvedAgent {
  const homeDir = home ?? homedir();
  const vesperDirs = [join(cwd, ".vesper"), join(homeDir, ".config", "vesper")];

  for (const vesperDir of vesperDirs) {
    const agentsDir = join(vesperDir, "agents");
    const ymlPath = join(agentsDir, `${name}.yml`);

    if (existsSync(ymlPath)) {
      return { configPath: ymlPath, vesperDir };
    }
  }

  // Check if agent exists at the old .vesper/ path and provide migration hint
  const oldYml = join(cwd, ".vesper", `${name}.yml`);
  if (existsSync(oldYml)) {
    throw new VesperError(
      `Agent "${name}" found at ${join(cwd, ".vesper")} but Vesper now expects ${vesperDirs[0]}/agents/. ` +
        `Run: mkdir -p .vesper/agents && mv .vesper/*.yml .vesper/agents/`,
      1,
    );
  }

  const searchPaths = vesperDirs.map((d) => join(d, "agents"));
  throw new VesperError(`Agent "${name}" not found in ${searchPaths.join(" or ")}`, 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringArray(value: unknown, fieldName: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new VesperError(`"${fieldName}" must be an array of strings`, 1);
  }
}

export function loadConfig(configPath: string): AgentConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new VesperError(`Config file not found: ${configPath}`, 1);
    }
    throw err;
  }
  const parsed = yamlLoad(raw);

  if (!isPlainObject(parsed)) {
    throw new VesperError(`Config file ${configPath} must be a YAML mapping`, 1);
  }

  // Required: system_prompt
  if (!("system_prompt" in parsed) || typeof parsed.system_prompt !== "string") {
    throw new VesperError(`Missing or invalid required key "system_prompt" in ${configPath}`, 1);
  }

  // Required: token_budget
  if (!("token_budget" in parsed) || typeof parsed.token_budget !== "number") {
    throw new VesperError(`Missing or invalid required key "token_budget" in ${configPath}`, 1);
  }
  if (parsed.token_budget <= 0) {
    throw new VesperError(`"token_budget" must be a positive number in ${configPath}`, 1);
  }

  // Required: tools
  if (!("tools" in parsed) || !isPlainObject(parsed.tools)) {
    throw new VesperError(`Missing or invalid required key "tools" in ${configPath}`, 1);
  }

  const tools = parsed.tools;

  // Validate tool arrays if present
  const toolRead = tools.read ?? [];
  const toolWrite = tools.write ?? [];
  const toolDelete = tools.delete ?? [];
  const toolCommands = tools.commands ?? [];

  assertStringArray(toolRead, "tools.read");
  assertStringArray(toolWrite, "tools.write");
  assertStringArray(toolDelete, "tools.delete");
  assertStringArray(toolCommands, "tools.commands");

  // Optional v0.2 fields
  const model = parsed.model;
  if (model !== undefined && typeof model !== "string") {
    throw new VesperError(`"model" must be a string in ${configPath}`, 1);
  }

  const commandTimeout = parsed.command_timeout ?? 30;
  if (typeof commandTimeout !== "number" || commandTimeout <= 0) {
    throw new VesperError(`"command_timeout" must be a positive number in ${configPath}`, 1);
  }

  const scratchpad = parsed.scratchpad ?? null;
  if (scratchpad !== null && typeof scratchpad !== "string") {
    throw new VesperError(`"scratchpad" must be a string or null in ${configPath}`, 1);
  }

  const skills = parsed.skills ?? null;
  if (skills !== null && typeof skills !== "string") {
    throw new VesperError(`"skills" must be a string or null in ${configPath}`, 1);
  }

  const contextFiles = parsed.context_files ?? [];
  assertStringArray(contextFiles, "context_files");

  // v0.3: command_env
  const commandEnv = parsed.command_env ?? [];
  assertStringArray(commandEnv, "command_env");

  // v0.3: max_tool_result_size
  const maxToolResultSize = parsed.max_tool_result_size ?? 102400;
  if (typeof maxToolResultSize !== "number" || maxToolResultSize <= 0) {
    throw new VesperError(`"max_tool_result_size" must be a positive number in ${configPath}`, 1);
  }

  const defaultSignal = parsed.default_signal ?? "complete";
  if (defaultSignal !== "complete" && defaultSignal !== "none") {
    throw new VesperError(`"default_signal" must be "complete" or "none" in ${configPath}`, 1);
  }

  // v0.3: signals
  const signalsRaw = parsed.signals;
  let signals: SignalConfig;
  if (signalsRaw === undefined || signalsRaw === null) {
    signals = {
      complete: ".vesper-complete",
      needs_approval: ".vesper-needs-approval",
      failed: ".vesper-failed",
    };
  } else if (isPlainObject(signalsRaw)) {
    const complete = signalsRaw.complete ?? ".vesper-complete";
    const needsApproval = signalsRaw.needs_approval ?? ".vesper-needs-approval";
    const failed = signalsRaw.failed ?? ".vesper-failed";
    if (
      typeof complete !== "string" ||
      typeof needsApproval !== "string" ||
      typeof failed !== "string"
    ) {
      throw new VesperError(`"signals" values must be strings in ${configPath}`, 1);
    }
    signals = { complete, needs_approval: needsApproval, failed };
  } else {
    throw new VesperError(`"signals" must be a mapping in ${configPath}`, 1);
  }

  return {
    system_prompt: parsed.system_prompt,
    token_budget: parsed.token_budget,
    log_denied_calls:
      typeof parsed.log_denied_calls === "boolean" ? parsed.log_denied_calls : false,
    model: typeof model === "string" ? model : undefined,
    reveal_permissions:
      typeof parsed.reveal_permissions === "boolean" ? parsed.reveal_permissions : false,
    log_events: typeof parsed.log_events === "boolean" ? parsed.log_events : false,
    command_timeout: commandTimeout,
    command_env: commandEnv,
    max_tool_result_size: maxToolResultSize,
    default_signal: defaultSignal,
    scratchpad,
    skills,
    context_files: contextFiles,
    signals,
    tools: {
      read: toolRead,
      write: toolWrite,
      delete: toolDelete,
      commands: toolCommands,
    },
  };
}
