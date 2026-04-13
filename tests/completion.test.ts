import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionTracker } from "../src/completion.js";

describe("CompletionTracker", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vesper-completion-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 'complete' when watch file is empty", async () => {
    const watchFile = "todo.md";
    await Bun.write(join(tempDir, watchFile), "");

    const tracker = new CompletionTracker(watchFile, 3, tempDir);
    expect(await tracker.check()).toBe("complete");
  });

  it("returns 'complete' when watch file is only whitespace", async () => {
    const watchFile = "todo.md";
    await Bun.write(join(tempDir, watchFile), "   \n  \n  ");

    const tracker = new CompletionTracker(watchFile, 3, tempDir);
    expect(await tracker.check()).toBe("complete");
  });

  it("returns 'complete' when watch file does not exist", async () => {
    const tracker = new CompletionTracker("nonexistent.md", 3, tempDir);
    expect(await tracker.check()).toBe("complete");
  });

  it("returns 'continue' when watch file has content", async () => {
    const watchFile = "todo.md";
    await Bun.write(join(tempDir, watchFile), "- task 1\n- task 2\n");

    const tracker = new CompletionTracker(watchFile, 3, tempDir);
    expect(await tracker.check()).toBe("continue");
  });

  it("detects no-progress after consecutive unchanged iterations", async () => {
    const watchFile = "todo.md";
    const filePath = join(tempDir, watchFile);
    await Bun.write(filePath, "- task 1\n- task 2\n");

    const tracker = new CompletionTracker(watchFile, 3, tempDir);

    // First check establishes baseline
    expect(await tracker.check()).toBe("continue");

    // Three more checks with no change should trigger no_progress
    expect(await tracker.check()).toBe("continue"); // noProgressCount = 1
    expect(await tracker.check()).toBe("continue"); // noProgressCount = 2
    expect(await tracker.check()).toBe("no_progress"); // noProgressCount = 3
  });

  it("does not trigger no-progress when lines are being removed", async () => {
    const watchFile = "todo.md";
    const filePath = join(tempDir, watchFile);

    const tracker = new CompletionTracker(watchFile, 3, tempDir);

    // Start with 3 lines
    await Bun.write(filePath, "- task 1\n- task 2\n- task 3\n");
    expect(await tracker.check()).toBe("continue");

    // Remove one line each iteration — counter should reset each time
    await Bun.write(filePath, "- task 1\n- task 2\n");
    expect(await tracker.check()).toBe("continue");

    await Bun.write(filePath, "- task 1\n");
    expect(await tracker.check()).toBe("continue");

    // Even after many iterations, no no_progress since lines keep changing
    await Bun.write(filePath, "- task 1\n- new task\n");
    expect(await tracker.check()).toBe("continue");
  });

  it("returns 'complete' when no watch_file is configured", async () => {
    const tracker = new CompletionTracker(null, 3, tempDir);

    // No watch_file means single-iteration mode — always complete after iteration ends
    expect(await tracker.check()).toBe("complete");
    expect(await tracker.check()).toBe("complete");
  });

  it("returns no_progress with noProgressLimit 1 on second unchanged check", async () => {
    const watchFile = "todo.md";
    const filePath = join(tempDir, watchFile);
    await Bun.write(filePath, "- task 1\n");

    const tracker = new CompletionTracker(watchFile, 1, tempDir);

    // First check establishes baseline
    expect(await tracker.check()).toBe("continue");

    // Second check with unchanged content — noProgressCount hits limit of 1
    expect(await tracker.check()).toBe("no_progress");
  });

  it("resets no-progress counter when line count changes", async () => {
    const watchFile = "todo.md";
    const filePath = join(tempDir, watchFile);
    await Bun.write(filePath, "- task 1\n- task 2\n");

    const tracker = new CompletionTracker(watchFile, 3, tempDir);

    // Establish baseline
    expect(await tracker.check()).toBe("continue");

    // Two unchanged checks
    expect(await tracker.check()).toBe("continue"); // noProgressCount = 1
    expect(await tracker.check()).toBe("continue"); // noProgressCount = 2

    // Change the file — resets counter
    await Bun.write(filePath, "- task 2\n");
    expect(await tracker.check()).toBe("continue"); // noProgressCount = 0

    // Two more unchanged — should not yet trigger
    expect(await tracker.check()).toBe("continue"); // noProgressCount = 1
    expect(await tracker.check()).toBe("continue"); // noProgressCount = 2

    // Third unchanged — triggers
    expect(await tracker.check()).toBe("no_progress"); // noProgressCount = 3
  });
});
