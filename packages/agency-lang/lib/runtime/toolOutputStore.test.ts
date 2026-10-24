import { describe, expect, it } from "vitest";
import { inFrameOf, makeMockCtx } from "./__tests__/testHelpers.js";
import type { Run } from "./asyncContext.js";
import {
  MAX_STORE_CHARS,
  findOutput,
  isOutputName,
  missingOutputMessage,
  outputNotice,
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
    const notice = outputNotice(text, "n.log", 0, true);
    expect(notice.length).toBeLessThan(2000);
    expect(notice).toContain("Command exited with code 0");
    expect(notice).toContain("full output saved as n.log");
    expect(notice).toContain('readSpill(filename: "n.log")');
    expect(notice).toContain('grepSpill(pattern, filename: "n.log")');
  });

  it("leaves out the exit code for a tool result, and the readers when the model has none", () => {
    const notice = outputNotice("line\n".repeat(600), "n.log", null, false);
    expect(notice).not.toContain("exited with code");
    expect(notice).not.toContain("readSpill(");
    expect(notice).toContain("no readSpill tool");
    expect(notice).toContain("full output saved as n.log");
  });

  it("shows both ends without repeating a line", () => {
    const notice = outputNotice("first\nsecond", "n.log", null, true);
    expect(notice).toContain("--- first 2 lines ---\nfirst\nsecond\n--- last 0 lines ---");
  });
});
