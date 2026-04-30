import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VesperError } from "../src/errors.js";
import {
  checkStaleSignals,
  getSignalPaths,
  type SignalPaths,
  writeAgentNeedsApproval,
  writeComplete,
  writeFailed,
  writeNeedsApproval,
} from "../src/signals.js";

describe("signals", () => {
  let tempDir: string;
  let realTempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vesper-signals-"));
    realTempDir = realpathSync(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function defaultSignals(): SignalPaths {
    return getSignalPaths(tempDir, {
      complete: ".vesper-complete",
      needs_approval: ".vesper-needs-approval",
      failed: ".vesper-failed",
    });
  }

  describe("getSignalPaths", () => {
    it("resolves signal paths from config with defaults", () => {
      const paths = defaultSignals();
      expect(paths.complete).toBe(join(realTempDir, ".vesper-complete"));
      expect(paths.needsApproval).toBe(join(realTempDir, ".vesper-needs-approval"));
      expect(paths.failed).toBe(join(realTempDir, ".vesper-failed"));
    });

    it("resolves custom signal names from config", () => {
      const paths = getSignalPaths(tempDir, {
        complete: "done.sig",
        needs_approval: "approval.sig",
        failed: "fail.sig",
      });
      expect(paths.complete).toBe(join(realTempDir, "done.sig"));
      expect(paths.needsApproval).toBe(join(realTempDir, "approval.sig"));
      expect(paths.failed).toBe(join(realTempDir, "fail.sig"));
    });

    it("rejects signal paths that traverse outside cwd", () => {
      expect(() =>
        getSignalPaths(tempDir, {
          complete: ".vesper-complete",
          needs_approval: ".vesper-needs-approval",
          failed: "../../etc/cron.d/backdoor",
        }),
      ).toThrow(VesperError);
    });

    it("rejects signal paths through symlinked directories", () => {
      const outsideDir = mkdtempSync(join(tmpdir(), "vesper-outside-"));
      try {
        mkdirSync(join(tempDir, "logs-parent"), { recursive: true });
        symlinkSync(outsideDir, join(tempDir, "logs-parent", "logs"));
        expect(() =>
          getSignalPaths(tempDir, {
            complete: ".vesper-complete",
            needs_approval: ".vesper-needs-approval",
            failed: "logs-parent/logs/fail.json",
          }),
        ).toThrow(VesperError);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("rejects absolute signal paths", () => {
      expect(() =>
        getSignalPaths(tempDir, {
          complete: "/tmp/evil",
          needs_approval: ".vesper-needs-approval",
          failed: ".vesper-failed",
        }),
      ).toThrow(VesperError);
    });
  });

  describe("checkStaleSignals", () => {
    it("returns null when no signal files exist", () => {
      const paths = defaultSignals();
      expect(checkStaleSignals(paths)).toBeNull();
    });

    it("returns path of stale complete signal", () => {
      const paths = defaultSignals();
      writeFileSync(paths.complete, "");
      expect(checkStaleSignals(paths)).toBe(paths.complete);
    });

    it("returns path of stale failed signal", () => {
      const paths = defaultSignals();
      writeFileSync(paths.failed, "{}");
      expect(checkStaleSignals(paths)).toBe(paths.failed);
    });

    it("returns path of stale needs-approval signal", () => {
      const paths = defaultSignals();
      writeFileSync(paths.needsApproval, "{}");
      expect(checkStaleSignals(paths)).toBe(paths.needsApproval);
    });
  });

  describe("writeComplete", () => {
    it("writes complete signal as an empty file when no message is provided", async () => {
      const paths = defaultSignals();
      await writeComplete(paths);
      expect(existsSync(paths.complete)).toBe(true);
      expect(readFileSync(paths.complete, "utf-8")).toBe("");
    });

    it("writes complete signal as JSON when final text is provided", async () => {
      const paths = defaultSignals();
      await writeComplete(paths, "coder", "All done.");

      const content = JSON.parse(readFileSync(paths.complete, "utf-8"));
      expect(content.reason).toBe("complete");
      expect(content.agent).toBe("coder");
      expect(content.message).toBe("All done.");
      expect(content.context).toBe("All done.");
    });
  });

  describe("writeNeedsApproval", () => {
    it("writes needs-approval signal as valid JSON with correct fields", async () => {
      const paths = defaultSignals();
      await writeNeedsApproval(paths, "coder", 50000, 30000, 25000, "Working on task 3");
      expect(existsSync(paths.needsApproval)).toBe(true);

      const content = JSON.parse(readFileSync(paths.needsApproval, "utf-8"));
      expect(content.reason).toBe("token_budget_exceeded");
      expect(content.agent).toBe("coder");
      expect(content.message).toBe(
        "Token budget of 50000 exhausted after 30000 input and 25000 output tokens.",
      );
      expect(content.context).toBe("Working on task 3");
    });

    it("writes null context when none provided", async () => {
      const paths = defaultSignals();
      await writeNeedsApproval(paths, "coder", 50000, 30000, 25000, null);
      const content = JSON.parse(readFileSync(paths.needsApproval, "utf-8"));
      expect(content.context).toBeNull();
    });
  });

  describe("writeFailed", () => {
    it("writes failed signal with error reason", async () => {
      const paths = defaultSignals();
      await writeFailed(paths, "coder", "error", "API request failed");

      const content = JSON.parse(readFileSync(paths.failed, "utf-8"));
      expect(content.reason).toBe("error");
      expect(content.agent).toBe("coder");
      expect(content.message).toBe("API request failed");
      expect(content.context).toBeNull();
    });

    it("includes context when provided", async () => {
      const paths = defaultSignals();
      await writeFailed(paths, "coder", "error", "Budget exhausted", "Stuck on auth module");

      const content = JSON.parse(readFileSync(paths.failed, "utf-8"));
      expect(content.context).toBe("Stuck on auth module");
    });
  });

  describe("writeAgentNeedsApproval", () => {
    it("writes needs-approval signal with agent reason and message as context", async () => {
      const paths = defaultSignals();
      await writeAgentNeedsApproval(paths, "builder", "Task X needs human review");

      const content = JSON.parse(readFileSync(paths.needsApproval, "utf-8"));
      expect(content.reason).toBe("agent_needs_approval");
      expect(content.agent).toBe("builder");
      expect(content.message).toBe("Task X needs human review");
      expect(content.context).toBe("Task X needs human review");
    });

    it("writes null context when no message provided", async () => {
      const paths = defaultSignals();
      await writeAgentNeedsApproval(paths, "builder");

      const content = JSON.parse(readFileSync(paths.needsApproval, "utf-8"));
      expect(content.reason).toBe("agent_needs_approval");
      expect(content.context).toBeNull();
      expect(content.message).toBe("Agent requested approval");
    });

    it("treats empty string message as provided", async () => {
      const paths = defaultSignals();
      await writeAgentNeedsApproval(paths, "builder", "");

      const content = JSON.parse(readFileSync(paths.needsApproval, "utf-8"));
      expect(content.context).toBe("");
      expect(content.message).toBe("");
    });
  });

  describe("writeFailed with agent_failed reason", () => {
    it("writes failed signal with agent_failed reason", async () => {
      const paths = defaultSignals();
      await writeFailed(
        paths,
        "builder",
        "agent_failed",
        "Dependency missing",
        "Dependency missing",
      );

      const content = JSON.parse(readFileSync(paths.failed, "utf-8"));
      expect(content.reason).toBe("agent_failed");
      expect(content.agent).toBe("builder");
      expect(content.message).toBe("Dependency missing");
      expect(content.context).toBe("Dependency missing");
    });

    it("still accepts error reason (no regression)", async () => {
      const paths = defaultSignals();
      await writeFailed(paths, "builder", "error", "API error");

      const content = JSON.parse(readFileSync(paths.failed, "utf-8"));
      expect(content.reason).toBe("error");
    });
  });

  describe("signal file location", () => {
    it("writes all signal files to cwd", async () => {
      const paths = defaultSignals();
      await writeComplete(paths);
      await writeNeedsApproval(paths, "agent", 1000, 500, 600, null);
      await writeFailed(paths, "agent", "error", "fail");

      expect(existsSync(join(tempDir, ".vesper-complete"))).toBe(true);
      expect(existsSync(join(tempDir, ".vesper-needs-approval"))).toBe(true);
      expect(existsSync(join(tempDir, ".vesper-failed"))).toBe(true);
    });
  });
});
