import { describe, expect, it } from "vitest";
import { MAX_KEPT_LOG_WRITERS, newKeptLogWriters, writerForRun } from "./writers.js";

describe("writerForRun", () => {
  it("gives one run id the same writer every time", () => {
    const kept = newKeptLogWriters();
    expect(writerForRun(kept, "run-a")).toBe(writerForRun(kept, "run-a"));
  });

  it("keeps a writer for a run id named __proto__", () => {
    const kept = newKeptLogWriters();
    expect(writerForRun(kept, "__proto__")).toBe(writerForRun(kept, "__proto__"));
  });

  it("gives different run ids different writers", () => {
    const kept = newKeptLogWriters();
    expect(writerForRun(kept, "run-a").logWriter).not.toBe(writerForRun(kept, "run-b").logWriter);
  });

  it("drops the least recently used writer past the limit", () => {
    const kept = newKeptLogWriters();
    const runIds = Array.from({ length: MAX_KEPT_LOG_WRITERS }, (_unused, index) => `run-${index}`);
    const firstIds = runIds.map((runId) => writerForRun(kept, runId).logWriter);
    // Using run-0 again makes run-1 the least recently used.
    writerForRun(kept, "run-0");
    writerForRun(kept, "one-more");
    expect(writerForRun(kept, "run-1").logWriter).not.toBe(firstIds[1]);
    expect(writerForRun(kept, "run-0").logWriter).toBe(firstIds[0]);
  });
});
