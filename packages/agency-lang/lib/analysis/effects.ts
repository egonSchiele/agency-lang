/**
 * Propagating effects along call edges, across files.
 *
 * Runs once at the end of SymbolTable.build over the parse trees the crawl
 * already produced. Reading a single body lives in ./bodyFacts.js; this module
 * is about what travels between bodies.
 */
import { walkNodes } from "../utils/node.js";
import type { AgencyNode } from "../types.js";
import { collectBodyFacts, unique } from "./bodyFacts.js";
import { declaredName } from "../types/hole.js";
import type { AgencyProgram } from "../types.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import type { FunctionSymbol, NodeSymbol, ResolvedImport, SymbolTable } from "../symbolTable.js";

export type PropagationNode = {
  effects: string[];
  /** Keys into the same dictionary. What a key means is the caller's business:
   *  the type checker uses local names, the cross-file pass uses file-and-name
   *  pairs. */
  calleeKeys: string[];
};

/**
 * Give every entry the effects of everything it calls, until nothing more can
 * be learned.
 *
 * Worklist rather than repeated full sweeps. Sweeping was measurably quadratic:
 * on a chain of N functions where only the last one raises, each sweep moves
 * the effect one link, so it takes N sweeps of N entries. Re-queueing only the
 * callers of an entry that grew makes the work proportional to the call edges
 * instead. See lib/perf/symbolTable.perf.test.ts, which measures the chained
 * shape specifically because that is where the difference shows.
 *
 * Terminates because effect lists only grow and the label set is finite, so an
 * entry can be re-queued only finitely often. Returns the object it was given,
 * so a caller can read the result as a value rather than relying on call order.
 */
export function propagateToFixpoint<T extends PropagationNode>(
  nodes: Record<string, T>,
): Record<string, T> {
  const callers = callerIndex(nodes);
  const queue = Object.keys(nodes);
  while (queue.length > 0) {
    const key = queue.pop() as string;
    const node = nodes[key];
    if (!node) continue;
    let grew = false;
    for (const calleeKey of node.calleeKeys) {
      const callee = Object.hasOwn(nodes, calleeKey) ? nodes[calleeKey] : undefined;
      for (const effect of callee?.effects ?? []) {
        if (!node.effects.includes(effect)) {
          node.effects.push(effect);
          grew = true;
        }
      }
    }
    if (grew && Object.hasOwn(callers, key)) {
      queue.push(...callers[key]);
    }
  }
  return nodes;
}

/** Reverse of the call edges: for each entry, who calls it. */
function callerIndex(nodes: Record<string, PropagationNode>): Record<string, string[]> {
  const callers: Record<string, string[]> = Object.create(null);
  for (const [key, node] of Object.entries(nodes)) {
    for (const calleeKey of node.calleeKeys) {
      if (!Object.hasOwn(callers, calleeKey)) callers[calleeKey] = [];
      callers[calleeKey].push(key);
    }
  }
  return callers;
}

/** Where a name is really defined, after renaming and re-export. */
export type Origin = { file: string; name: string };

type EffectSummary = PropagationNode & Origin;

/** Two files can define the same top-level name and an import can rename one,
 *  so a bare name is not an identity. NUL separates because it cannot occur in
 *  a path or an identifier; a space can, and would let distinct pairs collide.
 *  The key is never parsed back apart — every summary carries its own file and
 *  name. */
function keyOf(origin: Origin): string {
  return `${origin.file}\u0000${origin.name}`;
}

function summaryAt(
  summaries: Record<string, EffectSummary>,
  origin: Origin,
): EffectSummary | undefined {
  const key = keyOf(origin);
  return Object.hasOwn(summaries, key) ? summaries[key] : undefined;
}

/**
 * Make each callable's recorded effects include everything it can reach by
 * calling, not just what its own body raises.
 *
 * Runs once at the end of SymbolTable.build, over the parse trees the crawl
 * already produced. Before this existed, an imported function arrived at the
 * type checker as a leaf: `h` wrapping `read` reported nothing, and so did
 * `agency policy gen` for a program that reads your filesystem through it.
 * GitHub issue 680.
 */
export function propagateEffects(
  table: SymbolTable,
  programs: Record<string, AgencyProgram>,
): void {
  writeBack(table, propagateToFixpoint(buildSummaries(table, programs)));
}

function buildSummaries(
  table: SymbolTable,
  programs: Record<string, AgencyProgram>,
): Record<string, EffectSummary> {
  // Null prototype and Object.hasOwn on read: keys are user-controlled file
  // paths and symbol names. House pattern, as in TS_SIDE_EFFECT_SEEDS.
  return Object.assign(
    Object.create(null),
    Object.fromEntries(
      Object.entries(programs)
        .flatMap(([file, program]) => summariesForFile(table, program, file))
        .map((summary) => [keyOf(summary), summary]),
    ),
  );
}

type CallableDeclaration = FunctionDefinition | GraphNodeDefinition;

const isCallableDeclaration = (node: AgencyNode): node is CallableDeclaration =>
  node.type === "function" || node.type === "graphNode";

/**
 * One summary per callable declaration in one file.
 *
 * Agency has no nested `def`, so top-level functions and graph nodes are the
 * whole set. The type checker additionally has scopes for block arguments and
 * inline handler bodies; those are file-local and can never be imported, so
 * they need no entry here.
 */
function summariesForFile(
  table: SymbolTable,
  program: AgencyProgram,
  file: string,
): EffectSummary[] {
  const resolve = makeResolver(table, program, file);
  return [...walkNodes(program.nodes)]
    .map((visit) => visit.node)
    .filter(isCallableDeclaration)
    .map((declaration) => {
      const name = declaredName(
        declaration.type === "function" ? declaration.functionName : declaration.nodeName,
      );
      return {
        file,
        name,
        effects: directEffectsOf(table, file, name),
        calleeKeys: collectBodyFacts(declaration.body).callees.map((callee) =>
          keyOf(resolve(callee)),
        ),
      };
    });
}

