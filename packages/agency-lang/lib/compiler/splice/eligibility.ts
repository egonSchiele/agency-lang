import path from "node:path";
import fs from "node:fs";
import { parseAgency } from "../../parser.js";
import { agencyImportTarget } from "../compileClosure.js";
import { getEffectsFromFile } from "../typecheck.js";
import { isStdlibImport } from "../../importPaths.js";
import { walkNodesArray } from "../../utils/node.js";
import type { AgencyConfig } from "../../config.js";
import type { AgencyProgram, AgencyNode } from "../../types.js";
import type { SpliceDiagnostic, SpliceResult } from "./types.js";

/**
 * Splice eligibility: may this generator be run at compile time?
 *
 * The import-graph check is what the whole safety argument rests on.
 * Dangerous operations in Agency raise effects and effects are statically
 * checkable — but only for Agency code. TypeScript raises nothing, and
 * there is a live path to it: a plain JS/TS package like `zod` passes
 * through untouched when imported (docs/dev/pkg-imports.md). A generator
 * that can reach `zod` makes the effect check meaningless.
 */

/**
 * Which import edges a generator may have. The rule is one line on
 * purpose: it is the thing a reader checks against the spec, so it must
 * not be buried inside a traversal.
 *
 * `std::` is Agency and is verified as a whole elsewhere, so it is allowed
 * but not followed. A relative `.agency` file is Agency code: allowed AND
 * followed, which is what makes the check transitive. Everything else
 * leaves Agency — bare npm packages, and `pkg::`, which is Agency source
 * but can itself reach JavaScript one level down.
 */
const isAllowedEdge = (specifier: string): boolean =>
  isStdlibImport(specifier) || isRelativeAgencyPath(specifier);

function isRelativeAgencyPath(specifier: string): boolean {
  return specifier.endsWith(".agency") && !specifier.includes("::");
}

/** Every import edge declared by one file, unfiltered. */
function importEdgesOf(program: AgencyProgram): string[] {
  return program.nodes
    .map((node: AgencyNode) => agencyImportTarget(node))
    .filter((target): target is string => target !== null);
}

function parseFileOrNull(absPath: string, config: AgencyConfig): AgencyProgram | null {
  if (!fs.existsSync(absPath)) {
    return null;
  }
  const result = parseAgency(fs.readFileSync(absPath, "utf-8"), config, true, false);
  return result.success ? result.result : null;
}

/**
 * Every file a generator can reach through relative `.agency` imports,
 * entry first.
 *
 * Three checks and the expansion cache all need this same set, and each
 * asks a different question of each file, so the walk is here once and the
 * question is the caller's. `std::` modules are deliberately NOT followed:
 * they are Agency, verified as a whole elsewhere, and walking them would
 * drag most of the standard library into every check.
 *
 * A file that does not exist or does not parse is skipped rather than
 * reported. Whether that is fatal depends on the caller — the effect check
 * treats an unreadable file as a refusal, while the cache simply has less
 * to hash.
 */
export function closureFiles(
  entryPath: string,
  config: AgencyConfig = {},
): string[] {
  // Paths are user-controlled, so the visited dictionary is null-prototype
  // and membership goes through Object.hasOwn (house pattern, see
  // lib/optimize/registry.ts). Without it an import cycle loops forever.
  const visited: Record<string, true> = Object.create(null);
  const found: string[] = [];
  const queue: string[] = [path.resolve(entryPath)];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (Object.hasOwn(visited, current)) {
      continue;
    }
    visited[current] = true;

    const program = parseFileOrNull(current, config);
    if (program === null) {
      continue;
    }
    found.push(current);

    for (const specifier of importEdgesOf(program)) {
      if (isRelativeAgencyPath(specifier)) {
        queue.push(path.resolve(path.dirname(current), specifier));
      }
    }
  }
  return found;
}

/**
 * Walk the generator module's transitive Agency import graph and return the
 * first edge that leaves Agency code, or null when every edge is allowed.
 *
 * Transitive is the operative word: checking only the generator's own file
 * is not enough, because a local `.agency` file it imports can pull in
 * `zod` one level down and the generator itself looks clean.
 */
export function checkImportGraph(
  entryPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  // Paths are user-controlled, so the visited dictionary is null-prototype
  // and membership goes through Object.hasOwn (house pattern, see
  // lib/optimize/registry.ts). Without it an import cycle loops forever.
  const visited: Record<string, true> = Object.create(null);
  const queue: string[] = [path.resolve(entryPath)];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (Object.hasOwn(visited, current)) {
      continue;
    }
    visited[current] = true;

    const program = parseFileOrNull(current, config);
    if (program === null) {
      continue;
    }

    for (const specifier of importEdgesOf(program)) {
      if (!isAllowedEdge(specifier)) {
        return {
          diagnostic: "spliceGeneratorReachesNonAgency",
          params: { name: generatorName, importPath: specifier },
          loc: { line: 0, col: 0, start: 0, end: 0 },
        };
      }
      if (isRelativeAgencyPath(specifier)) {
        queue.push(path.resolve(path.dirname(current), specifier));
      }
    }
  }
  return null;
}

