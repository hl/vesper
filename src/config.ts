import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { load as yamlLoad } from "js-yaml";
import { VesperError } from "./errors.js";

export interface AgentConfig {
  system_prompt: string;
  token_budget: number;
  log_denied_calls: boolean;
  model: string | undefined;
  reveal_permissions: boolean;
  log_events: boolean;
  command_timeout: number;
  scratchpad: string | null;
  tools: {
    read: string[];
    write: string[];
    delete: string[];
    commands: string[];
  };
  completion: {
    watch_file: string | null;
    no_progress_limit: number;
  };
}

export interface ResolvedAgent {
  configPath: string;
  promptPath: string;
  configDir: string;
}

export function resolveAgent(
  name: string,
  cwd: string,
  home?: string,
): ResolvedAgent {
  const homeDir = home ?? homedir();
  const locations = [
    join(cwd, ".vesper"),
    join(homeDir, ".config", "vesper"),
  ];

  for (const dir of locations) {
    const ymlPath = join(dir, `${name}.yml`);
    const mdPath = join(dir, `${name}.md`);
    const ymlExists = existsSync(ymlPath);
    const mdExists = existsSync(mdPath);

    if (ymlExists && mdExists) {
      return { configPath: ymlPath, promptPath: mdPath, configDir: dir };
    }

    if (ymlExists && !mdExists) {
      throw new VesperError(
        `Found ${ymlPath} but missing ${mdPath}`,
        1,
      );
    }

    if (!ymlExists && mdExists) {
      throw new VesperError(
        `Found ${mdPath} but missing ${ymlPath}`,
        1,
      );
    }
  }

  throw new VesperError(
    `Agent "${name}" not found in ${locations.join(" or ")}`,
    1,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringArray(
  value: unknown,
  fieldName: string,
): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new VesperError(
      `"${fieldName}" must be an array of strings`,
      1,
    );
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
    throw new VesperError(
      `Config file ${configPath} must be a YAML mapping`,
      1,
    );
  }

  // Required: system_prompt
  if (!("system_prompt" in parsed) || typeof parsed.system_prompt !== "string") {
    throw new VesperError(
      `Missing or invalid required key "system_prompt" in ${configPath}`,
      1,
    );
  }

  // Required: token_budget
  if (!("token_budget" in parsed) || typeof parsed.token_budget !== "number") {
    throw new VesperError(
      `Missing or invalid required key "token_budget" in ${configPath}`,
      1,
    );
  }
  if (parsed.token_budget <= 0) {
    throw new VesperError(
      `"token_budget" must be a positive number in ${configPath}`,
      1,
    );
  }

  // Required: tools
  if (!("tools" in parsed) || !isPlainObject(parsed.tools)) {
    throw new VesperError(
      `Missing or invalid required key "tools" in ${configPath}`,
      1,
    );
  }

  // Required: completion
  if (!("completion" in parsed) || !isPlainObject(parsed.completion)) {
    throw new VesperError(
      `Missing or invalid required key "completion" in ${configPath}`,
      1,
    );
  }

  const tools = parsed.tools;
  const completion = parsed.completion;

  // Validate tool arrays if present
  const toolRead = tools.read ?? [];
  const toolWrite = tools.write ?? [];
  const toolDelete = tools.delete ?? [];
  const toolCommands = tools.commands ?? [];

  assertStringArray(toolRead, "tools.read");
  assertStringArray(toolWrite, "tools.write");
  assertStringArray(toolDelete, "tools.delete");
  assertStringArray(toolCommands, "tools.commands");

  // Validate completion fields if present
  const watchFile = completion.watch_file ?? null;
  if (watchFile !== null && typeof watchFile !== "string") {
    throw new VesperError(
      `"completion.watch_file" must be a string or null`,
      1,
    );
  }

  const noProgressLimit = completion.no_progress_limit ?? 3;
  if (typeof noProgressLimit !== "number") {
    throw new VesperError(
      `"completion.no_progress_limit" must be a number`,
      1,
    );
  }

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

  return {
    system_prompt: parsed.system_prompt,
    token_budget: parsed.token_budget,
    log_denied_calls: typeof parsed.log_denied_calls === "boolean"
      ? parsed.log_denied_calls
      : false,
    model: typeof model === "string" ? model : undefined,
    reveal_permissions: typeof parsed.reveal_permissions === "boolean"
      ? parsed.reveal_permissions
      : false,
    log_events: typeof parsed.log_events === "boolean"
      ? parsed.log_events
      : false,
    command_timeout: commandTimeout,
    scratchpad,
    tools: {
      read: toolRead,
      write: toolWrite,
      delete: toolDelete,
      commands: toolCommands,
    },
    completion: {
      watch_file: watchFile,
      no_progress_limit: noProgressLimit,
    },
  };
}
