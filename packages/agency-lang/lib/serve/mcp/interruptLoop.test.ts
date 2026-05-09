import { describe, it, expect } from "vitest";
import { runWithPolicy } from "./interruptLoop.js";
import { PolicyStore } from "../policyStore.js";
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";

function makeTmpStore(policy: Record<string, any> = {}): { store: PolicyStore; cleanup: () => void } {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "interrupt-loop-test-"));
  const store = new PolicyStore("test", tmpDir);
  if (Object.keys(policy).length > 0) store.set(policy);
  return { store, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

function makeInterrupt(kind: string, data: Record<string, any> = {}): any {
  return { type: "interrupt", kind, message: "", data, origin: "test", interruptId: "test-id", runId: "test-run" };
}

const isInterrupts = (data: unknown) =>
  Array.isArray(data) && data.length > 0 && data[0]?.type === "interrupt";

describe("runWithPolicy", () => {
  it("returns result directly when no interrupts", async () => {
    const { store, cleanup } = makeTmpStore();
    try {
      const result = await runWithPolicy(
        async () => "hello",
        store,
        { hasInterrupts: isInterrupts, respondToInterrupts: async () => "done" },
      );
      expect(result).toBe("hello");
    } finally {
      cleanup();
    }
  });

  it("approves interrupts that match the policy", async () => {
    const { store, cleanup } = makeTmpStore({
      "test::greet": [{ action: "approve" }],
    });
    try {
      let callCount = 0;
      const result = await runWithPolicy(
        async () => [makeInterrupt("test::greet")],
        store,
        {
          hasInterrupts: isInterrupts,
          respondToInterrupts: async (_interrupts, responses) => {
            callCount++;
            expect(responses).toHaveLength(1);
            expect((responses[0] as any).type).toBe("approve");
            return "approved-result";
          },
        },
      );
      expect(result).toBe("approved-result");
      expect(callCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("rejects interrupts not covered by policy (default reject)", async () => {
    const { store, cleanup } = makeTmpStore(); // empty policy
    try {
      const result = await runWithPolicy(
        async () => [makeInterrupt("test::greet")],
        store,
        {
          hasInterrupts: isInterrupts,
          respondToInterrupts: async (_interrupts, responses) => {
            expect((responses[0] as any).type).toBe("reject");
            return "rejected-result";
          },
        },
      );
      expect(result).toBe("rejected-result");
    } finally {
      cleanup();
    }
  });

  it("handles multiple rounds of interrupts", async () => {
    const { store, cleanup } = makeTmpStore({
      "test::step1": [{ action: "approve" }],
      "test::step2": [{ action: "approve" }],
    });
    try {
      let round = 0;
      const result = await runWithPolicy(
        async () => [makeInterrupt("test::step1")],
        store,
        {
          hasInterrupts: isInterrupts,
          respondToInterrupts: async () => {
            round++;
            if (round === 1) {
              return [makeInterrupt("test::step2")];
            }
            return "final";
          },
        },
      );
      expect(result).toBe("final");
      expect(round).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("propagates errors from respondToInterrupts", async () => {
    const { store, cleanup } = makeTmpStore({
      "test::x": [{ action: "approve" }],
    });
    try {
      await expect(
        runWithPolicy(
          async () => [makeInterrupt("test::x")],
          store,
          {
            hasInterrupts: isInterrupts,
            respondToInterrupts: async () => { throw new Error("agent crashed"); },
          },
        ),
      ).rejects.toThrow("agent crashed");
    } finally {
      cleanup();
    }
  });

  it("approves some and rejects others in a mixed batch", async () => {
    const { store, cleanup } = makeTmpStore({
      "test::allowed": [{ action: "approve" }],
      // test::blocked has no rules → defaults to reject
    });
    try {
      const result = await runWithPolicy(
        async () => [makeInterrupt("test::allowed"), makeInterrupt("test::blocked")],
        store,
        {
          hasInterrupts: isInterrupts,
          respondToInterrupts: async (_interrupts, responses) => {
            expect((responses[0] as any).type).toBe("approve");
            expect((responses[1] as any).type).toBe("reject");
            return "mixed-result";
          },
        },
      );
      expect(result).toBe("mixed-result");
    } finally {
      cleanup();
    }
  });
});
