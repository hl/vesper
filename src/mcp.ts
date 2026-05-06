import type Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "./config.js";
import { VesperError } from "./errors.js";
import type { Logger } from "./logger.js";
import { buildCommandEnv, truncateResult } from "./tools.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const BUILT_IN_TOOL_NAMES = new Set([
  "read_file",
  "list_files",
  "write_file",
  "patch_file",
  "delete_file",
  "run_command",
  "subagent",
  "Task",
  "signal",
]);
const MODEL_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type JsonObject = Record<string, unknown>;

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpToolMapEntry {
  server: string;
  tool: string;
  grant: "read" | "write";
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface McpPreparedRuntime {
  tools: Anthropic.Tool[];
  toolMap: Map<string, McpToolMapEntry>;
  execute(normalizedName: string, input: unknown): Promise<string>;
  close(): Promise<void>;
}

class McpProtocolError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitGrant(grant: string): { server: string; tool: string } | null {
  const dot = grant.indexOf(".");
  if (dot <= 0 || dot === grant.length - 1) return null;
  return { server: grant.slice(0, dot), tool: grant.slice(dot + 1) };
}

export function normalizeMcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

function validateInputSchema(schema: unknown, provider: AgentConfig["provider"]): JsonObject {
  if (!isJsonObject(schema) || schema.type !== "object") {
    throw new VesperError("Granted MCP tool has missing or incompatible inputSchema", 1);
  }
  if ("properties" in schema && !isJsonObject(schema.properties)) {
    throw new VesperError("Granted MCP tool has provider-incompatible inputSchema.properties", 1);
  }
  if (
    "required" in schema &&
    (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string"))
  ) {
    throw new VesperError("Granted MCP tool has provider-incompatible inputSchema.required", 1);
  }

  try {
    JSON.stringify(schema);
  } catch {
    throw new VesperError("Granted MCP tool has non-serializable inputSchema", 1);
  }

  // OpenAI receives this schema through the function-tool parameters field; keeping the
  // schema object-shaped here matches Vesper's existing provider adapter expectations.
  if (provider === "openai" && schema.type !== "object") {
    throw new VesperError("Granted MCP tool has provider-incompatible inputSchema", 1);
  }

  return schema;
}

function shapeMcpContent(content: unknown): unknown[] {
  return Array.isArray(content)
    ? content.map((item) => (isJsonObject(item) ? item : { type: "unknown", value: item }))
    : [];
}

function shapeStructuredContent(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function truncateMcpPayload(payload: JsonObject, maxResultSize: number): string {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf-8") <= maxResultSize) return serialized;

  const fallback = {
    ...payload,
    content: [
      {
        type: "text",
        text: truncateResult(serialized, maxResultSize),
      },
    ],
    structured_content: null,
  };
  return truncateResult(JSON.stringify(fallback), maxResultSize);
}

class McpServerConnection {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutSeconds: number;
  private nextId = 1;
  private stdoutBuffer = "";
  private closed = false;
  private hardKillTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly name: string,
    command: string,
    args: string[],
    env: string[],
    cwd: string,
    timeoutSeconds: number,
  ) {
    this.timeoutSeconds = timeoutSeconds;
    this.proc = Bun.spawn([command, ...args], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: buildCommandEnv(env),
    });
    void this.readStdout();
    void this.drainStderr();
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "vesper", version: "0.10.1" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const response = await this.request("tools/list", {});
    if (!isJsonObject(response) || !Array.isArray(response.tools)) {
      throw new McpProtocolError("MCP tools/list response did not include a tools array");
    }
    return response.tools.filter(isJsonObject) as unknown as McpToolDefinition[];
  }

  async callTool(tool: string, input: unknown): Promise<JsonObject> {
    const response = await this.request("tools/call", {
      name: tool,
      arguments: isJsonObject(input) ? input : {},
    });
    if (!isJsonObject(response)) {
      throw new McpProtocolError("MCP tools/call response was not an object");
    }
    return response;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // Best-effort shutdown.
    }

    let exited = false;
    const exitedPromise = this.proc.exited
      .then(() => {
        exited = true;
      })
      .catch(() => {
        exited = true;
      });
    const timeoutMs = Math.max(1000, Math.min(this.timeoutSeconds * 1000, 5000));

    await Promise.race([
      exitedPromise,
      new Promise((resolveDelay) => setTimeout(resolveDelay, 250)),
    ]);
    if (!exited) {
      this.proc.kill();
      this.hardKillTimer = setTimeout(() => {
        this.proc.kill(9);
      }, timeoutMs);
    }

    await Promise.race([
      exitedPromise,
      new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs + 100)),
    ]);
    if (this.hardKillTimer !== undefined) clearTimeout(this.hardKillTimer);
  }

  private notify(method: string, params: JsonObject): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.timeoutSeconds * 1000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpProtocolError(`MCP request "${method}" timed out after ${this.timeoutSeconds}s`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.writeMessage({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private writeMessage(message: JsonObject): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async readStdout(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stdoutBuffer += decoder.decode(value, { stream: true });
        this.processStdoutBuffer();
      }
      this.stdoutBuffer += decoder.decode();
      this.processStdoutBuffer();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new McpProtocolError("MCP server exited before responding"));
      }
      this.pending.clear();
    } catch (err) {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
    }
  }

  private processStdoutBuffer(): void {
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.handleMessageLine(line);
    }
  }

  private handleMessageLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isJsonObject(message) || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (isJsonObject(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : null;
      const text =
        typeof message.error.message === "string" ? message.error.message : "MCP protocol error";
      pending.reject(new McpProtocolError(text, code));
      return;
    }
    pending.resolve(message.result);
  }

  private async drainStderr(): Promise<void> {
    const reader = this.proc.stderr.getReader();
    try {
      while (!(await reader.read()).done) {
        // Drain stderr so noisy MCP servers cannot block on pipe backpressure.
      }
    } catch {
      // Best-effort drain.
    }
  }
}

