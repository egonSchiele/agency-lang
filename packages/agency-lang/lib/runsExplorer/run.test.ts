import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KeyEvent } from "../tui/input/types.js";
import { ScriptedInput } from "../tui/input/scripted.js";
import { FrameRecorder } from "../tui/output/recorder.js";
import { runExplorer, type ExplorerOptions } from "./run.js";
import {
  resetFixtureClock, writeGradedRun, writeKilledRun, writeMultiTraceStatelog,
} from "./testFixtures.js";

const viewport = { rows: 24, cols: 120 };

function lastFrame(recorder: FrameRecorder): string {
  return recorder.frames.length === 0 ? "" : recorder.textAt(recorder.frames.length - 1);
}

function makeOptions(over: Partial<ExplorerOptions> & { sources: ExplorerOptions["sources"] }): {
  options: ExplorerOptions;
  input: ScriptedInput;
  recorder: FrameRecorder;
} {
  const input = new ScriptedInput();
  const recorder = new FrameRecorder();
  const options: ExplorerOptions = {
    route: "explorer",
    input,
    output: recorder,
    viewport,
    ...over,
  };
  return { options, input, recorder };
}

type Step = { when: (latestFrame: string) => boolean; key: string };

/** Run the explorer while a 1 ms poller feeds each scripted key as soon
 *  as its screen condition holds — the way a human would. */
async function drive(
  options: ExplorerOptions,
  input: ScriptedInput,
  recorder: FrameRecorder,
  steps: Step[],
): Promise<void> {
  let at = 0;
  const timer = setInterval(() => {
    if (at >= steps.length) {
      return;
    }
    if (steps[at].when(lastFrame(recorder))) {
      input.feedKey({ key: steps[at].key });
      at += 1;
    }
  }, 1);
  try {
    await runExplorer(options);
  } finally {
    clearInterval(timer);
  }
  expect(at).toBe(steps.length);
}

describe("runExplorer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-shell-"));
    resetFixtureClock();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("boots into loading, shows the table when rows land, and quits on q", async () => {
    const runDir = writeGradedRun(tmpDir);
    const { options, input, recorder } = makeOptions({ sources: [{ kind: "runDir", dir: runDir }] });

    await drive(options, input, recorder, [
      { when: (frame) => frame.includes("regex-log") && frame.includes("[runs]"), key: "q" },
    ]);

    const all = recorder.frames.map((_, i) => recorder.textAt(i)).join("\n===\n");
    expect(all).toContain("Loading runs…");
    expect(all).toContain("regex-log");
  });

  it("q interrupts a large backfill scan mid-load", async () => {
    const runDir = writeKilledRun(tmpDir);
    const statelog = path.join(runDir, "inputs", "t1", "agent", "statelog.jsonl");
    const bigEvent = JSON.stringify({ format_version: 1, trace_id: "big", data: { type: "note", pad: "x".repeat(512) } });
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      lines.push(bigEvent);
    }
    fs.appendFileSync(statelog, lines.join("\n") + "\n");

    const { options, input, recorder } = makeOptions({ sources: [{ kind: "runDir", dir: runDir }] });
    await drive(options, input, recorder, [
      // Quit while the row is visible but backfill still pending (…).
      { when: (frame) => frame.includes("…") && frame.includes("[runs]"), key: "q" },
    ]);
  });

  it("t cycles runs → compare → trend and Shift+T cycles back", async () => {
    const runDir = writeGradedRun(tmpDir);
    const { options, input, recorder } = makeOptions({ sources: [{ kind: "runDir", dir: runDir }] });

    await drive(options, input, recorder, [
      { when: (frame) => frame.includes("[runs]") && frame.includes("regex-log"), key: "t" },
      { when: (frame) => frame.includes("[compare]"), key: "t" },
      { when: (frame) => frame.includes("[trend]"), key: "T" },
      { when: (frame) => frame.includes("[compare]"), key: "T" },
      { when: (frame) => frame.includes("[runs]"), key: "q" },
    ]);
  });

  it("Enter drills into tests, Esc unwinds to runs, Esc at runs is inert", async () => {
    const runDir = writeGradedRun(tmpDir);
    const { options, input, recorder } = makeOptions({ sources: [{ kind: "runDir", dir: runDir }] });

    await drive(options, input, recorder, [
      { when: (frame) => frame.includes("[runs]") && frame.includes("regex-log"), key: "enter" },
      { when: (frame) => frame.includes("[pick test]"), key: "escape" },
      { when: (frame) => frame.includes("[runs]"), key: "escape" },
      { when: (frame) => frame.includes("[runs]"), key: "q" },
    ]);

    expect(lastFrame(recorder)).toContain("[runs]");
  });

  it("a single run dir route starts directly on the per-test table", async () => {
    const runDir = writeGradedRun(tmpDir);
    const { options, input, recorder } = makeOptions({
      sources: [{ kind: "runDir", dir: runDir }],
      route: "runTable",
    });

    await drive(options, input, recorder, [
      { when: (frame) => frame.includes("[pick test]") && frame.includes("t1"), key: "q" },
    ]);
  });

  it("hands the embedded viewer the terminal; back re-renders, quit exits", async () => {
    const runDir = writeGradedRun(tmpDir);
    const viewerCalls: string[] = [];
    const viewerKeys: KeyEvent[] = [];
    const { options, input, recorder } = makeOptions({
      sources: [{ kind: "runDir", dir: runDir }],
      runViewerFn: async (viewerOpts) => {
        viewerCalls.push(viewerOpts.followPath ?? "?");
        // The viewer must own the input while it runs: the key fed
        // below belongs to IT, not to a stale explorer waiter.
        viewerKeys.push(await viewerOpts.input.nextKey());
        return viewerCalls.length === 1 ? "back" : "quit";
      },
    });

    await drive(options, input, recorder, [
      { when: (frame) => frame.includes("[runs]") && frame.includes("regex-log"), key: "enter" },
      { when: (frame) => frame.includes("[pick test]"), key: "enter" },
      { when: () => viewerCalls.length === 1 && viewerKeys.length === 0, key: "x" },
      { when: (frame) => viewerCalls.length === 1 && frame.includes("[pick test]"), key: "enter" },
      { when: () => viewerCalls.length === 2 && viewerKeys.length === 1, key: "y" },
    ]);

    expect(viewerCalls).toHaveLength(2);
    expect(viewerCalls[0]).toContain("statelog.jsonl");
    expect(viewerKeys.map((key) => key.key)).toEqual(["x", "y"]);
  });

  it("multi-trace statelogs load as trace rows", async () => {
    const file = writeMultiTraceStatelog(tmpDir);
    const { options, input, recorder } = makeOptions({ sources: [{ kind: "statelog", file }] });

    await drive(options, input, recorder, [
      { when: (frame) => frame.includes("named-trace"), key: "q" },
    ]);
  });
});
