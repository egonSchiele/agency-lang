/**
 * Precompile pass for the Agency test runner — a thin adapter over
 * BuildSession.compileGroups.
 *
 * Historically each test CASE recompiled its `.agency` source (and the
 * source's whole import tree) via `executeNodeAsync` → `compile()` — with
 * `-p 12` interleaving entries, the per-session closure cache thrashed and
 * CI ran ~1750 compiles for ~870 unique files. This pass compiles every
 * unique source exactly once, up front; the runner then executes test cases
 * with `preferCompiled: true`, which reuses the sibling `.js`.
 *
 * What lives HERE is only what is test-runner-specific: mapping `.test.json`
 * files to sibling sources, honoring file-level skip/skipOnCI, and merging a
 * dir-local `agency.json` over the base config. The config grouping
 * contract, the cross-config single-slot assert, and the per-group compile
 * loop live in lib/compiler/buildSession.ts.
 */
import fs from "fs";
import path from "path";
import { AgencyConfig } from "../config.js";
import { loadConfig } from "./commands.js";
import {
  createBuildSession,
  type CompileGroup,
} from "../compiler/buildSession.js";

const BASE_GROUP_LABEL = "<base config>";

// Back-compat name for existing importers (precompile.test.ts).
export type { CompileGroup as PrecompileGroup };

// Two kinds of .test.json must not be precompiled, both because their
// source may intentionally not compile — and a failure in this pass ends
// the process before any test runs:
//   - `skip: true` (or `skipOnCI: true` under CI), mirroring runTestFile.
//   - `expectedCompileError`, whose whole point is a source that fails;
//     runTestFile compiles it in a child process instead. Presence, not
//     type: a wrongly-typed value must still keep the broken source out
//     of this pass — the runner validates the type and fails just that
//     fixture.
// Malformed .test.json is treated as live; the runner will surface the
// real error.
function isExcludedFromPrecompile(testJsonFile: string): boolean {
  try {
    const tests = JSON.parse(fs.readFileSync(testJsonFile, "utf-8"));
    return (
      tests.skip === true ||
      (tests.skipOnCI === true && !!process.env.CI) ||
      tests.expectedCompileError !== undefined
    );
  } catch {
    return false;
  }
}

export function groupTestSources(
  baseConfig: AgencyConfig,
  testJsonFiles: string[],
): CompileGroup[] {
  // Null-prototype: keyed by dir paths (see lib/optimize/registry.ts for the
  // house pattern on string-keyed registries).
  const groups: Record<string, CompileGroup> = Object.create(null);
  for (const testJsonFile of testJsonFiles) {
    const sourceFile = path
      .resolve(testJsonFile)
      .replace(/\.test\.json$/, ".agency");
    if (!fs.existsSync(sourceFile)) continue;
    if (isExcludedFromPrecompile(testJsonFile)) continue;

    const dir = path.dirname(sourceFile);
    const localConfigPath = path.join(dir, "agency.json");
    let label = BASE_GROUP_LABEL;
    let config = baseConfig;
    if (fs.existsSync(localConfigPath)) {
      label = dir;
      config = { ...baseConfig, ...loadConfig(localConfigPath) };
    }

    const group = (groups[label] ??= {
      label,
      config,
      files: [],
    });
    if (!group.files.includes(sourceFile)) group.files.push(sourceFile);
  }
  return Object.values(groups);
}

export function precompileTestSources(
  baseConfig: AgencyConfig,
  testJsonFiles: string[],
  options?: { quiet?: boolean },
): void {
  const groups = groupTestSources(baseConfig, testJsonFiles);
  // Fresh session per precompile — a declared delta from the old shared
  // module globals: the default session no longer inherits precompile's
  // last-group closure/dedupe state. Safe because test cases run with
  // `preferCompiled: true` and never re-enter compile(); the old inherited
  // state was itself a latent staleness hazard.
  createBuildSession().compileGroups(groups, {
    quiet: options?.quiet,
    allowTestImports: true,
  });
}