/**
 * Sources of nondeterminism a generator may not reach.
 *
 * The effect system gates things that are DANGEROUS. It does not gate
 * things that are merely UNREPEATABLE, and at build time those are
 * different problems. `llm()` raises no interrupt at all — stdlib/llm.agency
 * contains zero interrupt sites and `llm` is a language builtin — so it
 * sails through the effect check while making a network call, spending
 * money, and producing a different program on every build.
 *
 * `llm` is a builtin (see resolveCall.ts's builtin list), so a bare name
 * match is unambiguous. The clock arrives through `std::date`, so it is
 * matched by what a file actually imports rather than by spelling, which
 * would false-positive on a user's own `now()`.
 *
 * There is no randomness in the stdlib's exported surface today. If one is
 * added, it belongs here.
 */
const NONDETERMINISTIC_BUILTINS: readonly string[] = ["llm"];
const NONDETERMINISTIC_STDLIB: Record<string, readonly string[]> = {
  "std::date": ["now", "today"],
};

/** Local names in one file that resolve to a nondeterministic function. */
function nondeterministicNamesIn(program: AgencyProgram): string[] {
  const names = [...NONDETERMINISTIC_BUILTINS];
  for (const node of program.nodes) {
    if (node.type !== "importStatement") {
      continue;
    }
    const flagged = NONDETERMINISTIC_STDLIB[node.modulePath];
    if (flagged === undefined) {
      continue;
    }
    for (const nameGroup of node.importedNames) {
      if (nameGroup.type !== "namedImport") {
        continue;
      }
      const aliases = nameGroup.aliases ?? {};
      for (const entry of nameGroup.importedNames) {
        if (typeof entry === "string" && flagged.includes(entry)) {
          names.push(Object.hasOwn(aliases, entry) ? aliases[entry] : entry);
        }
      }
    }
  }
  return names;
}

/** The first nondeterministic call in one file, or null. */
function nondeterministicCallIn(program: AgencyProgram): string | null {
  const flagged = nondeterministicNamesIn(program);
  const call = [...walkNodesArray(program.nodes)]
    .map((visit) => visit.node)
    .find(
      (node) => node.type === "functionCall" && flagged.includes(node.functionName),
    );
  return call === undefined ? null : `${(call as { functionName: string }).functionName}()`;
}

/**
 * Refuse a generator that can reach an LLM call or the clock.
 *
 * Scope is the generator's transitive closure of RELATIVE `.agency` files,
 * the same set `checkImportGraph` walks. `std::` modules are trusted and
 * not scanned — otherwise importing `std::agent`, which certainly calls
 * `llm`, would refuse every generator that touched it.
 *
 * Deliberately coarse: a file anywhere in the closure containing a
 * nondeterministic call is enough, even if the generator never calls the
 * function that makes it. Per-function transitive analysis would be
 * sharper, but generators are small and effect-free by rule already, and
 * being conservative here fails closed. If false positives show up in
 * practice, this is the place to narrow.
 */
export function checkDeterminism(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  for (const file of closureFiles(generatorPath, config)) {
    const program = parseFileOrNull(file, config);
    const found = program === null ? null : nondeterministicCallIn(program);
    if (found !== null) {
      return {
        diagnostic: "spliceGeneratorNondeterministic",
        params: { name: generatorName, source: found },
        loc: { line: 0, col: 0, start: 0, end: 0 },
      };
    }
  }
  return null;
}

/**
 * Refuse a generator that can reach any interrupt effect.
 *
 * Two things make this more than a lookup, and both were found by testing
 * rather than by reading.
 *
 * First, take a PATH, never a source string. `getEffectsFromSource` passes
 * `undefined` as `sourcePath`, so `withSourcePath` writes to a fresh temp
 * dir where `./helper.agency` does not exist — and import resolution then
 * THROWS rather than returning a short answer.
 *
 * Second, and worse: the effect map does not propagate across a module
 * boundary even with a real path. Measured directly —
 *
 *     helper.agency alone      → { h: ["std::read"] }
 *     gen.agency, calling h()  → { g: [] }
 *
 * So a generator that delegates its effectful work one file away reports
 * an EMPTY effect list, which reads as "safe to run at compile time". The
 * spec and the plan review both assumed the path fix was sufficient. It is
 * not.
 *
 * Until cross-module propagation exists in the checker, scope the check to
 * the generator's transitive closure of relative `.agency` files, the same
 * set the import-graph and determinism checks walk. Within the generator's
 * OWN file the map is accurate, so check the generator by name there;
 * across an import boundary nothing says which exports are reachable, so
 * ANY effectful export refuses. Coarse, and deliberately so: generators
 * are small and effect-free by rule already, and this fails closed.
 */
export function checkEffects(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  const files = closureFiles(generatorPath, config);
  for (const file of files) {
    const found = effectsInFile(file, generatorName, file === files[0]);
    if (found !== null) {
      return {
        diagnostic: "spliceGeneratorHasEffects",
        params: { name: generatorName, effects: found },
        loc: { line: 0, col: 0, start: 0, end: 0 },
      };
    }
  }
  return null;
}

