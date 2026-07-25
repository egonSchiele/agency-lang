import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../../utils.js";
import { parseAgency } from "../../parser.js";
import {
  checkDeterminism,
  checkEffects,
  checkGeneratorEligible,
  checkImportGraph,
  resolveGeneratorModule,
} from "./eligibility.js";
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

  it("rejects a generator importing a JS/TS package directly", () => {
    const generator = write(
      "gen.agency",
      `import { z } from "zod"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    const failure = checkImportGraph(generator, "g");
    expect(failure?.diagnostic).toBe("spliceGeneratorReachesNonAgency");
    expect(failure?.params.importPath).toBe("zod");
  });

  it("rejects a JS/TS package reached one level down", () => {
    // THE test the safety argument rests on. gen.agency itself looks
    // clean; only a transitive walk finds the zod edge. Do not drop this.
    write(
      "helper.agency",
      `import { z } from "zod"\n\nexport def h(): number {\n  return 1\n}\n`,
    );
    const generator = write(
      "gen.agency",
      `import { h } from "./helper.agency"\n\nexport def g(): number {\n  return h()\n}\n`,
    );
    const failure = checkImportGraph(generator, "g");
    expect(failure?.diagnostic).toBe("spliceGeneratorReachesNonAgency");
    expect(failure?.params.importPath).toBe("zod");
  });

  it("rejects a re-export edge to a JS package", () => {
    // The case compileClosure.ts's own doc comment warns about: an
    // importStatement-only scan lets `export { x } from "zod"` escape.
    const generator = write(
      "gen.agency",
      `export { z } from "zod"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    expect(checkImportGraph(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorReachesNonAgency",
    );
  });

  it("rejects pkg:: imports in v1", () => {
    const generator = write(
      "gen.agency",
      `import { t } from "pkg::toolbox"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    expect(checkImportGraph(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorReachesNonAgency",
    );
  });

  it("terminates on an import cycle", { timeout: 10_000 }, () => {
    // Without the visited set this does not go red, it HANGS — and a
    // hanging test teaches nobody anything. The explicit timeout converts
    // the hang into a failure.
    write(
      "a.agency",
      `import { b } from "./b.agency"\n\nexport def a(): number {\n  return b()\n}\n`,
    );
    const generator = write(
      "b.agency",
      `import { a } from "./a.agency"\n\nexport def b(): number {\n  return 1\n}\n`,
    );
    expect(checkImportGraph(generator, "b")).toBeNull();
  });

  it("does not crash on an import that does not resolve", () => {
    const generator = write(
      "gen.agency",
      `import { missing } from "./nope.agency"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    expect(checkImportGraph(generator, "g")).toBeNull();
  });
});

describe("checkEffects", () => {
  it("allows a pure generator", () => {
    const generator = write("gen.agency", `export def g(): number {\n  return 1\n}\n`);
    expect(checkEffects(generator, "g")).toBeNull();
  });

  it("rejects a generator that reads a file", () => {
    const generator = write(
      "gen.agency",
      `export def g(): Result {\n  return read("x.txt")\n}\n`,
    );
    const failure = checkEffects(generator, "g");
    expect(failure?.diagnostic).toBe("spliceGeneratorHasEffects");
    expect(failure?.params.effects).toContain("read");
  });

  it("rejects a generator whose relative helper is effectful", () => {
    // THE fail-open test. getEffectsFromSource passes undefined as
    // sourcePath, so relative imports resolve against an empty temp dir,
    // the helper's effects never propagate, and the list comes back EMPTY
    // — a generator that reads files reported as safe to run at compile
    // time. Worse than the transitive-import hole, because gen.agency has
    // no suspicious import at all. Do not drop this.
    write("helper.agency", `export def h(): Result {\n  return read("x.txt")\n}\n`);
    const generator = write(
      "gen.agency",
      `import { h } from "./helper.agency"\n\nexport def g(): Result {\n  return h()\n}\n`,
    );
    expect(checkEffects(generator, "g")?.diagnostic).toBe("spliceGeneratorHasEffects");
  });
});

describe("checkDeterminism", () => {
  it("allows a pure generator", () => {
    const generator = write("gen.agency", `export def g(): number {\n  return 1\n}\n`);
    expect(checkDeterminism(generator, "g")).toBeNull();
  });

  it("allows a generator calling ordinary stdlib functions", () => {
    // NEGATIVE CONTROL. Without it, an implementation that flags every
    // stdlib call passes every other test in this block while making the
    // feature useless.
    const generator = write(
      "gen.agency",
      `import { fill } from "std::agency"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    expect(checkDeterminism(generator, "g")).toBeNull();
  });

  it("rejects a generator that calls llm()", () => {
    const generator = write(
      "gen.agency",
      `export def g(): string {\n  return llm("write something")\n}\n`,
    );
    const failure = checkDeterminism(generator, "g");
    expect(failure?.diagnostic).toBe("spliceGeneratorNondeterministic");
    expect(failure?.params.source).toContain("llm");
  });

  it("rejects a generator reaching llm() through a same-file helper", () => {
    const generator = write(
      "gen.agency",
      `def helper(): string {\n  return llm("x")\n}\n\nexport def g(): string {\n  return helper()\n}\n`,
    );
    expect(checkDeterminism(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorNondeterministic",
    );
  });

  it("rejects a generator whose relative helper calls llm()", () => {
    write("helper.agency", `export def h(): string {\n  return llm("x")\n}\n`);
    const generator = write(
      "gen.agency",
      `import { h } from "./helper.agency"\n\nexport def g(): string {\n  return h()\n}\n`,
    );
    expect(checkDeterminism(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorNondeterministic",
    );
  });

  it("rejects a generator that reads the clock", () => {
    const generator = write(
      "gen.agency",
      `import { now } from "std::date"\n\nexport def g(): number {\n  return now()\n}\n`,
    );
    expect(checkDeterminism(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorNondeterministic",
    );
  });

  it("follows the clock through an alias", () => {
    const generator = write(
      "gen.agency",
      `import { now as rightNow } from "std::date"\n\nexport def g(): number {\n  return rightNow()\n}\n`,
    );
    expect(checkDeterminism(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorNondeterministic",
    );
  });

  it("does not flag a user's own now() that is not the clock", () => {
    const generator = write(
      "gen.agency",
      `def now(): number {\n  return 7\n}\n\nexport def g(): number {\n  return now()\n}\n`,
    );
    expect(checkDeterminism(generator, "g")).toBeNull();
  });
});

describe("checkGeneratorEligible", () => {
  it("allows a clean generator", () => {
    const generator = write("gen.agency", `export def g(): number {\n  return 1\n}\n`);
    expect(checkGeneratorEligible(generator, "g")).toBeNull();
  });

  it("reports the import-graph failure first", () => {
    const generator = write(
      "gen.agency",
      `import { z } from "zod"\n\nexport def g(): string {\n  return llm("x")\n}\n`,
    );
    expect(checkGeneratorEligible(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorReachesNonAgency",
    );
  });
});

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
