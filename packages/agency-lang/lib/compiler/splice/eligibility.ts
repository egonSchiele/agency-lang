import path from "node:path";
import fs from "node:fs";
import { parseAgencyFileCached } from "../../parseCache.js";
import { agencyImportTarget } from "../compileClosure.js";
import { walkNodesArray } from "../../utils/node.js";
import type { AgencyConfig } from "../../config.js";
import type { AgencyProgram, AgencyNode } from "../../types.js";
import type { SpliceDiagnostic, SpliceResult } from "./types.js";

/**
 * Resolving a splice's generator, and the one structural rule left on it.
 *
 * Safety is the unhandled-interrupt backstop's job: compilation installs no
 * handlers, so a generator that reaches a dangerous operation cannot
 * complete. The static effect and import-graph checks that used to live
 * here were removed; see `checkGeneratorEligible` for why.
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
 * What still gates a generator, now that effect and import-graph checking
 * are gone.
 *
 * Both were removed deliberately. The unhandled-interrupt backstop already
 * stops an effectful generator: compilation installs no handlers, so the
 * operation cannot complete. The static version could not be made precise
 * while #680 stands, and a check that refuses a generator over an
 * unrelated export in a helper file is hard to justify when the runtime
 * already covers the case. Tracked as #691; the import restriction returns
 * as `--only-stdlib` in #690.
 */
export function checkGeneratorEligible(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
): SpliceDiagnostic | null {
  return checkNoNestedSplice(generatorPath, generatorName, config);
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
