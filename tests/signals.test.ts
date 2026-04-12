import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSignalPaths,
  writeComplete,
  writeNeedsApproval,
  writeFailed,
} from "../src/signals.js";

describe("signals", () => {
  let tempDir: string;

  const envVars = [
    "VESPER_SIGNAL_COMPLETE",
    "VESPER_SIGNAL_NEEDS_APPROVAL",
    "VESPER_SIGNAL_FAILED",
  ] as const;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vesper-signals-"));
    for (const key of envVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getSignalPaths", () => {
    it("falls back to defaults when environment variables are not set", () => {
      const paths = getSignalPaths(tempDir);
      expect(paths.complete).toBe(join(tempDir, ".vesper-complete"));
      expect(paths.needsApproval).toBe(join(tempDir, ".vesper-needs-approval"));
      expect(paths.failed).toBe(join(tempDir, ".vesper-failed"));
    });

    it("reads signal file names from environment variables", () => {
      process.env.VESPER_SIGNAL_COMPLETE = "done.sig";
      process.env.VESPER_SIGNAL_NEEDS_APPROVAL = "approval.sig";
      process.env.VESPER_SIGNAL_FAILED = "fail.sig";

      const paths = getSignalPaths(tempDir);
      expect(paths.complete).toBe(join(tempDir, "done.sig"));
      expect(paths.needsApproval).toBe(join(tempDir, "approval.sig"));
      expect(paths.failed).toBe(join(tempDir, "fail.sig"));
    });
  });

  describe("writeComplete", () => {
    it("writes complete signal as an empty file", async () => {
      await writeComplete(tempDir);
      const filePath = join(tempDir, ".vesper-complete");
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe("");
    });
  });

  describe("writeNeedsApproval", () => {
    it("writes needs-approval signal as valid JSON with reason, agent, and message fields", async () => {
      await writeNeedsApproval(tempDir, "coder", 50000, 30000, 25000);
      const filePath = join(tempDir, ".vesper-needs-approval");
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.reason).toBe("token_budget_exceeded");
      expect(content.agent).toBe("coder");
      expect(content.message).toBe(
        "Token budget of 50000 exhausted after 30000 input and 25000 output tokens.",
      );
    });
  });

  describe("writeFailed", () => {
    it("writes failed signal as valid JSON with reason, agent, and message fields", async () => {
      await writeFailed(tempDir, "reviewer", "no_progress", "No changes detected after 3 loops");
      const filePath = join(tempDir, ".vesper-failed");
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.reason).toBe("no_progress");
      expect(content.agent).toBe("reviewer");
      expect(content.message).toBe("No changes detected after 3 loops");
    });

    it("writes failed signal with error reason", async () => {
      await writeFailed(tempDir, "coder", "error", "API request failed");
      const filePath = join(tempDir, ".vesper-failed");

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.reason).toBe("error");
      expect(content.agent).toBe("coder");
      expect(content.message).toBe("API request failed");
    });
  });

  describe("signal file location", () => {
    it("writes all signal files to cwd, not to process cwd or elsewhere", async () => {
      await writeComplete(tempDir);
      await writeNeedsApproval(tempDir, "agent", 1000, 500, 600);
      await writeFailed(tempDir, "agent", "error", "fail");

      // All files should exist under tempDir
      expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
      expect(existsSync(join(tempDir, ".vesper-needs-approval"))).toBe(true);
      expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(true);

      // None should exist under the actual process cwd
      const processCwd = process.cwd();
      if (processCwd !== tempDir) {
        expect(existsSync(join(processCwd, ".vesper-complete"))).toBe(false);
        expect(existsSync(join(processCwd, ".vesper-needs-approval"))).toBe(false);
        expect(existsSync(join(processCwd, ".vesper-failed"))).toBe(false);
      }
    });
  });
});
