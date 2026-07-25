import path from "node:path";
import fs from "node:fs";
import { parseAgency } from "../../parser.js";
import { agencyImportTarget } from "../compileClosure.js";
import { isStdlibImport } from "../../importPaths.js";
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
