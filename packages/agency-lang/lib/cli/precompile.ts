/**
 * Precompile pass for the Agency test runner.
 *
 * Historically each test CASE recompiled its `.agency` source (and the
 * source's whole import tree) via `executeNodeAsync` → `compile()` — with
 * `-p 12` interleaving entries, the per-session closure cache thrashed and
 * CI ran ~1750 compiles for ~870 unique files. This pass compiles every
 * unique source exactly once, up front; the runner then executes test cases
 * with `preferCompiled: true`, which reuses the sibling `.js`.
 *
 * Config grouping: compiled output is config-dependent (the generator bakes
 * config defaults into emitted code), and a test dir may carry a local
 * `agency.json` that `runTestFile` merges over the base config. Sources are
 * therefore grouped by merged config — one union-closure compile for all
 * base-config files, plus one per local-config dir.
 *
 * Cross-config invariant: a sibling `.js` is a single slot per module, so a
 * module reachable from two groups whose configs differ would be
 * last-writer-wins. That is asserted here and fails loudly (no test dir
 * does this today). A graceful fallback (per-case compiles for conflicting
 * files) was rejected: interleaved recompiles rewrite shared siblings
 * mid-run, which is exactly the race this pass removes.
 */
import fs from "fs";
import path from "path";
import { AgencyConfig } from "../config.js";
import { loadConfig, compileMany } from "./commands.js";
import {
  buildCompiledClosure,
  CompileClosureError,
  type CompiledClosure,
} from "../compiler/compileClosure.js";

const BASE_GROUP_LABEL = "<base config>";

export type PrecompileGroup = {
  /** Base-config marker or the local-`agency.json` dir, for error messages. */
  label: string;
  config: AgencyConfig;
  /** Canonical serialization of `config`; groups conflict only when keys differ. */
  configKey: string;
  /** Absolute `.agency` entry paths. */
  files: string[];
};

// File-level skip mirror of runTestFile's check: a `skip: true` (or
// `skipOnCI: true` under CI) .test.json never runs, so its source must not
// be precompiled either — it may intentionally not compile. Malformed
// .test.json is treated as live; the runner will surface the real error.
function isFileLevelSkipped(testJsonFile: string): boolean {
  try {
    const tests = JSON.parse(fs.readFileSync(testJsonFile, "utf-8"));
    return tests.skip === true || (tests.skipOnCI === true && !!process.env.CI);
  } catch {
    return false;
  }
}

export function groupTestSources(
  baseConfig: AgencyConfig,
  testJsonFiles: string[],
): PrecompileGroup[] {
  const groups: Record<string, PrecompileGroup> = {};
  for (const testJsonFile of testJsonFiles) {
    const sourceFile = path
      .resolve(testJsonFile)
      .replace(/\.test\.json$/, ".agency");
    if (!fs.existsSync(sourceFile)) continue;
    if (isFileLevelSkipped(testJsonFile)) continue;

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
      configKey: JSON.stringify(config),
      files: [],
    });
    if (!group.files.includes(sourceFile)) group.files.push(sourceFile);
  }
  return Object.values(groups);
}

export function findCrossConfigConflicts(
  groups: { label: string; configKey: string; modules: string[] }[],
): { module: string; labels: string[] }[] {
  const touchedBy: Record<string, { configKey: string; label: string }[]> = {};
  for (const group of groups) {
    for (const module of group.modules) {
      (touchedBy[module] ??= []).push({
        configKey: group.configKey,
        label: group.label,
      });
    }
  }
  const conflicts: { module: string; labels: string[] }[] = [];
  for (const [module, touches] of Object.entries(touchedBy)) {
    const distinctKeys = touches
      .map((t) => t.configKey)
      .filter((key, i, all) => all.indexOf(key) === i);
    if (distinctKeys.length > 1) {
      conflicts.push({ module, labels: touches.map((t) => t.label) });
    }
  }
  return conflicts;
}

export function precompileTestSources(
  baseConfig: AgencyConfig,
  testJsonFiles: string[],
  options?: { quiet?: boolean },
): void {
  const groups = groupTestSources(baseConfig, testJsonFiles);
  const withClosures: { group: PrecompileGroup; closure: CompiledClosure }[] =
    groups.map((group) => ({
      group,
      closure: buildCompiledClosure(group.files, group.config),
    }));

  const conflicts = findCrossConfigConflicts(
    withClosures.map(({ group, closure }) => ({
      label: group.label,
      configKey: group.configKey,
      modules: Object.keys(closure.programs),
    })),
  );
  if (conflicts.length > 0) {
    const lines = conflicts.map(
      (c) =>
        `  ${c.module}\n    reachable from: ${c.labels.join(", ")}`,
    );
    throw new CompileClosureError(
      "Test sources with differing configs share modules. A module's " +
        "compiled .js is a single slot, so this would be last-writer-wins. " +
        "Move the shared module or align the configs:\n" +
        lines.join("\n"),
    );
  }

  for (const { group, closure } of withClosures) {
    compileMany(group.config, group.files, {
      closure,
      quiet: options?.quiet,
      allowTestImports: true,
    });
  }
}
