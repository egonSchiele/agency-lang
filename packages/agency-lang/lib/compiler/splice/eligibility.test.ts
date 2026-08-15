import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../../utils.js";
import { parseAgency } from "../../parser.js";
import { checkImportGraph, resolveGeneratorModule } from "./eligibility.js";
import { checkGeneratorEffects } from "./generatorEffects.js";
import type { AgencyProgram } from "../../types.js";

let dir: string;

beforeEach(() => {
  // Under the project's .agency-tmp/, not os.tmpdir(): safeDeleteDirectory
  // has a project-containment check that rejects anything outside the
  // project. Same reasoning as lib/compiler/typecheck.ts:60-62.
  dir = path.join(process.cwd(), ".agency-tmp", `splice-elig-${nanoid()}`);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  safeDeleteDirectory(dir);
});

function write(name: string, source: string): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, source, "utf-8");
  return target;
}

function hostProgram(source: string): AgencyProgram {
  const result = parseAgency(source, {}, false, false);
  if (!result.success) {
    throw new Error(result.message ?? "parse failed");
  }
  return result.result;
}

describe("resolveGeneratorModule", () => {
  it("resolves a generator imported from a relative file", () => {
    const resolved = resolveGeneratorModule(
      hostProgram(`import { g } from "./gen.agency"\n\n$( g() )\n`),
      "g",
      path.join(dir, "main.agency"),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.modulePath).toContain("gen.agency");
      expect(resolved.value.exportedName).toBe("g");
    }
  });

  it("resolves an aliased import to the original exported name", () => {
    const resolved = resolveGeneratorModule(
      hostProgram(`import { makeGetters as gen } from "./gen.agency"\n\n$( gen() )\n`),
      "gen",
      path.join(dir, "main.agency"),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.exportedName).toBe("makeGetters");
    }
  });

  it("rejects a generator defined in the host file", () => {
    // Rule 2, the stage restriction. The generator must be compiled before
    // the file that splices it, so it cannot live in that same file.
    const resolved = resolveGeneratorModule(
      hostProgram(`def g(): number {\n  return 1\n}\n\n$( g() )\n`),
      "g",
      path.join(dir, "main.agency"),
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.diagnostic.diagnostic).toBe("spliceGeneratorNotImported");
    }
  });

  it("rejects a generator that is not imported at all", () => {
    const resolved = resolveGeneratorModule(
      hostProgram(`$( nowhere() )\n`),
      "nowhere",
      path.join(dir, "main.agency"),
    );
    expect(resolved.ok).toBe(false);
  });
});

