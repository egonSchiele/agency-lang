import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterAll, describe, expect, it } from "vitest";

import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { _logToRead } from "./statelogReaders.js";

// A run with a log file opens it, so the file goes in a temp directory.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statelog-readers-"));
const OWN = path.join(dir, "own.jsonl");
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** `_logToRead(log)` inside a run with this log config. */
async function inRun(
  config: { observability: boolean; logFile?: string },
  log: string,
): Promise<string> {
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, ...config },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  let found = "";
  await runInTestContext(ctx, new StateStack(), threads, async () => {
    found = _logToRead(log);
  });
  return found;
}

describe("_logToRead", () => {
  it("returns a named log as it is", async () => {
    expect(_logToRead("x.jsonl")).toBe("x.jsonl");
    expect(await inRun({ observability: true, logFile: OWN }, "x.jsonl")).toBe("x.jsonl");
  });

  it("reads an empty log as the run's own log file", async () => {
    expect(await inRun({ observability: true, logFile: OWN }, "")).toBe(OWN);
  });

  it("refuses an empty log outside a run, or in a run with no log file", async () => {
    const message = "This run has no log file. Pass a log path, or set log.logFile.";
    expect(() => _logToRead("")).toThrow(message);
    await expect(inRun({ observability: true }, "")).rejects.toThrow(message);
  });

  it("refuses an empty log when the run is not writing its log", async () => {
    await expect(inRun({ observability: false, logFile: OWN }, "")).rejects.toThrow(
      "This run is not writing its log: observability is off. Pass a log path.",
    );
  });
});
