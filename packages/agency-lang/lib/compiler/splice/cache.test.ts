import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../../utils.js";
import { cachedGeneratorRun, clearSpliceCache, spliceCacheKey } from "./cache.js";
import type { Code } from "../../runtime/template/code.js";
import type { SpliceResult } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = path.join(process.cwd(), ".agency-tmp", `splice-cache-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
  clearSpliceCache();
});

afterEach(() => {
  safeDeleteDirectory(dir, false);
  clearSpliceCache();
});

function write(name: string, source: string): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, source, "utf-8");
  return target;
}

const CODE: Code = { type: "agencyProgram", kind: "expr", nodes: [] };

/** A stand-in for the runner that counts how often it was asked to run. */
function counting(): { produce: () => SpliceResult<Code>; runs: () => number } {
  let runs = 0;
  return {
    produce: () => {
      runs += 1;
      return { ok: true, value: CODE };
    },
    runs: () => runs,
  };
}

describe("spliceCacheKey", () => {
  it("is stable when nothing changed", () => {
    const generator = write("gen.agency", `export def g(): number {\n  return 1\n}\n`);
    expect(spliceCacheKey("g()", generator)).toBe(spliceCacheKey("g()", generator));
  });

  it("changes when the splice expression changes", () => {
    const generator = write("gen.agency", `export def g(): number {\n  return 1\n}\n`);
    expect(spliceCacheKey("g(1)", generator)).not.toBe(spliceCacheKey("g(2)", generator));
  });

  it("changes when the generator's own content changes", () => {
    const generator = write("gen.agency", `export def g(): number {\n  return 1\n}\n`);
    const before = spliceCacheKey("g()", generator);
    write("gen.agency", `export def g(): number {\n  return 2\n}\n`);
    expect(spliceCacheKey("g()", generator)).not.toBe(before);
  });

  it("changes when a transitively imported helper changes", () => {
    // The reason the key hashes a closure rather than one file. A
    // generator that delegates its work is the normal case, not a corner.
    write("deep.agency", `export def d(): number {\n  return 1\n}\n`);
    write(
      "helper.agency",
      `import { d } from "./deep.agency"\n\nexport def h(): number {\n  return d()\n}\n`,
    );
    const generator = write(
      "gen.agency",
      `import { h } from "./helper.agency"\n\nexport def g(): number {\n  return h()\n}\n`,
    );
    const before = spliceCacheKey("g()", generator);
    write("deep.agency", `export def d(): number {\n  return 99\n}\n`);
    expect(spliceCacheKey("g()", generator)).not.toBe(before);
  });
});

describe("cachedGeneratorRun", () => {
  it("runs a generator once for repeated identical calls", () => {
    const { produce, runs } = counting();
    cachedGeneratorRun("k", produce);
    cachedGeneratorRun("k", produce);
    cachedGeneratorRun("k", produce);
    expect(runs()).toBe(1);
  });

  it("runs again under a different key", () => {
    const { produce, runs } = counting();
    cachedGeneratorRun("k1", produce);
    cachedGeneratorRun("k2", produce);
    expect(runs()).toBe(2);
  });

  it("caches a failure so a broken generator does not re-run per keystroke", () => {
    let runs = 0;
    const produce = (): SpliceResult<Code> => {
      runs += 1;
      return {
        ok: false,
        diagnostic: {
          diagnostic: "spliceGeneratorFailed",
          params: { name: "g", reason: "boom" },
          loc: { line: 1, col: 1, start: 0, end: 0 },
        },
      };
    };
    cachedGeneratorRun("broken", produce);
    cachedGeneratorRun("broken", produce);
    expect(runs).toBe(1);
  });
});
