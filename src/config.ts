import { readFileSync, existsSync } from "node:fs";
import { join, } from "node:path";
import { homedir } from "node:os";
import { load as yamlLoad } from "js-yaml";
import { VesperError } from "./errors.js";

export interface AgentConfig {
  system_prompt: string;
  token_budget: number;
  log_denied_calls: boolean;
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
    `Agent "${name}" not found in ${locations.map((l) => l).join(" or ")}`,
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
  const raw = readFileSync(configPath, "utf-8");
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

  return {
    system_prompt: parsed.system_prompt,
    token_budget: parsed.token_budget,
    log_denied_calls: typeof parsed.log_denied_calls === "boolean"
      ? parsed.log_denied_calls
      : false,
    tools: {
      read: toolRead as string[],
      write: toolWrite as string[],
      delete: toolDelete as string[],
      commands: toolCommands as string[],
    },
    completion: {
      watch_file: watchFile as string | null,
      no_progress_limit: noProgressLimit as number,
    },
  };
}
