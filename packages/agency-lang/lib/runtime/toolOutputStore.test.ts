import { describe, expect, it } from "vitest";
import { inFrameOf, makeMockCtx } from "./__tests__/testHelpers.js";
import type { Run } from "./asyncContext.js";
import { GlobalStore } from "./state/globalStore.js";
import {
  MAX_STORE_CHARS,
  SPILL_SOURCE_CHARS,
  findOutput,
  findOutputSource,
  isOutputName,
  missingOutputMessage,
  outputNotice,
  tailNotice,
  storeOutput,
  spillPathParts,
  spillPathsIn,
  inSpillFolder,
  spillFolder,
} from "./toolOutputStore.js";
import { memoryHost } from "../host/memoryHost.js";

const NAME = "2026-11-13T04-05-06-123Z-a1b2c3.log";
/** A saved-output path as a notice gives it. */
const PATH = `/tmp/agency-spill-0/${NAME}`;

describe("saved-output paths", () => {
  it("spillPathParts takes a whole path ending in the folder and a saved name", () => {
    expect(spillPathParts(`/tmp/agency-spill-1000/${NAME}`)).toEqual({
      folder: "/tmp/agency-spill-1000/",
      name: NAME,
    });
    expect(spillPathParts(`/var/folders/ab/T/agency-spill-501/${NAME}`)).toEqual({
      folder: "/var/folders/ab/T/agency-spill-501/",
      name: NAME,
    });
    expect(spillPathParts(`/tmp/agency-spill-1000/${NAME}/../../etc/passwd`)).toBeNull();
    expect(spillPathParts(`/tmp/agency-spill-1000/notes.txt`)).toBeNull();
    expect(spillPathParts(`/tmp/agency-spill-x/${NAME}`)).toBeNull();
    expect(spillPathParts(`/tmp/other/${NAME}`)).toBeNull();
    expect(spillPathParts(NAME)).toBeNull();
  });

  it("inSpillFolder is true for the folder and anything below it", () => {
    expect(inSpillFolder("/tmp/agency-spill-1000")).toBe(true);
    expect(inSpillFolder("/tmp/agency-spill-1000/")).toBe(true);
    expect(inSpillFolder("/tmp/agency-spill-1000/notes.txt")).toBe(true);
    expect(inSpillFolder("/private/var/folders/T/agency-spill-501/x.log")).toBe(true);
    expect(inSpillFolder("/tmp/agency-spill-notes/x")).toBe(false);
    expect(inSpillFolder("/home/me/project/a.txt")).toBe(false);
  });

  it("spillPathsIn finds whole paths in raw text and nothing longer", () => {
    const path = `/tmp/agency-spill-1000/${NAME}`;
    expect(spillPathsIn(`wc -l ${path} | head; cat "${path}"`)).toEqual([
      { folder: "/tmp/agency-spill-1000/", name: NAME },
      { folder: "/tmp/agency-spill-1000/", name: NAME },
    ]);
    expect(spillPathsIn(`cat ${path}.bak`)).toEqual([]);
    expect(spillPathsIn(`cat ${path}/x`)).toEqual([]);
    expect(spillPathsIn("echo hi")).toEqual([]);
  });

  it("spillPathsIn takes linear time on a long token", () => {
    const start = performance.now();
    expect(spillPathsIn(`echo ${"A".repeat(100_000)}`)).toEqual([]);
    const long = `/${"A".repeat(100_000)}/agency-spill-1/`;
    expect(spillPathsIn(`echo ${"A".repeat(100_000)}agency-spill-1x ${long}${NAME}`)).toEqual([
      { folder: long, name: NAME },
    ]);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("spillFolder is the temp folder as given, the prefix, and the user id", () => {
    expect(spillFolder(memoryHost())).toBe("/tmp/agency-spill-0/");
  });
});

function withRun<T>(fn: (run: Run) => T): T {
  const ctx = makeMockCtx();
  return inFrameOf(ctx, ctx.stateStack, fn);
}

describe("toolOutputStore", () => {
  it("keeps a readable source beside the text", () => {
    withRun((run) => {
      const name = storeOutput(run, "x".repeat(10), "pnpm run typecheck");
      expect(findOutputSource(run, name)).toBe("pnpm run typecheck");
      expect(findOutputSource(run, "2026-01-01T00-00-00-000Z-abcdef.log")).toBeNull();
      const long = storeOutput(run, "y", "z".repeat(200));
      expect(findOutputSource(run, long)).toBe("z".repeat(SPILL_SOURCE_CHARS));
    });
  });

  it("reads an entry saved without a source as having none", () => {
    withRun((run) => {
      const name = storeOutput(run, "x", "cmd");
      // No public call writes an entry without a source; this is the shape a
      // checkpoint taken before the field existed carries.
      const store = run.globals.get(GlobalStore.INTERNAL_MODULE, "__toolOutput") as {
        entries: { source?: string }[];
      };
      delete store.entries[0].source;
      expect(findOutputSource(run, name)).toBeNull();
      expect(findOutput(run, name)).toBe("x");
    });
  });

  it("treats an empty source as none, in the store and in the notice", () => {
    withRun((run) => {
      expect(findOutputSource(run, storeOutput(run, "x", ""))).toBeNull();
    });
    const notice = outputNotice("a\n".repeat(2000), PATH, 1, Infinity, "");
    expect(notice.startsWith("[Output too long to return in full:")).toBe(true);
  });

  it("names the source in the notice", () => {
    const notice = outputNotice("a\n".repeat(2000), PATH, 1, Infinity, "pnpm test");
    expect(notice.startsWith('[Output of "pnpm test" too long to return in full:')).toBe(true);
  });

  it("gives the same text the name it already has, and keeps one copy", () => {
    withRun((run) => {
      const big = "b".repeat(MAX_STORE_CHARS * 0.6);
      const first = storeOutput(run, big, "make");
      const again = storeOutput(run, big, "cat it");
      expect(again).toBe(first);
      expect(findOutput(run, first)).toBe(big);
    });
  });

  it("stores text under a fresh name and finds it again", () => {
    withRun((run) => {
      const name = storeOutput(run, "one\ntwo\nthree\n", "cmd");
      expect(isOutputName(name)).toBe(true);
      expect(findOutput(run, name)).toBe("one\ntwo\nthree\n");
    });
  });

  it("gives two outputs two names", () => {
    withRun((run) => {
      const first = storeOutput(run, "a", "cmd");
      const second = storeOutput(run, "b", "cmd");
      expect(first).not.toBe(second);
      expect(findOutput(run, first)).toBe("a");
      expect(findOutput(run, second)).toBe("b");
    });
  });

  it("evicts the oldest entries when the cap is reached", () => {
    withRun((run) => {
      const third = Math.ceil(MAX_STORE_CHARS / 3) + 1;
      const first = storeOutput(run, "a".repeat(third), "cmd");
      const second = storeOutput(run, "b".repeat(third), "cmd");
      const fourth = storeOutput(run, "c".repeat(third), "cmd");
      expect(findOutput(run, first)).toBeNull();
      expect(findOutput(run, second)).toHaveLength(third);
      expect(findOutput(run, fourth)).toHaveLength(third);
    });
  });

  it("keeps one entry larger than the whole cap, alone", () => {
    withRun((run) => {
      const small = storeOutput(run, "small", "cmd");
      const huge = storeOutput(run, "h".repeat(MAX_STORE_CHARS + 10), "cmd");
      expect(findOutput(run, small)).toBeNull();
      expect(findOutput(run, huge)).toHaveLength(MAX_STORE_CHARS + 10);
    });
  });

  it("refuses a name that is not a saved output name", () => {
    withRun((run) => {
      for (const bad of ["../x.log", "/etc/passwd", ".hidden.log", "notes.txt", "a/b.log"]) {
        expect(findOutput(run, bad)).toBeNull();
        expect(missingOutputMessage(bad)).toContain("is not a saved output");
      }
      expect(missingOutputMessage("2026-01-01T00-00-00-000Z-ffffff.log")).toContain(
        "no longer available",
      );
    });
  });

  it("writes a preview under 2000 characters that names the path and no tool", () => {
    const text = "x".repeat(2500);
    const notice = outputNotice(text, PATH, 0);
    expect(notice.length).toBeLessThan(2000);
    expect(notice).toContain("Command exited with code 0");
    // The path is followed by a space, so it is copied without punctuation.
    expect(notice).toContain(
      `--- full output saved as a file: ${PATH} (read it like any file) ---`,
    );
    expect(notice).not.toContain("readSpill");
    expect(notice).not.toContain("grepSpill");
  });

  it("leaves out the exit code for a tool result", () => {
    const notice = outputNotice("line\n".repeat(600), PATH, null);
    expect(notice).not.toContain("exited with code");
  });

  it("ends a command's last lines with the path and the exit code", () => {
    const text = "line\n".repeat(3000);
    const notice = tailNotice(text, PATH, 2, 10, 50_000);
    expect(
      notice.endsWith(
        `[Showing lines 2991-3000 of 3000. The full output is saved as a file: ${PATH} (read it like any file). Command exited with code 2.]`,
      ),
    ).toBe(true);
  });

  it("shows both ends without repeating a line", () => {
    const notice = outputNotice("first\nsecond", PATH, null);
    expect(notice).toContain("--- first 2 lines ---\nfirst\nsecond\n--- last 0 lines ---");
  });

  it("shrinks the preview to fit a limit, keeping the path", () => {
    const text = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join("\n");
    const full = outputNotice(text, PATH, null);
    const fitted = outputNotice(text, PATH, null, 600);
    expect(fitted.length).toBeLessThanOrEqual(600);
    expect(fitted).toContain(`saved as a file: ${PATH} `);
    const headCount = (notice: string) => Number(/--- first (\d+) lines ---/.exec(notice)![1]);
    expect(headCount(fitted)).toBeGreaterThan(0);
    expect(headCount(fitted)).toBeLessThan(headCount(full));
  });

  it("shows no preview when the text around it already fills the limit", () => {
    const text = "line\n".repeat(600);
    const notice = outputNotice(text, PATH, null, 200);
    expect(notice).toContain("--- first 0 lines ---\n\n--- last 0 lines ---");
  });
});
