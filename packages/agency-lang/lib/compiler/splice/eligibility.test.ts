import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { safeDeleteDirectory } from "../../utils.js";
import { parseAgency } from "../../parser.js";
import {
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
    expect(checkImportGraph(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorReachesNonAgency",
    );
  });

  it("refuses a generator reaching npm one file away", () => {
    // The case that decides whether this check means anything. The
    // generator's own imports look spotless.
    write("side.agency", `import { z } from "zod"\n\nexport def s(): number {\n  return 1\n}\n`);
    const generator = write(
      "gen.agency",
      `import { s } from "./side.agency"\n\nexport def g(): number {\n  return s()\n}\n`,
    );
    expect(checkImportGraph(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorReachesNonAgency",
    );
  });

  it("refuses an `export from` that leaves Agency", () => {
    // An import-only scan would miss this, which is why the shared
    // agencyImportTarget extractor is used rather than a local scan.
    const generator = write(
      "gen.agency",
      `export { z } from "zod"\n\nexport def g(): number {\n  return 1\n}\n`,
    );
    expect(checkImportGraph(generator, "g")?.diagnostic).toBe(
      "spliceGeneratorReachesNonAgency",
    );
  });
});
