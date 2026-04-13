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

  signalWrite(signalType: string, path: string): void {
    this.emit("signal_write", { signal_type: signalType, path });
  }

  skillsLoaded(fileCount: number, totalBytes: number, files: string[]): void {
    this.emit("skills_loaded", { file_count: fileCount, total_bytes: totalBytes, files });
  }

  contextFilesLoaded(loaded: string[], skipped: string[]): void {
    this.emit("context_files_loaded", { loaded, skipped });
  }
}
