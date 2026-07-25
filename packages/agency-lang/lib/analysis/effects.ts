/**
 * How an interrupt-effect list is computed. One module, because two copies of
 * this drifted apart and an effect came to mean different things on either
 * side of an import — GitHub issue 680.
 *
 * Two things live here: reading one body, and propagating along call edges.
 * The type checker adds type-aware work on top of the first and must never
 * subtract from it.
 */
import { walkNodes, type WalkAncestor } from "../utils/node.js";
import type { AgencyNode } from "../types.js";
import type { FunctionCall } from "../types/function.js";
import type { ValueAccess } from "../types/access.js";
import type { InterruptStatement } from "../types/interruptStatement.js";
import type { GotoStatement } from "../types/gotoStatement.js";
import { declaredName } from "../types/hole.js";
import type { AgencyProgram } from "../types.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import type {
  FunctionSymbol,
  NodeSymbol,
  ResolvedImport,
  SymbolTable,
} from "../symbolTable.js";

export type BodyFacts = {
  /** Effect labels raised by a literal `interrupt` in this body. */
  effects: string[];
  /** Local names of everything this body calls, unresolved. */
  callees: string[];
  /** Every call node seen. Handed back so the type checker can read call
   *  arguments without walking the body a second time. */
  calls: FunctionCall[];
};

/** One yielded step of the walk. walkNodes also hands back `scopes`, which
 *  nothing here needs. */
type Visit = { node: AgencyNode; ancestors: WalkAncestor[] };

const isInterrupt = (
  visit: Visit,
): visit is Visit & { node: InterruptStatement } =>
  visit.node.type === "interruptStatement";

const isCall = (visit: Visit): visit is Visit & { node: FunctionCall } =>
  visit.node.type === "functionCall";

const isGoto = (visit: Visit): visit is Visit & { node: GotoStatement } =>
  visit.node.type === "gotoStatement";

/** A guard becomes a `_guard` call in the TypeChecker constructor. The symbol
 *  table walks the tree before that, so the call is not there yet. */
const isGuard = (visit: Visit): boolean => visit.node.type === "guardBlock";

export function collectBodyFacts(body: AgencyNode[]): BodyFacts {
  const visits: Visit[] = [...walkNodes(body)];
  const calls = visits.filter(isCall);
  return {
    effects: unique(
      visits.filter(isInterrupt).map((visit) => visit.node.effect),
    ),
    callees: unique([
      ...visits.filter(isGuard).map(() => "_guard"),
      ...calls
        .map((visit) => calledName(visit.node, visit.ancestors))
        .filter((name): name is string => name !== null),
      ...visits.filter(isGoto).map((visit) => visit.node.nodeCall.functionName),
    ]),
    calls: calls.map((visit) => visit.node),
  };
}

/**
 * The name a call site names, or null when it names nothing this analysis can
 * use.
 *
 * A plain `g(...)` names `g`. A method call inside an access chain does not
 * name a global function at all — `xs.map(...)` calls a method on a value, and
 * recording `map` would collide with any global of that name. The type checker
 * excludes these for the same reason (functionTypeRaises.ts:106).
 *
 * `.invoke()` is the exception, because it means "call the receiver", and it
 * is the call form this project's style prefers. See invokeReceiver.
 */
export function calledName(
  node: FunctionCall,
  ancestors: WalkAncestor[],
): string | null {
  const access = enclosingAccess(node, ancestors);
  if (!access) return node.functionName;
  return node.functionName === "invoke" ? invokeReceiver(node, access) : null;
}

/**
 * The function `x.invoke(...)` actually calls.
 *
 * Attributes to the base only when every chain link before `invoke` is itself a
 * method call. `f.partial(method: "GET").invoke()` still calls `f`, because
 * `partial` and `rename` return a derived version of the same function. But
 * `obj.handler.invoke()` calls whatever `obj.handler` holds, and a `property`
 * link in the chain means the receiver is a path this analysis cannot resolve
 * without types.
 */
function invokeReceiver(node: FunctionCall, access: ValueAccess): string | null {
  if (access.base.type !== "variableName") return null;
  const index = access.chain.findIndex(
    (link) => link.kind === "methodCall" && link.functionCall === node,
  );
  const reachesBase = access.chain
    .slice(0, index)
    .every((link) => link.kind === "methodCall");
  return reachesBase ? access.base.value : null;
}

/**
 * The access chain this call is a link of, or null when the call stands alone.
 *
 * Scans the ancestors backwards rather than trusting the last one, because
 * walkNodes descends an assignment's own access chain passing the assignment as
 * the ancestor, so the access is not always adjacent. Identity of the call node
 * is what distinguishes the link we are standing on from its neighbours.
 */
function enclosingAccess(
  node: FunctionCall,
  ancestors: WalkAncestor[],
): ValueAccess | null {
  const access = [...ancestors]
    .reverse()
    .filter(
      (ancestor): ancestor is ValueAccess => ancestor.type === "valueAccess",
    )
    .find((candidate) =>
      candidate.chain.some(
        (link) => link.kind === "methodCall" && link.functionCall === node,
      ),
    );
  return access ?? null;
}

export type PropagationNode = {
  effects: string[];
  /** Keys into the same dictionary. What a key means is the caller's business:
   *  the type checker uses local names, the cross-file pass uses file-and-name
   *  pairs. */
  calleeKeys: string[];
};

/**
 * Give every entry the effects of everything it calls, repeatedly, until a full
 * round changes nothing.
 *
 * Terminates because effect lists only grow and the label set is finite. A
 * cycle just costs one extra round. Returns the same object it was given, so a
 * caller can read the result as a value rather than relying on call order.
 */
export function propagateToFixpoint<T extends PropagationNode>(
  nodes: Record<string, T>,
): Record<string, T> {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of Object.values(nodes)) {
      for (const key of node.calleeKeys) {
        const callee = Object.hasOwn(nodes, key) ? nodes[key] : undefined;
        for (const effect of callee?.effects ?? []) {
          if (!node.effects.includes(effect)) {
            node.effects.push(effect);
            changed = true;
          }
        }
      }
    }
  }
  return nodes;
}

/** Deduplicate, preserving first-seen order. The declarative counterpart to
 *  addUnique, for code that builds a list rather than growing one. */
export function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** Grow a list in place. Kept for the fixpoint and for the type checker's
 *  handler analysis, which accumulate rather than build. */
export function addUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

/** Where a name is really defined, after renaming and re-export. */
export type Origin = { file: string; name: string };

type EffectSummary = PropagationNode & Origin;

/** Two files can define the same top-level name and an import can rename one,
 *  so a bare name is not an identity. The key is never parsed back apart —
 *  every summary carries its own file and name. */
function keyOf(origin: Origin): string {
  return `${origin.file} ${origin.name}`;
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
        declaration.type === "function"
          ? declaration.functionName
          : declaration.nodeName,
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
function directEffectsOf(
  table: SymbolTable,
  file: string,
  name: string,
): string[] {
  const sym = table.getFile(file)?.[name];
  if (!sym || (sym.kind !== "function" && sym.kind !== "node")) return [];
  return (sym.interruptEffects ?? []).map((entry) => entry.effect);
}

function writeBack(
  table: SymbolTable,
  summaries: Record<string, EffectSummary>,
): void {
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
    Object.hasOwn(imported, localName)
      ? imported[localName]
      : { file: fromFile, name: localName };
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
function importsOf(
  table: SymbolTable,
  program: AgencyProgram,
  fromFile: string,
): ResolvedImport[] {
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
  return from
    ? originOf(table, { file: from.sourceFile, name: from.originalName })
    : at;
}
