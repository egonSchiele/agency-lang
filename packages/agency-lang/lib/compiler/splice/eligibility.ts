import path from "node:path";
import fs from "node:fs";
import { parseAgencyFileCached } from "../../parseCache.js";
import { agencyImportTarget } from "../compileClosure.js";
import { getEffectsFromFile } from "../typecheck.js";
import { isStdlibImport } from "../../importPaths.js";
import { walkNodesArray } from "../../utils/node.js";
import type { AgencyConfig } from "../../config.js";
import type { AgencyProgram, AgencyNode } from "../../types.js";
import type { SpliceDiagnostic, SpliceResult } from "./types.js";

/**
 * Splice eligibility: may this generator run at compile time?
 *
 * The import-graph check carries the whole safety argument. Dangerous
 * operations raise effects and effects are statically checkable, but only
 * for Agency code. TypeScript raises nothing, and a plain JS package like
 * `zod` passes through untouched when imported. A generator that can reach
 * `zod` makes the effect check meaningless.
 */

/**
 * Which import edges a generator may have. One line on purpose, since this
 * is the rule a reader checks against the spec.
 *
 * `std::` is allowed but not followed, because it is verified elsewhere. A
 * relative `.agency` file is allowed and followed, which is what makes the
 * check transitive. Everything else leaves Agency, including `pkg::`,
 * which can reach JavaScript one level down.
 */
const isAllowedEdge = (specifier: string): boolean =>
  isStdlibImport(specifier) || isAgencyFilePath(specifier);

/**
 * A path to an Agency source file, relative or absolute.
 *
 * Absolute paths and `../` escapes out of the project both qualify, which
 * is deliberate rather than incidental: anything this accepts is still
 * Agency source, so it still gets walked and checked by everything here.
 * The name says "file path" rather than "relative" so it does not promise
 * a narrowness it has never had.
 */
function isAgencyFilePath(specifier: string): boolean {
  return specifier.endsWith(".agency") && !specifier.includes("::");
}

/** Every import edge declared by one file, unfiltered. */
function importEdgesOf(program: AgencyProgram): string[] {
  return program.nodes
    .map((node: AgencyNode) => agencyImportTarget(node))
    .filter((target): target is string => target !== null);
}

/** Through the shared parse cache, like every other closure walker in the
 *  codebase. These files get parsed several times per splice: once per
 *  check, plus again for the cache fingerprint. */
function parseFileOrNull(absPath: string, config: AgencyConfig): AgencyProgram | null {
  if (!fs.existsSync(absPath)) {
    return null;
  }
  const result = parseAgencyFileCached(absPath, config, true);
  return result.success ? result.result : null;
}

/**
 * Every file a generator can reach through relative `.agency` imports,
 * entry first.
 *
 * Three checks and the cache need this same set and ask different
 * questions of it, so the walk lives here once. `std::` modules are not
 * followed, or every check would drag in most of the standard library.
 *
 * A file that does not exist or does not parse is skipped. Whether that
 * matters is the caller's business.
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
      if (isAgencyFilePath(specifier)) {
        queue.push(path.resolve(path.dirname(current), specifier));
      }
    }
  }
  return found;
}

/**
 * The first import edge that leaves Agency code, or null when every edge is
 * allowed.
 *
 * Transitive is the operative word. A local `.agency` file the generator
 * imports can pull in `zod` one level down while the generator itself
 * looks clean.
 */
export function checkImportGraph(
  entryPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  for (const file of closureFiles(entryPath, config)) {
    const program = parseFileOrNull(file, config);
    if (program === null) {
      continue;
    }
    const escaping = importEdgesOf(program).find(
      (specifier) => !isAllowedEdge(specifier),
    );
    if (escaping !== undefined) {
      return {
        diagnostic: "spliceGeneratorReachesNonAgency",
        params: { name: generatorName, importPath: escaping },
        loc: { line: 0, col: 0, start: 0, end: 0 },
      };
    }
  }
  return null;
}

/**
 * Refuse a generator that can reach any interrupt effect.
 *
 * Two things stop this from being a lookup. It must take a path, never a
 * source string, because `getEffectsFromSource` writes to an empty temp
 * dir where relative imports throw. Worse, effects do not propagate across
 * a module boundary even with a real path (#680):
 *
 *     helper.agency alone      → { h: ["std::read"] }
 *     gen.agency, calling h()  → { g: [] }
 *
 * A generator that delegates its effectful work one file away therefore
 * reports an empty effect list, which reads as safe.
 *
 * So the check walks the closure instead. The generator's own file has an
 * accurate map and is checked by name. Across an import boundary nothing
 * says which exports are reachable, so any effectful export refuses.
 * Replace this with a direct lookup once #680 lands.
 *
 * `everyExport` drops the by-name part for a module that supplies a splice
 * argument. Such a module is not a generator, so there is no single export
 * to name, and every export it has runs when the module is evaluated.
 */
