import { describe, expect, it } from "vitest";
import { inFrameOf, makeMockCtx } from "../runtime/__tests__/testHelpers.js";
import type { Run } from "../runtime/asyncContext.js";
import { _grepSpill, _keepOutput, _readSpill, MAX_STDOUT_LEN } from "./spill.js";

function withRun<T>(fn: (run: Run) => T): T {
  const ctx = makeMockCtx();
  return inFrameOf(ctx, ctx.stateStack, fn);
}

describe("spill", () => {
  it("returns short output as printed", () => {
    withRun(() => {
      expect(_keepOutput("hello\n", 0, "echo hello")).toBe("hello\n");
      expect(_keepOutput("hello\n", 0)).toBe("hello\n");
    });
  });

  it("saves long output and reads it back by the name in the notice", () => {
    withRun(() => {
      const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
      expect(text.length).toBeGreaterThan(MAX_STDOUT_LEN);
      const notice = _keepOutput(text, 3, "make");
      expect(notice).toContain("Command exited with code 3");
      expect(notice.startsWith('[Output of "make" too long')).toBe(true);
      const name = /full output saved as (\S+) ---/.exec(notice)![1];
      expect(_readSpill(name, 0, 0)).toBe(text);
      expect(_readSpill(name, 2, 1)).toContain("line 1");
      expect(_grepSpill("line 49.$", name, 10)).toEqual([
        { file: name, line: 491, text: "line 490" },
        { file: name, line: 492, text: "line 491" },
        { file: name, line: 493, text: "line 492" },
        { file: name, line: 494, text: "line 493" },
        { file: name, line: 495, text: "line 494" },
        { file: name, line: 496, text: "line 495" },
        { file: name, line: 497, text: "line 496" },
        { file: name, line: 498, text: "line 497" },
        { file: name, line: 499, text: "line 498" },
        { file: name, line: 500, text: "line 499" },
      ]);
    });
  });

  it("searches several patterns in one call, grouping the matches by pattern", () => {
    withRun(() => {
      const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
      const name = /full output saved as (\S+) ---/.exec(_keepOutput(text, 0, "cmd"))![1];
      expect(_grepSpill("line 7$", name, 10, ["line 12$", "no such line"])).toEqual([
        { pattern: "line 7$", matches: [{ file: name, line: 8, text: "line 7" }] },
        { pattern: "line 12$", matches: [{ file: name, line: 13, text: "line 12" }] },
        { pattern: "no such line", matches: [] },
      ]);
    });
  });

  it("refuses a name that is not a saved output name", () => {
    withRun(() => {
      for (const bad of ["../x.log", "/etc/passwd", ".hidden.log", "notes.txt", "a/b.log"]) {
        expect(() => _readSpill(bad, 0, 0)).toThrow("not a saved output name");
      }
    });
  });

  it("says a name it never saved is no longer available", () => {
    withRun(() => {
      expect(() => _grepSpill("x", "2026-01-01T00-00-00-000Z-ffffff.log", 10)).toThrow(
        "no longer available",
      );
    });
  });
});
