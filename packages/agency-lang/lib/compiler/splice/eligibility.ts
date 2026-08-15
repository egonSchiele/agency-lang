import path from "node:path";
import fs from "node:fs";
import { parseAgencyFileCached } from "../../parseCache.js";
import { agencyImportTarget } from "../compileClosure.js";
import { isStdlibImport } from "../../importPaths.js";
import { walkNodesArray } from "../../utils/node.js";
import type { AgencyConfig } from "../../config.js";
import type { AgencyProgram, AgencyNode } from "../../types.js";
import type { SpliceDiagnostic, SpliceResult } from "./types.js";
import { checkGeneratorEffects } from "./generatorEffects.js";
import type { SymbolTable } from "../../symbolTable.js";

/**
 * Working out which module supplies a splice's generator, and deciding
 * whether that generator may run.
 *
 * Two rules gate it: a generator may not contain a splice of its own, and
 * its imports must stay inside Agency. See `checkGeneratorEligible`.
 *
 * Effects are not checked here. A generator that reaches a dangerous
 * operation is stopped while running instead, because compilation installs
 * no interrupt handlers and the operation cannot complete without one.
 */

/**
 * A path to an Agency source file, relative or absolute.
 *
 * Absolute paths and `../` escapes out of the project both qualify, which
 * is deliberate rather than incidental: anything this accepts is still
 * Agency source, so it still gets walked and checked by everything here.
 * The name says "file path" rather than "relative" so it does not promise
 * a narrowness it has never had.
 */
export function isAgencyFilePath(specifier: string): boolean {
  return specifier.endsWith(".agency") && !specifier.includes("::");
}

/** Every import edge declared by one file, unfiltered. */
export function importEdgesOf(program: AgencyProgram): string[] {
  return program.nodes
    .map((node: AgencyNode) => agencyImportTarget(node))
    .filter((target): target is string => target !== null);
}

/** Through the shared parse cache, like every other closure walker in the
 *  codebase. These files get parsed several times per splice: once per
 *  check, plus again for the cache fingerprint. */
export function parseFileOrNull(absPath: string, config: AgencyConfig): AgencyProgram | null {
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
export function closureFiles(entryPath: string, config: AgencyConfig = {}): string[] {
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
 * Which import edges a generator may have, by default.
 *
 * One line on purpose, because it is the rule a reader checks against the
 * documentation. `std::` is Agency and is verified elsewhere, so it is
 * allowed but not followed. A relative `.agency` file is Agency code, so
 * it is allowed and followed, which is what makes the check transitive.
 * Everything else leaves Agency: npm packages, and `pkg::`, which is
 * Agency source but can reach JavaScript one level down.
 */
const isAllowedEdge = (specifier: string): boolean =>
  isStdlibImport(specifier) || isAgencyFilePath(specifier);

/**
 * The first import that leaves Agency code, or null when every edge is
 * allowed.
 *
 * This is what makes the safety story mean anything. Dangerous operations
 * raise interrupts, compilation installs no handlers, so an operation
 * cannot complete. That reasoning holds only for Agency code. JavaScript
 * raises nothing, so a generator that reaches an npm package is neither
 * checked before it runs nor stopped while running.
 *
 * Transitive is the operative word. A local `.agency` file the generator
 * imports can pull in `zod` one level down while the generator itself
 * looks spotless.
 *
 * Users who need a generator to reach JavaScript can turn this off with
 * `allowNonAgencyGenerators` in their config.
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
    const escaping = importEdgesOf(program).find((specifier) => !isAllowedEdge(specifier));
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
 * Refuse a generator whose own file contains a splice.
 *
 * Running a generator compiles it, which expands any splice it contains,
 * which runs another generator. That recursion has no floor. Template
 * Haskell forbids the same thing for the same reason.
 *
 * Only the generator's own file is scanned. This exists to stop runaway
 * recursion, and one level is enough: a file one import away gets the same
 * check when it is itself used as a generator.
 */
export function checkNoNestedSplice(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  const program = parseFileOrNull(path.resolve(generatorPath), config);
  const hasSplice =
    program !== null &&
    [...walkNodesArray(program.nodes)].some((visit) => visit.node.type === "splice");
  return hasSplice
    ? {
        diagnostic: "spliceNested",
        params: { name: generatorName, path: generatorPath },
        loc: { line: 0, col: 0, start: 0, end: 0 },
      }
    : null;
}

/**
 * Everything that gates a generator before it runs.
 *
 * Two rules. A generator may not contain a splice of its own, or running
 * it would recurse without a floor. And its imports must stay inside
 * Agency, unless the user opts out.
 *
 * There is deliberately no static effect check here. The
 * unhandled-interrupt backstop already stops an effectful generator, and
 * a static version cannot be precise while issue #680 stands, because
 * effects do not propagate across a module boundary. To fail closed it
 * would have to refuse a generator whenever any export anywhere in its
 * closure raised, which rejects a generator that uses one harmless helper
 * from a file that happens to contain an effectful one. Tracked as #691.
 */
export function checkGeneratorEligible(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
  symbolTable?: SymbolTable,
): SpliceDiagnostic | null {
  const checks = [
    () => checkNoNestedSplice(generatorPath, generatorName, config),
    () =>
      config.allowNonAgencyGenerators === true
        ? null
        : checkImportGraph(generatorPath, generatorName, config),
    () => checkGeneratorEffects(generatorPath, generatorName, config, symbolTable),
  ];
  return checks.reduce<SpliceDiagnostic | null>((found, check) => found ?? check(), null);
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
