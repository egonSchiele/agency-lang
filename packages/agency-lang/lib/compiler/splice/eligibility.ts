import path from "node:path";
import fs from "node:fs";
import { parseAgencyFileCached } from "../../parseCache.js";
import { agencyImportTarget } from "../compileClosure.js";
import { isStdlibImport } from "../../importPaths.js";
import { walkNodesArray } from "../../utils/node.js";
import type { AgencyConfig } from "../../config.js";
import type { AgencyProgram, AgencyNode } from "../../types.js";
import type { SpliceDiagnostic, SpliceResult } from "./types.js";
import { SymbolTable } from "../../symbolTable.js";
import { collectBodyFacts, reachableFrom } from "../../analysis/effects.js";
import { declaredName } from "../../types/hole.js";
import type { Hole } from "../../types/hole.js";
import type { FunctionDefinition } from "../../types/function.js";
import type { GraphNodeDefinition } from "../../types/graphNode.js";

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
/**
 * Refuse a generator that can reach a risky operation, and refuse one whose
 * effects cannot be read at all.
 *
 * The second half carries the weight. The effect walk reads syntax, so it
 * cannot see through a compile-time splice, a function received as a parameter,
 * a function reference held in a variable, or a file that did not parse. An
 * empty list from a reading that saw none of those is not evidence of safety.
 *
 * Scoped to what the generator reaches BY CALLING. Every file reaches the
 * prelude and passing a function as a value is ordinary Agency, so a
 * file-scoped rule would refuse every generator, which is the same objection
 * the comment on checkGeneratorEligible raises against a whole-closure test.
 */
export function checkGeneratorEffects(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
  symbolTable?: SymbolTable,
): SpliceDiagnostic | null {
  const absolute = path.resolve(generatorPath);
  const table = symbolTable ?? SymbolTable.build(absolute, config);
  const symbol = table.getFile(absolute)?.[generatorName];
  if (!symbol || (symbol.kind !== "function" && symbol.kind !== "node")) {
    return refusal(generatorName, "its definition could not be found");
  }

  const effect = (symbol.interruptEffects ?? [])[0]?.effect;
  if (effect !== undefined) {
    return {
      diagnostic: "spliceGeneratorRaises",
      params: { name: generatorName, effect },
      loc: { line: 0, col: 0, start: 0, end: 0 },
    };
  }

  const blindSpot = firstBlindSpot(table, absolute, generatorName, config);
  return blindSpot === null ? null : refusal(generatorName, blindSpot);
}

function refusal(name: string, reason: string): SpliceDiagnostic {
  return {
    diagnostic: "spliceGeneratorUnreadable",
    params: { name, reason },
    loc: { line: 0, col: 0, start: 0, end: 0 },
  };
}

/** The first relative `.agency` file the generator can reach that does not
 *  parse. closureFiles cannot answer this: it drops a file it cannot parse
 *  rather than reporting it, which is right for its own callers and wrong
 *  here, where an unreadable file is the whole point. */
function firstUnparseableImport(
  generatorFile: string,
  config: AgencyConfig,
): string | null {
  const reachable = [path.resolve(generatorFile), ...closureFiles(generatorFile, config)];
  for (const file of reachable) {
    const program = parseFileOrNull(file, config);
    if (program === null) return file;
    const broken = importEdgesOf(program)
      .filter(isAgencyFilePath)
      .map((specifier) => path.resolve(path.dirname(file), specifier))
      .find((target) => parseFileOrNull(target, config) === null);
    if (broken !== undefined) return broken;
  }
  return null;
}

/** The first reason the effect reading is incomplete, or null when the whole
 *  call graph could be read. Each reason names the file or function so the
 *  user can go and look. */
function firstBlindSpot(
  table: SymbolTable,
  generatorFile: string,
  generatorName: string,
  config: AgencyConfig,
): string | null {
  const programs = programsFor(table, config);
  const unreadable = firstUnparseableImport(generatorFile, config);
  if (unreadable !== null) {
    return `it reaches ${path.basename(unreadable)}, which does not parse`;
  }
  for (const reached of reachableFrom(table, programs, {
    file: generatorFile,
    name: generatorName,
  })) {
    const program = programs[reached.file];
    const declaration = program && declarationOf(program, reached.name);
    if (!declaration) continue;
    const reason = blindSpotIn(declaration, path.basename(reached.file));
    if (reason !== null) return reason;
  }
  return null;
}

/** What this one declaration hides from a syntax-only reading. */
function blindSpotIn(
  declaration: FunctionDefinition | GraphNodeDefinition,
  fileLabel: string,
): string | null {
  const nodes = [...walkNodesArray(declaration.body)].map((visit) => visit.node);
  if (nodes.some((node) => node.type === "splice")) {
    return `it reaches ${fileLabel}, which contains a compile-time splice`;
  }
  const parameterNames = (declaration.parameters ?? []).map(
    (parameter) => parameter.name,
  );
  const facts = collectBodyFacts(declaration.body);
  const throughParameter = facts.callees.find((callee) =>
    parameterNames.includes(callee),
  );
  if (throughParameter !== undefined) {
    return `it reaches ${declaredName(nameOf(declaration))}, which calls '${throughParameter}', a function it received as a parameter`;
  }
  const held = heldFunctionReference(declaration, facts.callees);
  if (held !== null) {
    return `it reaches ${declaredName(nameOf(declaration))}, which passes '${held}' through a variable`;
  }
  return null;
}

function nameOf(
  declaration: FunctionDefinition | GraphNodeDefinition,
): string | Hole {
  return declaration.type === "function"
    ? declaration.functionName
    : declaration.nodeName;
}

/** A local that is assigned a bare name and then handed to a call. The walk
 *  cannot tell whether that name is a function, so what the call does is
 *  unknown. */
function heldFunctionReference(
  declaration: FunctionDefinition | GraphNodeDefinition,
  callees: string[],
): string | null {
  const assignedNames: Record<string, string> = Object.create(null);
  for (const { node } of walkNodesArray(declaration.body)) {
    if (node.type !== "assignment") continue;
    const value = node.value;
    if (value && value.type === "variableName" && !callees.includes(value.value)) {
      assignedNames[node.variableName] = value.value;
    }
  }
  for (const { node } of walkNodesArray(declaration.body)) {
    if (node.type !== "functionCall") continue;
    for (const argument of node.arguments) {
      if (
        argument.type === "variableName" &&
        Object.hasOwn(assignedNames, argument.value)
      ) {
        return argument.value;
      }
    }
  }
  return null;
}

function declarationOf(
  program: AgencyProgram,
  name: string,
): FunctionDefinition | GraphNodeDefinition | null {
  for (const { node } of walkNodesArray(program.nodes)) {
    if (node.type !== "function" && node.type !== "graphNode") continue;
    if (declaredName(nameOf(node)) === name) return node;
  }
  return null;
}

/** The parse tree of every file the table crawled, keyed by path. */
function programsFor(
  table: SymbolTable,
  config: AgencyConfig,
): Record<string, AgencyProgram> {
  const programs: Record<string, AgencyProgram> = Object.create(null);
  for (const file of table.filePaths()) {
    const program = parseFileOrNull(file, config);
    if (program !== null) programs[file] = program;
  }
  return programs;
}

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
    () =>
      checkGeneratorEffects(generatorPath, generatorName, config, symbolTable),
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
