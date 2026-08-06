import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { AgencyConfig } from "../config.js";

// Hoisted seam: exercises the classifier's actual CATCH path (a missing
// file never reaches it — parseAgencyFileCached converts that to a failed
// result), and records the applyTemplate policy per walked file. A dynamic
// vi.spyOn after import would not reach the static production binding.
const seam = vi.hoisted(() => ({
  throwNext: null as Error | null,
  calls: [] as Array<[string, boolean]>, // [absPath, applyTemplate]
}));
vi.mock("../parseCache.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../parseCache.js")>();
  return {
    ...real,
    parseAgencyFileCached: (p: string, c?: AgencyConfig, t?: boolean) => {
      seam.calls.push([p, t ?? true]);
      if (seam.throwNext) {
        const e = seam.throwNext;
        seam.throwNext = null;
        throw e;
      }
      return real.parseAgencyFileCached(p, c, t);
    },
  };
});

import { dependencyFingerprint } from "./depFingerprint.js";
import { getStdlibDir } from "../importPaths.js";

const createdTrees: string[] = [];

beforeEach(() => {
  seam.throwNext = null;
  seam.calls.length = 0;
});

afterEach(() => {
  for (const dir of createdTrees.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-fp-"));
  createdTrees.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

describe("dependencyFingerprint", () => {
  test("transitive relative deps: sorted, unique, root excluded", () => {
    const dir = tree({
      "a.agency": `import { b } from "./b.agency"\nimport { c } from "./c.agency"\n`,
      "b.agency": `import { c } from "./c.agency"\nexport def b(): number { return 1 }\n`,
      "c.agency": `export def c(): number { return 2 }\n`,
    });
    expect(
      dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false }),
    ).toMatchObject({
      deps: [path.join(dir, "b.agency"), path.join(dir, "c.agency")].sort(),
      hasPkgImports: false,
      cacheable: true,
    });
  });

  test("cycles terminate; deps exclude the root", () => {
    const dir = tree({
      "a.agency": `import { b } from "./b.agency"\n`,
      "b.agency": `import { a } from "./a.agency"\n`,
    });
    expect(
      dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false }).deps,
    ).toEqual([path.join(dir, "b.agency")]);
  });

  test("node-import edges are discovered", () => {
    const dir = tree({
      "a.agency": `import node { main } from "./b.agency"\n`,
      "b.agency": `node main() { return 1 }\n`,
    });
    expect(
      dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false }).deps,
    ).toEqual([path.join(dir, "b.agency")]);
  });

  test("missing direct target: included in deps, cacheable false", () => {
    const dir = tree({ "a.agency": `import { b } from "./gone.agency"\n` });
    const fp = dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false });
    expect(fp.deps).toEqual([path.join(dir, "gone.agency")]);
    expect(fp.cacheable).toBe(false);
  });

  test("unparseable reachable module: walk continues, cacheable false", () => {
    const dir = tree({
      "a.agency": `import { b } from "./bad.agency"\nimport { c } from "./c.agency"\n`,
      "bad.agency": `def {{{{ nope`,
      "c.agency": `export def c(): number { return 2 }\n`,
    });
    const fp = dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false });
    expect(fp.cacheable).toBe(false);
    expect(fp.deps).toContain(path.join(dir, "c.agency"));
  });

  test("splice in root / in transitive dep ⇒ cacheable false", () => {
    const d1 = tree({ "a.agency": `const x = $( codegen() )\n` });
    expect(
      dependencyFingerprint(path.join(d1, "a.agency"), {}, { resolveStdlib: false }).cacheable,
    ).toBe(false);
    const d2 = tree({
      "a.agency": `import { b } from "./b.agency"\n`,
      "b.agency": `const x = $( codegen() )\n`,
    });
    expect(
      dependencyFingerprint(path.join(d2, "a.agency"), {}, { resolveStdlib: false }).cacheable,
    ).toBe(false);
  });

  test("pkg:: detected through all three edge forms, incl. transitive", () => {
    for (const form of [
      `import { x } from "pkg::toolbox"\n`,
      `import node { main } from "pkg::toolbox"\n`,
      `export { x } from "pkg::toolbox"\n`,
    ]) {
      const dir = tree({
        "a.agency": `import { b } from "./b.agency"\n`,
        "b.agency": form,
      });
      expect(
        dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false })
          .hasPkgImports,
      ).toBe(true);
    }
  });

  test("resolveStdlib false omits every std:: path", () => {
    const dir = tree({ "a.agency": `import { getAgentCwd } from "std::index"\n` });
    const fp = dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false });
    expect(fp.deps).toEqual([]);
    expect(fp.cacheable).toBe(true);
  });

  test("resolveStdlib true follows into the real stdlib (prelude edge)", () => {
    const dir = tree({ "a.agency": `import { join } from "std::path"\n` });
    const fp = dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: true });
    expect(fp.deps).toContain(path.join(getStdlibDir(), "path.agency"));
    // path.agency is templated ⇒ its prelude edge pulls in index.agency.
    expect(fp.deps).toContain(path.join(getStdlibDir(), "index.agency"));
  });
});

describe("dependencyFingerprint failure contract", () => {
  // The TEST'S oracle, independent of the production classifier: if
  // production drops a code, its row stays here and fails.
  const EXPECTED_DISCOVERY_FS_CODES = [
    "ENOENT", "EACCES", "EPERM", "EIO", "EBUSY", "EMFILE", "ENFILE", "EISDIR",
    "ENOTDIR", "ELOOP", "ESTALE",
  ] as const;

  test.each(EXPECTED_DISCOVERY_FS_CODES)("thrown %s is absorbed ⇒ cacheable false", (code) => {
    const dir = tree({ "a.agency": `` });
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    seam.throwNext = e;
    const fp = dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false });
    expect(fp.cacheable).toBe(false);
  });

  test("TypeError propagates", () => {
    const dir = tree({ "a.agency": `` });
    seam.throwNext = new TypeError("bug");
    expect(() =>
      dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false }),
    ).toThrow(TypeError);
  });

  test("string code alone is not enough: ERR_INVALID_ARG_TYPE propagates", () => {
    const dir = tree({ "a.agency": `` });
    const e = new TypeError("bad arg") as NodeJS.ErrnoException;
    e.code = "ERR_INVALID_ARG_TYPE";
    seam.throwNext = e;
    expect(() =>
      dependencyFingerprint(path.join(dir, "a.agency"), {}, { resolveStdlib: false }),
    ).toThrow(/bad arg/);
  });

  test("carve-outs: index.agency and array.agency are walked non-templated, others templated", () => {
    dependencyFingerprint(path.join(getStdlibDir(), "array.agency"), {}, { resolveStdlib: true });
    const byPath = Object.fromEntries(seam.calls);
    expect(byPath[path.join(getStdlibDir(), "array.agency")]).toBe(false);
    expect(byPath[path.join(getStdlibDir(), "index.agency")]).toBe(false); // reached via re-export
    seam.calls.length = 0;
    dependencyFingerprint(path.join(getStdlibDir(), "path.agency"), {}, { resolveStdlib: true });
    expect(Object.fromEntries(seam.calls)[path.join(getStdlibDir(), "path.agency")]).toBe(true);
  });
});