export function checkEffects(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
  everyExport: boolean = false,
): SpliceDiagnostic | null {
  const files = closureFiles(generatorPath, config);
  for (const file of files) {
    // The generator's own file is checked by name. Across an import
    // boundary nothing says which exports are reachable, so any effectful
    // export refuses.
    const named = file === files[0] && !everyExport ? generatorName : null;
    const found = effectsInFile(file, named);
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
 * Effects declared by one file, as a printable list or null for none.
 *
 * `only` names a single export to check; null means every export. Passing
 * a name that the file does not export would silently report nothing, so
 * the all-exports case is its own value rather than an empty string.
 */
function effectsInFile(filePath: string, only: string | null): string | null {
  let byExport: Record<string, string[]>;
  try {
    byExport = getEffectsFromFile(filePath);
  } catch (err) {
    // An unresolvable import or a type error means the effect list cannot
    // be trusted. Fail closed: an unknown answer is not a safe one.
    console.error(`splice eligibility: cannot read effects of ${filePath}:`, err);
    return "unknown";
  }
  const effects =
    only === null ? Object.values(byExport).flat() : (byExport[only] ?? []);
  const unique = effects.filter((name, index) => effects.indexOf(name) === index);
  return unique.length === 0 ? null : unique.sort().join(", ");
}

/**
 * Refuse a generator whose closure contains a splice.
 *
 * Running a generator compiles it, which expands any splice it contains,
 * which runs another generator. That recursion has no floor. Template
 * Haskell forbids the same thing for the same reason.
 *
 * Scanning the closure refuses before anything is compiled, rather than
 * partway into a recursion.
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

/** All four checks, composed. The expansion pass never names an individual
 *  rule, so adding one means adding an entry here. */
export function checkGeneratorEligible(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  const checks = [
    () => checkImportGraph(generatorPath, generatorName, config),
    () => checkNoNestedSplice(generatorPath, generatorName, config),
    () => checkEffects(generatorPath, generatorName, config),
  ];
  return checks.reduce<SpliceDiagnostic | null>(
    (found, check) => found ?? check(),
    null,
  );
}

/**
 * Which module supplies a splice's generator, and under what name.
 *
 * A generator must be imported from another file. It has to be compiled
 * before the file that splices it, so no order works if they share a file.
 * Template Haskell calls this the stage restriction.
 *
 * Returns the module's original exported name, so an aliased import
 * resolves to what the module exports rather than the local spelling.
 */
export function resolveGeneratorModule(
  program: AgencyProgram,
  localName: string,
  hostPath: string,
): SpliceResult<{ modulePath: string; exportedName: string }> {
  const found = resolveImportedName(program, localName, hostPath);
  if (found === null || found.modulePath === null) {
    return {
      ok: false,
      diagnostic: {
        diagnostic: "spliceGeneratorNotImported",
        params: { name: localName },
        loc: { line: 0, col: 0, start: 0, end: 0 },
      },
    };
  }
  return {
    ok: true,
    value: { modulePath: found.modulePath, exportedName: found.exportedName },
  };
}

/** One name the host file imports, and where it comes from. */
export type ImportSource = {
  /** The specifier as written: `./data.agency` or `std::math`. */
  specifier: string;
  /** Absolute path for a file specifier, null for `std::`. */
  modulePath: string | null;
  exportedName: string;
  localName: string;
};

/** Where a name in the host file comes from, or null when nothing imports it. */
export function resolveImportedName(
  program: AgencyProgram,
  localName: string,
  hostPath: string,
): ImportSource | null {
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
          specifier: node.modulePath,
          modulePath: isAgencyFilePath(node.modulePath)
            ? path.resolve(path.dirname(hostPath), node.modulePath)
            : null,
          exportedName,
          localName,
        };
      }
    }
  }
  return null;
}

/**
 * Which exported name does this import group bind to `localName`?
 *
 * `importedNames` holds the original exported names, and `aliases` maps
 * original to local separately. `import { makeGetters as gen }` stores
 * `["makeGetters"]` plus `{ makeGetters: "gen" }`, so reading the
 * specifier list alone matches the wrong spelling.
 *
 * A specifier is a plain string unless a template put an identifier hole
 * there. A hole binds no real name, so it never matches.
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
