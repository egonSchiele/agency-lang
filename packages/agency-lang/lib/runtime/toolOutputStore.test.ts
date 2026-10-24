import { describe, expect, it } from "vitest";
import { inFrameOf, makeMockCtx } from "./__tests__/testHelpers.js";
import type { Run } from "./asyncContext.js";
import {
  DEFAULT_READERS,
  MAX_STORE_CHARS,
  findOutput,
  isOutputName,
  missingOutputMessage,
  outputNotice,
  spillReaders,
  storeOutput,
} from "./toolOutputStore.js";

function withRun<T>(fn: (run: Run) => T): T {
  const ctx = makeMockCtx();
  return inFrameOf(ctx, ctx.stateStack, fn);
}

describe("toolOutputStore", () => {
  it("stores text under a fresh name and finds it again", () => {
    withRun((run) => {
      const name = storeOutput(run, "one\ntwo\nthree\n");
      expect(isOutputName(name)).toBe(true);
      expect(findOutput(run, name)).toBe("one\ntwo\nthree\n");
    });
  });

  it("gives two outputs two names", () => {
    withRun((run) => {
      const first = storeOutput(run, "a");
      const second = storeOutput(run, "b");
      expect(first).not.toBe(second);
      expect(findOutput(run, first)).toBe("a");
      expect(findOutput(run, second)).toBe("b");
    });
  });

  it("evicts the oldest entries when the cap is reached", () => {
    withRun((run) => {
      const third = Math.ceil(MAX_STORE_CHARS / 3) + 1;
      const first = storeOutput(run, "a".repeat(third));
      const second = storeOutput(run, "b".repeat(third));
      const fourth = storeOutput(run, "c".repeat(third));
      expect(findOutput(run, first)).toBeNull();
      expect(findOutput(run, second)).toHaveLength(third);
      expect(findOutput(run, fourth)).toHaveLength(third);
    });
  });

  it("keeps one entry larger than the whole cap, alone", () => {
    withRun((run) => {
      const small = storeOutput(run, "small");
      const huge = storeOutput(run, "h".repeat(MAX_STORE_CHARS + 10));
      expect(findOutput(run, small)).toBeNull();
      expect(findOutput(run, huge)).toHaveLength(MAX_STORE_CHARS + 10);
    });
  });

  it("refuses a name that is not a saved output name", () => {
    withRun((run) => {
      for (const bad of ["../x.log", "/etc/passwd", ".hidden.log", "notes.txt", "a/b.log"]) {
        expect(findOutput(run, bad)).toBeNull();
        expect(missingOutputMessage(bad)).toContain("is not a saved output name");
      }
      expect(missingOutputMessage("2026-01-01T00-00-00-000Z-ffffff.log")).toContain(
        "no longer available",
      );
    });
  });

  it("writes a preview under 2000 characters that names the readers", () => {
    const text = "x".repeat(2500);
    const notice = outputNotice(text, "n.log", 0, DEFAULT_READERS);
    expect(notice.length).toBeLessThan(2000);
    expect(notice).toContain("Command exited with code 0");
    expect(notice).toContain("full output saved as n.log");
    expect(notice).toContain('readSpill(filename: "n.log")');
    expect(notice).toContain('grepSpill(pattern, filename: "n.log")');
  });

  it("leaves out the exit code for a tool result, and grepSpill when it was not offered", () => {
    const notice = outputNotice("line\n".repeat(600), "n.log", null, {
      read: "readSpill",
      grep: null,
    });
    expect(notice).not.toContain("exited with code");
    expect(notice).toContain('readSpill(filename: "n.log")');
    expect(notice).not.toContain("grepSpill");
    expect(notice).toContain("full output saved as n.log");
  });

  it("finds the readers by module and registered name, so a rename still counts", () => {
    const spill = "stdlib/spill.agency";
    const read = { name: "read_saved", module: spill, registeredName: "readSpill" };
    const grep = { name: "grepSpill", module: spill, registeredName: "grepSpill" };
    const lookalike = { name: "readSpill", module: "mine.agency", registeredName: "readSpill" };
    expect(spillReaders([read, grep])).toEqual({ read: "read_saved", grep: "grepSpill" });
    expect(spillReaders([read])).toEqual({ read: "read_saved", grep: null });
    expect(spillReaders([lookalike, grep])).toBeNull();
  });

  it("shows both ends without repeating a line", () => {
    const notice = outputNotice("first\nsecond", "n.log", null, DEFAULT_READERS);
    expect(notice).toContain("--- first 2 lines ---\nfirst\nsecond\n--- last 0 lines ---");
  });
});
