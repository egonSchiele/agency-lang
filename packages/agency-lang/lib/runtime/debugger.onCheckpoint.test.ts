import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pathToFileURL } from "url";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, resetCompilationCache } from "@/compiler/defaultSession.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";
import { isPaused } from "./pause.js";
import { Checkpoint } from "./state/checkpointStore.js";
import type { CallbackMap } from "./hooks.js";

type Seen = CallbackMap["onCheckpoint"];

describe("onCheckpoint fires once per statement checkpoint", () => {
  const fixturesRoot = path.resolve(__dirname, "../../.agency-tmp/on-checkpoint");
  const mainAgency = path.join(fixturesRoot, "main.agency");
  const mainJs = mainAgency.replace(/\.agency$/, ".js");

  beforeAll(() => {
    fs.mkdirSync(fixturesRoot, { recursive: true });
    fs.writeFileSync(
      mainAgency,
      "node main(): number {\n" +
        "  let total = 0\n" +
        "  total = total + 1\n" +
        "  total = total + 1\n" +
        "  return total\n" +
        "}\n",
    );
    resetCompilationCache();
    compile({}, mainAgency);
  });

  afterAll(() => {
    safeDeleteDirectoryWithin(path.resolve(__dirname, "../.."), fixturesRoot);
  });

  it("reports a resumable checkpoint for every statement of a fresh run", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const seen: Seen[] = [];
    const result = await mod.main({ callbacks: { onCheckpoint: (e: Seen) => seen.push(e) } });
    expect(result.data).toBe(2);
    // Four statements, so at least four checkpoints. The exact count is the
    // runner's business, not this test's.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    const runId = seen[0].runId;
    expect(runId.length).toBeGreaterThan(0);
    for (const event of seen) {
      expect(event.runId).toBe(runId);
      expect(Checkpoint.fromJSON(event.checkpoint)).not.toBeNull();
      expect(isPaused({ type: "paused", checkpoint: event.checkpoint, runId: event.runId })).toBe(
        true,
      );
    }
  });

  it("resumes from the last checkpoint it reported to the value a plain run returns", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const seen: Seen[] = [];
    await mod.main({ callbacks: { onCheckpoint: (e: Seen) => seen.push(e) } });
    const last = seen[seen.length - 1];
    // Store and reload as JSON the way a host would.
    const stored = JSON.parse(JSON.stringify(last.checkpoint));
    const resumed = await mod.resumeFromCheckpoint({
      type: "paused",
      checkpoint: stored,
      runId: last.runId,
    });
    expect(resumed.data).toBe(2);
  });

  it("keeps reporting on a resume leg when the callback is passed in metadata", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const pause = new AbortController();
    pause.abort();
    const paused = await mod.main({ pauseSignal: pause.signal });
    expect(isPaused(paused.data)).toBe(true);
    const seen: Seen[] = [];
    const resumed = await mod.resumeFromCheckpoint(paused.data, {
      metadata: { callbacks: { onCheckpoint: (e: Seen) => seen.push(e) } },
    });
    expect(resumed.data).toBe(2);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.every((e) => e.runId === paused.data.runId)).toBe(true);
  });

  it("does nothing when nobody listens", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const result = await mod.main({});
    expect(result.data).toBe(2);
  });
});