/** What classifySymbols already worked out, including the seed table. Read
 *  rather than recomputed: _guard raises on the TypeScript side and has no
 *  `interrupt` in its body, so a body walk would report nothing for it. */
function directEffectsOf(table: SymbolTable, file: string, name: string): string[] {
  const sym = table.getFile(file)?.[name];
  if (!sym || (sym.kind !== "function" && sym.kind !== "node")) return [];
  return (sym.interruptEffects ?? []).map((entry) => entry.effect);
}

function writeBack(table: SymbolTable, summaries: Record<string, EffectSummary>): void {
  for (const { file, name, sym } of callableSymbols(table)) {
    // Resolve through re-exports so a barrel's own copy of a name gets the
    // origin's answer rather than an empty one.
    const summary = summaryAt(summaries, originOf(table, { file, name }));
    if (!summary) continue;
    sym.interruptEffects = summary.effects.map((effect) => ({ effect }));
  }
}

type CallableSymbol = Origin & { sym: FunctionSymbol | NodeSymbol };

/** Every function and node symbol in the table, tagged with where it lives. */
function callableSymbols(table: SymbolTable): CallableSymbol[] {
  return table.filePaths().flatMap((file) =>
    Object.entries(table.getFile(file) ?? {})
      .filter(
        (entry): entry is [string, FunctionSymbol | NodeSymbol] =>
          entry[1].kind === "function" || entry[1].kind === "node",
      )
      .map(([name, sym]) => ({ file, name, sym })),
  );
}

/** Map a local callee name, as written at a call site in `fromFile`, to where it
 *  is really defined. Falls back to the current file for builtins and unknown
 *  names, which then find no summary. */
function makeResolver(
  table: SymbolTable,
  program: AgencyProgram,
  fromFile: string,
): (localName: string) => Origin {
  const imported: Record<string, Origin> = Object.assign(
    Object.create(null),
    Object.fromEntries(
      importsOf(table, program, fromFile).map((resolved) => [
        resolved.localName,
        originOf(table, { file: resolved.file, name: resolved.originalName }),
      ]),
    ),
  );
  return (localName) =>
    Object.hasOwn(imported, localName) ? imported[localName] : { file: fromFile, name: localName };
}

/**
 * Every named symbol this file imports, from both import forms.
 *
 * Resolution can throw — an uninstalled `pkg::` module makes
 * `resolveAgencyImportPath` fail. The crawl that produced these parse trees
 * skips such an import and keeps going (SymbolTable.build's `visitImport`),
 * so this must too, or a program with one uninstalled package would lose the
 * effects of every other import in the same file.
 */
function importsOf(table: SymbolTable, program: AgencyProgram, fromFile: string): ResolvedImport[] {
  return [...walkNodes(program.nodes)].flatMap(({ node }) => {
    try {
      if (node.type === "importStatement") {
        return table.resolveImport(node, fromFile);
      }
      if (node.type === "importNodeStatement") {
        return table.resolveImportedNodes(node, fromFile);
      }
    } catch {
      /* unresolvable import path — reported downstream by resolveImports and
         the type checker's checkMissingImports, with a location, not here */
    }
    return [];
  });
}

/**
 * Follow `reExportedFrom` to where a name is really defined. A barrel can
 * re-export a barrel, so this repeats.
 *
 * No depth guard: SymbolTable.build already detects a re-export cycle and
 * throws with the chain in the message, before this runs.
 */
export function originOf(table: SymbolTable, at: Origin): Origin {
  const sym = table.getFile(at.file)?.[at.name];
  const from = sym && "reExportedFrom" in sym ? sym.reExportedFrom : undefined;
  return from ? originOf(table, { file: from.sourceFile, name: from.originalName }) : at;
}

/**
 * Every name this file can call: the functions and nodes it declares, plus
 * every imported name that resolves to one.
 *
 * The file's own symbols are not enough — `read` reaches a file through the
 * injected prelude import, so a check that only looked locally would decide
 * `read` is not callable.
 */
export function callableNamesIn(
  table: SymbolTable,
  program: AgencyProgram,
  file: string,
): string[] {
  const local = Object.entries(table.getFile(file) ?? {})
    .filter(([, sym]) => sym.kind === "function" || sym.kind === "node")
    .map(([name]) => name);
  const imported = importsOf(table, program, file)
    .filter((resolved) => resolved.symbol.kind === "function" || resolved.symbol.kind === "node")
    .map((resolved) => resolved.localName);
  return unique([...local, ...imported]);
}

/**
 * Every function the given one can reach by calling, itself included.
 *
 * Scoped by call graph rather than by file on purpose. Every file reaches the
 * prelude and passing a function as a value is ordinary Agency, so a
 * file-scoped rule would refuse every generator ever written.
 */
export function reachableFrom(
  table: SymbolTable,
  programs: Record<string, AgencyProgram>,
  start: Origin,
): Origin[] {
  const summaries = buildSummaries(table, programs);
  const seen: Record<string, true> = Object.create(null);
  const found: Origin[] = [];
  const queue: string[] = [keyOf(originOf(table, start))];

  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (Object.hasOwn(seen, key)) continue;
    seen[key] = true;
    const summary = Object.hasOwn(summaries, key) ? summaries[key] : undefined;
    if (!summary) continue;
    found.push({ file: summary.file, name: summary.name });
    queue.push(...summary.calleeKeys);
  }
  return found;
}
