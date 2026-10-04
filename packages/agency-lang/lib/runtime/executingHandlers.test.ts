import { describe, it as baseIt, expect } from "vitest";
import { runAsHandler, executingHandlers, insideHandlerFunction } from "./executingHandlers.js";
import type { HandlerEntry } from "./types.js";
import { testRun, withTestFrame } from "./__tests__/testHelpers.js";

// These tests call runtime functions that keep a value on the frame.
const it = withTestFrame(baseIt);

const entryA: HandlerEntry = { fn: async () => undefined, liveGuardIds: [] };
const entryB: HandlerEntry = { fn: async () => undefined, liveGuardIds: [] };

describe("executing handlers", () => {
  it("is empty outside any handler", () => {
    expect(executingHandlers(testRun())).toEqual([]);
    expect(insideHandlerFunction(testRun())).toBe(false);
  });

  it("records the executing entry", async () => {
    await runAsHandler(testRun(), entryA, async () => {
      expect(executingHandlers(testRun())).toEqual([entryA]);
      expect(insideHandlerFunction(testRun())).toBe(true);
    });
  });

  it("unwinds when the body finishes", async () => {
    await runAsHandler(testRun(), entryA, async () => {});
    expect(executingHandlers(testRun())).toEqual([]);
  });

  it("unwinds when the body throws", async () => {
    await expect(
      runAsHandler(testRun(), entryA, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(executingHandlers(testRun())).toEqual([]);
  });

  it("stacks nested handler executions innermost-last", async () => {
    await runAsHandler(testRun(), entryA, async () => {
      await runAsHandler(testRun(), entryB, async () => {
        expect(executingHandlers(testRun())).toEqual([entryA, entryB]);
      });
      expect(executingHandlers(testRun())).toEqual([entryA]);
    });
  });

  // The safety-critical one. Fork branches share the handler chain, so
  // branch B's raise reaches branch A's handler. If A's executing state
  // leaked into B's lineage, B's raises would silently skip A's handler
  // — a handler being skipped for interrupts it must hear.
  it("does not leak across concurrent lineages", async () => {
    let seenInB: HandlerEntry[] = [];
    await Promise.all([
      runAsHandler(testRun(), entryA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seenInB = executingHandlers(testRun());
      })(),
    ]);
    expect(seenInB).toEqual([]);
  });
});
