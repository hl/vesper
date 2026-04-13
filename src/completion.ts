import { join } from "node:path";

export class CompletionTracker {
  private readonly watchFile: string | null;
  private readonly noProgressLimit: number;
  private readonly cwd: string;
  private previousLineCount: number | null = null;
  private noProgressCount = 0;

  constructor(watchFile: string | null, noProgressLimit: number, cwd: string) {
    this.watchFile = watchFile;
    this.noProgressLimit = noProgressLimit;
    this.cwd = cwd;
  }

  async check(): Promise<"complete" | "continue" | "no_progress"> {
    if (this.watchFile === null) {
      return "complete";
    }

    const resolved = join(this.cwd, this.watchFile);
    const file = Bun.file(resolved);

    if (!(await file.exists())) {
      return "complete";
    }

    const content = await file.text();

    if (content.trim().length === 0) {
      return "complete";
    }

    const nonEmptyLines = content.split("\n").filter((line) => line.trim().length > 0);
    const lineCount = nonEmptyLines.length;

    if (this.previousLineCount !== null && lineCount === this.previousLineCount) {
      this.noProgressCount++;
    } else {
      this.noProgressCount = 0;
    }

    this.previousLineCount = lineCount;

    if (this.noProgressCount >= this.noProgressLimit) {
      return "no_progress";
    }

    return "continue";
  }
}
