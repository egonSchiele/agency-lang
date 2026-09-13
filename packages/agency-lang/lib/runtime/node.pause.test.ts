import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { pathToFileURL } from "url";
import * as fs from "node:fs";
import * as path from "node:path";
import { compile, resetCompilationCache } from "@/compiler/defaultSession.js";
import { safeDeleteDirectoryWithin } from "@/utils.js";
import { isPaused } from "./pause.js";

describe("a generated node export accepts pauseSignal and abortSignal", () => {
  const fixturesRoot = path.resolve(__dirname, "../../.agency-tmp/node-pause");
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

  it("returns a PausedCheckpoint in data when the signal is already aborted", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const ctl = new AbortController();
    ctl.abort();
    const result = await mod.main({ pauseSignal: ctl.signal });
    expect(isPaused(result.data)).toBe(true);
    expect(result.data.runId.length).toBeGreaterThan(0);
    expect(result.data.checkpoint.nodeId).toBe("main");
  });

  it("resumes a paused run to the value an unpaused run returns", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const ctl = new AbortController();
    ctl.abort();
    const paused = await mod.main({ pauseSignal: ctl.signal });
    const resumed = await mod.resumeFromCheckpoint(paused.data);
    expect(resumed.data).toBe(2);
  });

  it("throws AgencyCancelledError, not a paused result, when both signals are already aborted", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const cancel = new AbortController();
    const pause = new AbortController();
    cancel.abort();
    pause.abort();
    await expect(
      mod.main({ pauseSignal: pause.signal, abortSignal: cancel.signal }),
    ).rejects.toThrow(/cancelled/);
  });

  it("detaches its listeners when the run finishes", async () => {
    const mod = await import(pathToFileURL(mainJs).href);
    const pause = new AbortController();
    const cancel = new AbortController();
    const removePause = vi.spyOn(pause.signal, "removeEventListener");
    const removeCancel = vi.spyOn(cancel.signal, "removeEventListener");
    const result = await mod.main({ pauseSignal: pause.signal, abortSignal: cancel.signal });
    expect(result.data).toBe(2);
    expect(removePause).toHaveBeenCalledTimes(1);
    expect(removeCancel).toHaveBeenCalledTimes(1);
  });
});