export async function prepareMcpRuntime(
  config: AgentConfig,
  cwd: string,
  logger: Logger,
): Promise<McpPreparedRuntime | null> {
  const grants = [...config.tools.mcp_read, ...config.tools.mcp_write];
  if (grants.length === 0) return null;

  const requiredServers = new Set<string>();
  const readGrants = new Set(config.tools.mcp_read);
  const writeGrants = new Set(config.tools.mcp_write);
  for (const grant of grants) {
    const parsed = splitGrant(grant);
    if (parsed === null) {
      throw new VesperError(`Invalid MCP grant "${grant}": expected <server>.<tool>`, 1);
    }
    if (!(parsed.server in config.mcp_servers)) {
      throw new VesperError(
        `MCP grant "${grant}" references undefined server "${parsed.server}"`,
        1,
      );
    }
    requiredServers.add(parsed.server);
  }

  const connections = new Map<string, McpServerConnection>();
  const toolMap = new Map<string, McpToolMapEntry>();
  const tools: Anthropic.Tool[] = [];

  try {
    for (const server of requiredServers) {
      const serverConfig = config.mcp_servers[server];
      const startupStart = Date.now();
      const connection = new McpServerConnection(
        server,
        serverConfig.command,
        serverConfig.args,
        serverConfig.env,
        cwd,
        config.command_timeout,
      );
      connections.set(server, connection);
      try {
        await connection.initialize();
        logger.mcpServerStartup(server, serverConfig.command, true, Date.now() - startupStart);
      } catch (err) {
        logger.mcpServerStartup(server, serverConfig.command, false, Date.now() - startupStart);
        throw err;
      }

      const serverTools = await connection.listTools();
      for (const tool of serverTools) {
        const exactName = `${server}.${tool.name}`;
        if (!readGrants.has(exactName) && !writeGrants.has(exactName)) continue;

        const normalizedName = normalizeMcpToolName(server, tool.name);
        if (
          BUILT_IN_TOOL_NAMES.has(normalizedName) ||
          toolMap.has(normalizedName) ||
          !MODEL_TOOL_NAME_PATTERN.test(normalizedName)
        ) {
          throw new VesperError(
            `MCP tool name collision or invalid tool name: ${normalizedName}`,
            1,
          );
        }

        const schema = validateInputSchema(tool.inputSchema, config.provider);
        toolMap.set(normalizedName, {
          server,
          tool: tool.name,
          grant: writeGrants.has(exactName) ? "write" : "read",
        });
        tools.push({
          name: normalizedName,
          description: tool.description ?? `MCP tool ${exactName}`,
          input_schema: schema as Anthropic.Tool.InputSchema,
        });
      }
    }
  } catch (err) {
    await Promise.all([...connections.values()].map((connection) => connection.close()));
    throw err;
  }

  return {
    tools,
    toolMap,
    execute: async (normalizedName: string, input: unknown): Promise<string> => {
      const entry = toolMap.get(normalizedName);
      if (entry === undefined) {
        return JSON.stringify({ error: "permission_denied" });
      }

      const connection = connections.get(entry.server);
      if (connection === undefined) {
        return JSON.stringify({
          ok: false,
          server: entry.server,
          tool: entry.tool,
          error: { code: null, message: "MCP server is not running" },
          is_error: true,
        });
      }

      try {
        const result = await connection.callTool(entry.tool, input);
        const isError = result.isError === true;
        return truncateMcpPayload(
          {
            ok: !isError,
            server: entry.server,
            tool: entry.tool,
            content: shapeMcpContent(result.content),
            structured_content: shapeStructuredContent(result.structuredContent),
            is_error: isError,
          },
          config.max_tool_result_size,
        );
      } catch (err) {
        const protocolError = err instanceof McpProtocolError;
        return truncateMcpPayload(
          {
            ok: false,
            server: entry.server,
            tool: entry.tool,
            error: {
              code: protocolError ? err.code : null,
              message: err instanceof Error ? err.message : String(err),
            },
            is_error: true,
          },
          config.max_tool_result_size,
        );
      }
    },
    close: async (): Promise<void> => {
      await Promise.all([...connections.values()].map((connection) => connection.close()));
    },
  };
}

export function mcpPermissionDeniedResponse(config: AgentConfig, normalizedName: string): string {
  if (config.reveal_permissions) {
    return JSON.stringify({
      error: "permission_denied",
      tool: normalizedName,
      allowed_mcp_read: config.tools.mcp_read,
      allowed_mcp_write: config.tools.mcp_write,
    });
  }
  return JSON.stringify({ error: "permission_denied" });
}