describe("checkImportGraph", () => {
  it("allows a generator importing only std::", () => {
    const generator = write(
      "gen.agency",
      `import { fill } from "std::agency"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    expect(checkImportGraph(generator, "g")).toBeNull();
  });

  it("allows a generator importing a relative .agency file", () => {
    write("helper.agency", `export def h(): number {\n  return 2\n}\n`);
    const generator = write(
      "gen.agency",
      `import { h } from "./helper.agency"\n\nexport def g(): number {\n  return h()\n}\n`,
    );
    expect(checkImportGraph(generator, "g")).toBeNull();
  });

  it("refuses a generator importing an npm package directly", () => {
    const generator = write(
      "gen.agency",
      `import { z } from "zod"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    expect(checkImportGraph(generator, "g")?.diagnostic).toBe("spliceGeneratorReachesNonAgency");
  });

  it("refuses a generator reaching npm one file away", () => {
    // The case that decides whether this check means anything. The
    // generator's own imports look spotless.
    write("side.agency", `import { z } from "zod"\n\nexport def s(): number {\n  return 1\n}\n`);
    const generator = write(
      "gen.agency",
      `import { s } from "./side.agency"\n\nexport def g(): number {\n  return s()\n}\n`,
    );
    expect(checkImportGraph(generator, "g")?.diagnostic).toBe("spliceGeneratorReachesNonAgency");
  });

  it("refuses an `export from` that leaves Agency", () => {
    // An import-only scan would miss this, which is why the shared
    // agencyImportTarget extractor is used rather than a local scan.
    const generator = write(
      "gen.agency",
      `export { z } from "zod"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    expect(checkImportGraph(generator, "g")?.diagnostic).toBe("spliceGeneratorReachesNonAgency");
  });
});

describe("checkGeneratorEffects", () => {
  it("refuses a generator whose risky work is one file away", () => {
    write("helper.agency", `export def h(): string {\n  return read("x")\n}\n`);
    const gen = write(
      "gen.agency",
      `import { h } from "./helper.agency"\n\nexport def makeThing(): string {\n  return h()\n}\n`,
    );
    const result = checkGeneratorEffects(gen, "makeThing", {});
    expect(result?.diagnostic).toBe("spliceGeneratorRaises");
    expect(result?.params.effects).toBe("std::read");
  });

  it("allows a clean generator that imports from a messy file", () => {
    // What call-graph scoping buys. The generator calls `clean`; `messy` is in
    // the same file and irrelevant to it. A file-scoped rule refuses this.
    write(
      "helper.agency",
      `export def clean(): string {\n  return "hi"\n}\n\n` +
        `export def messy(): string {\n  return read("x")\n}\n`,
    );
    const gen = write(
      "gen.agency",
      `import { clean } from "./helper.agency"\n\nexport def makeThing(): string {\n  return clean()\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})).toBeNull();
  });

  it("allows an ordinary generator with no imports at all", () => {
    const gen = write(
      "gen.agency",
      `export def makeThing(): string {\n  return "const x = 1"\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})).toBeNull();
  });

  it("refuses when a reachable function calls one of its parameters", () => {
    const gen = write(
      "gen.agency",
      `export def apply(f: () -> string): string {\n  return f()\n}\n\n` +
        `export def makeThing(): string {\n  return apply(other)\n}\n`,
    );
    const result = checkGeneratorEffects(gen, "makeThing", {});
    expect(result?.diagnostic).toBe("spliceGeneratorUnreadable");
    expect(String(result?.params.reason)).toMatch(/received as a parameter/);
  });

  it("refuses when a reachable function passes a reference through a variable", () => {
    write(
      "helper.agency",
      `export def clean(): string {\n  const fn = read\n  return runIt(fn)\n}\n`,
    );
    const gen = write(
      "gen.agency",
      `import { clean } from "./helper.agency"\n\nexport def makeThing(): string {\n  return clean()\n}\n`,
    );
    const result = checkGeneratorEffects(gen, "makeThing", {});
    expect(result?.diagnostic).toBe("spliceGeneratorUnreadable");
    expect(String(result?.params.reason)).toMatch(/through a variable/);
  });

  it("refuses when a reachable file does not parse", () => {
    // The crawl skips an unparseable file and keeps going, so an empty effect
    // list here would come from a reading that saw nothing.
    write("broken.agency", `export def oops(: {{{\n`);
    const gen = write(
      "gen.agency",
      `import { oops } from "./broken.agency"\n\nexport def makeThing(): string {\n  return "x"\n}\n`,
    );
    const result = checkGeneratorEffects(gen, "makeThing", {});
    expect(result?.diagnostic).toBe("spliceGeneratorUnreadable");
    expect(String(result?.params.reason)).toMatch(/does not parse/);
  });
});

describe("checkGeneratorEffects narrowing", () => {
  it("allows a generator that renames an ordinary value", () => {
    // `title` and `label` are strings. Treating any alias as a held function
    // reference refused this, which defeats the point of scoping blind spots
    // to the call graph rather than to files.
    const gen = write(
      "gen.agency",
      `export def build(x: string): string {\n  return x\n}\n\n` +
        `export def makeThing(title: string): string {\n  const label = title\n  return build(label)\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})).toBeNull();
  });

  it("refuses a reference passed as a named argument", () => {
    write(
      "helper.agency",
      `export def clean(): string {\n  const fn = read\n  return runIt(cb: fn)\n}\n`,
    );
    const gen = write(
      "gen.agency",
      `import { clean } from "./helper.agency"\n\nexport def makeThing(): string {\n  return clean()\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})?.diagnostic).toBe(
      "spliceGeneratorUnreadable",
    );
  });

  it("refuses a reference passed through a splat", () => {
    write(
      "helper.agency",
      `export def clean(): string {\n  const fn = read\n  return runIt(...fn)\n}\n`,
    );
    const gen = write(
      "gen.agency",
      `import { clean } from "./helper.agency"\n\nexport def makeThing(): string {\n  return clean()\n}\n`,
    );
    expect(checkGeneratorEffects(gen, "makeThing", {})?.diagnostic).toBe(
      "spliceGeneratorUnreadable",
    );
  });
});
