import type { spawnSync } from "node:child_process";
import * as fs from "fs";
import { describe, expect, it } from "vitest";

import {
  editorCommand,
  openInEditor,
  withTerminalReleased,
  type ReleasableTerminal,
} from "./editor.js";

const EDITOR = { command: "fake-editor", args: ["--wait"] };

function recordingTerminal(calls: string[]): ReleasableTerminal {
  return {
    input: { release: () => calls.push("release"), reclaim: () => calls.push("reclaim") },
    output: { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") },
  };
}

type FakeSpawn = typeof spawnSync;
type SpawnResult = ReturnType<typeof spawnSync>;

/** A stand-in editor that appends a line to the file it was given. */
function appendingEditor(calls: string[], status = 0): FakeSpawn {
  const fake = (command: string, args: string[]): SpawnResult => {
    calls.push(`spawn ${command} ${args.slice(0, -1).join(" ")}`);
    const file = args[args.length - 1];
    fs.appendFileSync(file, "\nadded by the editor");
    return { status, error: undefined } as unknown as SpawnResult;
  };
  return fake as unknown as FakeSpawn;
}

describe("editorCommand", () => {
  it("reads $EDITOR and splits flags off", () => {
    expect(editorCommand({})).toBeNull();
    expect(editorCommand({ EDITOR: "  " })).toBeNull();
    expect(editorCommand({ EDITOR: "vim" })).toEqual({ command: "vim", args: [] });
    expect(editorCommand({ EDITOR: "code --wait" })).toEqual({ command: "code", args: ["--wait"] });
  });
});

describe("withTerminalReleased", () => {
  it("hands the terminal over, runs, and takes it back even when the work throws", () => {
    const calls: string[] = [];
    const terminal = recordingTerminal(calls);
    expect(withTerminalReleased(terminal, () => "done")).toBe("done");
    expect(calls).toEqual(["suspend", "release", "reclaim", "resume"]);

    calls.length = 0;
    expect(() =>
      withTerminalReleased(terminal, () => {
        throw new Error("editor missing");
      }),
    ).toThrow("editor missing");
    expect(calls).toEqual(["suspend", "release", "reclaim", "resume"]);
  });
});

describe("openInEditor", () => {
  it("returns the saved text, with the terminal released around the editor", () => {
    const calls: string[] = [];
    const text = openInEditor(
      "first line",
      EDITOR,
      recordingTerminal(calls),
      appendingEditor(calls),
    );
    expect(text).toBe("first line\nadded by the editor");
    expect(calls).toEqual(["suspend", "release", "spawn fake-editor --wait", "reclaim", "resume"]);
  });

  it("returns null when the editor exits non-zero", () => {
    const calls: string[] = [];
    const text = openInEditor("kept", EDITOR, recordingTerminal(calls), appendingEditor(calls, 1));
    expect(text).toBeNull();
    expect(calls.at(-1)).toBe("resume");
  });

  it("throws when the editor cannot be started", () => {
    const missing = (() => ({
      status: null,
      error: new Error("spawn fake-editor ENOENT"),
    })) as unknown as FakeSpawn;
    expect(() => openInEditor("x", EDITOR, recordingTerminal([]), missing)).toThrow(/ENOENT/);
  });
});