/**
 * Effects declared by one file: the named generator when this is its own
 * file, otherwise any export. Returns a printable list, or null for none.
 */
function effectsInFile(
  filePath: string,
  generatorName: string,
  isEntry: boolean,
): string | null {
  let byExport: Record<string, string[]>;
  try {
    byExport = getEffectsFromFile(filePath);
  } catch (err) {
    // An unresolvable import or a type error in the closure means the
    // effect list cannot be trusted. Fail CLOSED: an unknown answer is not
    // a safe one when the question is "may this run at compile time".
    console.error(`splice eligibility: cannot read effects of ${filePath}:`, err);
    return "unknown";
  }
  const effects = isEntry
    ? (byExport[generatorName] ?? [])
    : Object.values(byExport).flat();
  const unique = effects.filter((name, index) => effects.indexOf(name) === index);
  return unique.length === 0 ? null : unique.sort().join(", ");
}

/**
 * Refuse a generator whose own closure contains a splice.
 *
 * Running a generator compiles it, and compiling it expands any splice it
 * contains, which runs another generator. That recursion has no natural
 * floor, and a generator that spliced itself would not terminate. Template
 * Haskell forbids the same thing for the same reason.
 *
 * The plan proposed detecting this by threading a "this compile is a
 * generator" flag through the runner's compile. A closure scan does the
 * same job without plumbing a flag through `SymbolTable.build`'s twelve
 * callers, and it refuses BEFORE anything is compiled rather than partway
 * into a recursion.
 */
export function checkNoNestedSplice(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  for (const file of closureFiles(generatorPath, config)) {
    const program = parseFileOrNull(file, config);
    const hasSplice =
      program !== null &&
      [...walkNodesArray(program.nodes)].some((visit) => visit.node.type === "splice");
    if (hasSplice) {
      return {
        diagnostic: "spliceNested",
        params: { name: generatorName, path: file },
        loc: { line: 0, col: 0, start: 0, end: 0 },
      };
    }
  }
  return null;
}

/**
 * All four checks, composed. The expansion pass calls this and never names
 * an individual rule, so adding a rule later is an entry in this array
 * rather than an edit to the pass.
 */
export function checkGeneratorEligible(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  const checks = [
    () => checkImportGraph(generatorPath, generatorName, config),
    () => checkNoNestedSplice(generatorPath, generatorName, config),
    () => checkEffects(generatorPath, generatorName, config),
    () => checkDeterminism(generatorPath, generatorName, config),
  ];
  return checks.reduce<SpliceDiagnostic | null>(
    (found, check) => found ?? check(),
    null,
  );
}

/**
 * Which module supplies a splice's generator, and under what name.
 *
 * Rule 2 lives here: a generator must be imported from another file. It
 * has to be compiled before the file that splices it can be, so it cannot
 * live in that same file — there is no order that works. Template Haskell
 * calls this the stage restriction and pays the same cost.
 *
 * Returns the module's original exported name, so an aliased import
 * (`import { makeGetters as gen }`) resolves to what the module actually
 * exports rather than to the local spelling.
 */
export function resolveGeneratorModule(
  program: AgencyProgram,
  localName: string,
  hostPath: string,
): SpliceResult<{ modulePath: string; exportedName: string }> {
  for (const node of program.nodes) {
    if (node.type !== "importStatement") {
      continue;
    }
    for (const nameGroup of node.importedNames) {
      if (nameGroup.type !== "namedImport") {
        continue;
      }
      const exportedName = exportedNameBoundTo(nameGroup, localName);
      if (exportedName !== null) {
        return {
          ok: true,
          value: {
            modulePath: path.resolve(path.dirname(hostPath), node.modulePath),
            exportedName,
          },
        };
      }
    }
  }
  return {
    ok: false,
    diagnostic: {
      diagnostic: "spliceGeneratorNotImported",
      params: { name: localName },
      loc: { line: 0, col: 0, start: 0, end: 0 },
    },
  };
}

/**
 * Which exported name does this import group bind to `localName`?
 *
 * `importedNames` holds the ORIGINAL exported names; an alias lives
 * separately in `aliases`, mapping original to local binding. So
 * `import { makeGetters as gen }` stores `["makeGetters"]` plus
 * `{ makeGetters: "gen" }`, and looking only at the specifier list would
 * match the wrong spelling.
 *
 * Specifiers are plain strings, except in templates where an identifier
 * hole can occupy a specifier position; a hole binds no real name, so it
 * never matches.
 */
function exportedNameBoundTo(
  nameGroup: { importedNames: unknown[]; aliases?: Record<string, string> },
  localName: string,
): string | null {
  const aliases = nameGroup.aliases ?? {};
  for (const entry of nameGroup.importedNames) {
    if (typeof entry !== "string") {
      continue;
    }
    // Alias keys come from user source, so membership is Object.hasOwn.
    const boundAs = Object.hasOwn(aliases, entry) ? aliases[entry] : entry;
    if (boundAs === localName) {
      return entry;
    }
  }
  return null;
}
