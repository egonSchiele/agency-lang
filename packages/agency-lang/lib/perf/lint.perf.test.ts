import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseAgency } from "../parser.js";
import type { LintContext, LintRule } from "../linter/types.js";
import { lintSource } from "../linter/registry.js";
import { unusedImportsRule } from "../linter/rules/unusedImports.js";
import { missingDocstringRule } from "../linter/rules/missingDocstring.js";
import { redundantPreludeImportRule } from "../linter/rules/redundantPreludeImport.js";
import { manyFunctions, manyUnusedImports, manyRedundantPreludeImports } from "./fixtures.js";
import { growthFactor, measureMs, expectPerf, GROWTH_BOUND } from "./harness.js";

const SMALL = 1000;
const LARGE = 8000;

function ctxFor(source: string): LintContext {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error("perf fixture did not parse");
  return { program: parsed.result, source, filePath: "/perf.agency" };
}

// Each rule needs its own findings-dense fixture (one finding per declaration);
// no single fixture feeds all three rules.
const cases: { name: string; rule: LintRule; fixture: (n: number) => string }[] = [
  {
    name: "missingDocstring",
    rule: missingDocstringRule,
    fixture: (n) => manyFunctions(n, { docstrings: false }),
  },
  { name: "unusedImport", rule: unusedImportsRule, fixture: manyUnusedImports },
  {
    name: "redundantPreludeImport",
    rule: redundantPreludeImportRule,
    fixture: manyRedundantPreludeImports,
  },
];

describe("lint rule scaling (per rule)", () => {
  for (const { name, rule, fixture } of cases) {
    it(`${name} scales linearly in file size`, () => {
      // Parse each size once (untimed); the closure runs only the cache-free
      // rule.run.
      const ctxBySize: Record<number, LintContext> = {
        [SMALL]: ctxFor(fixture(SMALL)),
        [LARGE]: ctxFor(fixture(LARGE)),
      };

      // Work-happened, both measurement points: a silently-degenerate fixture
      // at either size would make the ratio meaningless.
      expect(rule.run(ctxBySize[SMALL]).length).toBe(SMALL);
      expect(rule.run(ctxBySize[LARGE]).length).toBe(LARGE);

      const build = (n: number) => () => rule.run(ctxBySize[n]);
      const factor = growthFactor(build, SMALL, LARGE);
      expectPerf(`lint:${name}`, factor, GROWTH_BOUND);
    });
  }
});

describe("lint stdlib smoke (Layer 2, coarse)", () => {
  it("lints the whole stdlib under a generous ceiling", () => {
    const stdlibDir = path.resolve(__dirname, "../../stdlib");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".agency")) files.push(full);
      }
    };
    walk(stdlibDir);
    expect(files.length).toBeGreaterThan(0); // work-happened

    const sources = files.map((f) => [f, fs.readFileSync(f, "utf-8")] as const);
    const ms = measureMs(
      () => {
        for (const [f, src] of sources) lintSource(src, f, {});
      },
      { warmup: 1, runs: 3 },
    );
    // Loose on purpose: a smoke alarm for catastrophic breakage, not precise.
    expectPerf("lint:stdlib-smoke-ms", ms, 5000);
  });
});
