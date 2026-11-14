import { describe, expect, it } from "vitest";
import { inFrameOf, makeMockCtx } from "../runtime/__tests__/testHelpers.js";
import type { Run } from "../runtime/asyncContext.js";
import { _grepSpill, _keepOutput, _readSpill, MAX_STDOUT_LEN } from "./spill.js";

const savedPath = (notice: string) => /saved as a file: (\S+) /.exec(notice)![1];

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

  it("saves long output and reads it back by the path or the name in the notice", () => {
    withRun(() => {
      const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
      expect(text.length).toBeLessThan(MAX_STDOUT_LEN);
      const notice = _keepOutput(text, 3, "make");
      // The last 2000 lines come back, then the notice.
      expect(notice.startsWith("line 1000\nline 1001\n")).toBe(true);
      expect(notice).toContain(
        "line 2999\n\n[Showing lines 1001-3000 of 3000. The full output is saved as a file: ",
      );
      expect(notice.endsWith("Command exited with code 3.]")).toBe(true);
      const path = savedPath(notice);
      const name = path.split("/").pop()!;
      expect(_readSpill(path, 0, 0)).toBe(text);
      expect(_readSpill(name, 0, 0)).toBe(text);
      expect(_readSpill(name, 2, 1)).toContain("line 1");
      expect(_grepSpill("line 490$", path, 10)).toHaveLength(1);
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

  it("cuts at the character limit too, and shows the end of one very long line", () => {
    withRun(() => {
      const wide = Array.from({ length: 100 }, (_, i) => `${i}:${"x".repeat(999)}`).join("\n");
      const cut = _keepOutput(wide, null, "cmd");
      expect(cut).toContain(
        "\n\n[Showing lines 52-100 of 100. The full output is saved as a file: ",
      );
      expect(cut).not.toContain("Command exited");
      const oneLine = _keepOutput(`${"a".repeat(MAX_STDOUT_LEN)}END`, null, "cmd");
      expect(oneLine).toContain(
        `END\n\n[Showing the last ${MAX_STDOUT_LEN} characters of line 1 of 1. The full output is saved as a file: `,
      );
      // A trailing newline is not a line of its own.
      const exact = `${Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n")}\n`;
      expect(_keepOutput(exact, 0, "cmd")).toBe(exact);
    });
  });

  it("searches several patterns in one call, grouping the matches by pattern", () => {
    withRun(() => {
      const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
      const name = savedPath(_keepOutput(text, 0, "cmd"))
        .split("/")
        .pop()!;
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
        expect(() => _readSpill(bad, 0, 0)).toThrow("not a saved output");
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
