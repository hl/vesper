export class Logger {
  private readonly enabled: boolean;
  readonly runId: string;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.runId = crypto.randomUUID();
  }

  private emit(event: string, data: Record<string, unknown>): void {
    if (!this.enabled) return;
    const line = JSON.stringify({
      event,
      run_id: this.runId,
      timestamp: new Date().toISOString(),
      ...data,
    });
    process.stderr.write(`${line}\n`);
  }

  apiCall(model: string, inputTokens: number, outputTokens: number, latencyMs: number): void {
    this.emit("api_call", {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      latency_ms: latencyMs,
    });
  }

  toolCall(tool: string, target: string, permitted: boolean, durationMs: number): void {
    this.emit("tool_call", { tool, target, permitted, duration_ms: durationMs });
  }

  subagentUsage(agent: string, inputTokens: number, outputTokens: number): void {
    this.emit("subagent_usage", {
      agent,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  }

  mcpServerStartup(server: string, command: string, success: boolean, durationMs: number): void {
    this.emit("mcp_server_startup", {
      server,
      command,
      success,
      duration_ms: durationMs,
    });
  }

  mcpToolCall(
    server: string,
    tool: string,
    permitted: boolean,
    durationMs: number,
    success: boolean,
  ): void {
    this.emit("mcp_tool_call", {
      server,
      tool,
      permitted,
      success,
      duration_ms: durationMs,
    });
  }

  signalWrite(signalType: string, path: string): void {
    this.emit("signal_write", { signal_type: signalType, path });
  }

  skillsLoaded(fileCount: number, totalBytes: number, files: string[]): void {
    this.emit("skills_loaded", { file_count: fileCount, total_bytes: totalBytes, files });
  }

  contextFilesLoaded(loaded: string[], skipped: string[]): void {
    this.emit("context_files_loaded", { loaded, skipped });
  }

  contextWindowUnknown(model: string, fallbackWindow: number): void {
    this.emit("context_window_unknown", { model, fallback_window: fallbackWindow });
  }

  contextEstimationDrift(estimated: number, actual: number, ratio: number): void {
    this.emit("context_estimation_drift", { estimated, actual, ratio });
  }

  contextGuardTriggered(estimatedTokens: number, modelWindow: number): void {
    this.emit("context_guard_triggered", {
      estimated_tokens: estimatedTokens,
      model_window: modelWindow,
    });
  }

  contextPruned(messagesPruned: number, estimatedTokensSaved: number): void {
    this.emit("context_pruned", {
      messages_pruned: messagesPruned,
      estimated_tokens_saved: estimatedTokensSaved,
    });
  }

  contextCompacted(beforeTokens: number, afterTokens: number): void {
    this.emit("context_compacted", {
      before_tokens: beforeTokens,
      after_tokens: afterTokens,
    });
  }
}
