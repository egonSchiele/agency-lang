import { readFileSync } from "fs";
import path from "path";
import { parseAgency } from "@/parser.js";
import { SymbolTable } from "@/symbolTable.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { liftCallbackBlocks } from "@/preprocessors/liftCallbacks.js";
import { typeCheck } from "@/typeChecker/index.js";
import { getStdlibDir } from "@/importPaths.js";
import type { AgencyConfig } from "@/config.js";
import type {
  InterruptCallGraph,
  QualifiedKey,
  TaggedHandler,
} from "@/typeChecker/interruptAnalysis.js";
import type { InterruptStatement } from "@/types/interruptStatement.js";

// -- Public types --

/**
 * One interrupt site: a single `interruptStatement` AST node, located by
 * (file, line, effect). `line` is **1-indexed** for human consumption (the
 * parser stores 0-indexed lines, so we add 1 when building this shape).
 */
export type InterruptSite = {
  file: string;
  /** 1-indexed line number of the `interrupt …` statement. */
  line: number;
  /** Interrupt effect, e.g. `"std::read"`. `"unknown"` for the bare
   *  `interrupt(...)` form. */
  effect: string;
};

/**
 * One handler reference, ready for rendering. `line` is **1-indexed**.
 */
export type HandlerRef = {
  file: string;
  /** 1-indexed line of the `handle {` block. */
  line: number;
  shape: "inline" | "functionRef";
  /** Present iff `shape === "functionRef"`. */
  functionName?: string;
};

/** The final per-site result. */
export type SiteResult = {
  site: InterruptSite;
  /** Deduped handler set. May be empty. */
  handlers: HandlerRef[];
};

export type AnalysisResult = {
  /** Sorted by `site.file`, then `site.line`. */
  sites: SiteResult[];
};

// -- Top-level entry point --
//
// Declarative pipeline: load → collect sites → propagate → union → render.
// Each phase is a named helper; this function is the "what".

export function analyzeInterrupts(
  rootFile: string,
  config: AgencyConfig,
): AnalysisResult {
  const cg = loadCallGraph(rootFile, config);
  const sites = collectAllSites(cg);
  const reachableHandlers = propagateHandlers(cg);
  const perSite = unionAcrossEntries(reachableHandlers, collectEntries(cg));
  return buildResult(sites, perSite);
}

// -- Phase 1: Load --
//
// The typechecker only sees the entry file's local definitions in
// `scopes`; imported functions live in `importedFunctions` (signatures
// only, no body). To analyze interrupt sites across the import tree we
// build the symbol table once and then run the typechecker on every
// reachable .agency file, merging the resulting call graphs. Each
// call-graph entry is keyed by its `${file}:${name}` `QualifiedKey`,
// so two files that happen to declare the same top-level name produce
// distinct entries and `Object.assign` cannot accidentally overwrite
// one with the other.

function loadCallGraph(rootFile: string, config: AgencyConfig): InterruptCallGraph {
  const absPath = path.resolve(rootFile);
  const symbolTable = SymbolTable.build(absPath, config);
  const merged: InterruptCallGraph = {};
  for (const filePath of symbolTable.filePaths()) {
    const cg = analyzeOneFile(filePath, symbolTable, config);
    Object.assign(merged, cg);
  }
  return merged;
}

function analyzeOneFile(
  filePath: string,
  symbolTable: SymbolTable,
  config: AgencyConfig,
): InterruptCallGraph {
  const source = readFileSync(filePath, "utf-8");
  const parseResult = parseAgency(source, config);
  if (!parseResult.success) {
    throw new Error(`Failed to parse ${filePath}`);
  }
  const lifted = liftCallbackBlocks(parseResult.result);
  const info = buildCompilationUnit(lifted, symbolTable, filePath, source);
  return typeCheck(lifted, config, info).interruptCallGraph;
}

// -- Phase 2: Site collection --

type SiteId = string;
type SiteRecord = { site: InterruptStatement; file: string };

function siteKey(file: string, site: InterruptStatement): SiteId {
  return `${file}:${site.loc?.line ?? 0}:${site.loc?.col ?? 0}`;
}

function collectAllSites(cg: InterruptCallGraph): Map<SiteId, SiteRecord> {
  const entries = Object.values(cg).flatMap((fn) => fn.interruptSites);
  return new Map(
    entries.map((e) => [siteKey(e.file, e.site), { site: e.site, file: e.file }]),
  );
}

// -- Phase 3: Fixed-point handler propagation --
//
// For each function f and each interrupt site s reachable from f, the set
// of handle blocks that could enclose s on a control-flow path starting
// at f. Inner map keyed by HandleBlock object identity for dedup.

type HandlerSet = Map<unknown, TaggedHandler>;
/** Keyed by the caller's `QualifiedKey` → siteKey → handler set. */
type ReachableHandlers = Record<QualifiedKey, Record<SiteId, HandlerSet>>;

function propagateHandlers(cg: InterruptCallGraph): ReachableHandlers {
  const state = seedFromDirectSites(cg);
  runFixedPoint(state, cg);
  return state;
}

function seedFromDirectSites(cg: InterruptCallGraph): ReachableHandlers {
  const state: ReachableHandlers = {};
  for (const key of Object.keys(cg)) state[key] = {};
  for (const [key, fn] of Object.entries(cg)) {
    for (const entry of fn.interruptSites) {
      state[key][siteKey(entry.file, entry.site)] = handlerSetFrom(entry.enclosingHandlers);
    }
  }
  return state;
}

function runFixedPoint(state: ReachableHandlers, cg: InterruptCallGraph): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, fn] of Object.entries(cg)) {
      for (const edge of fn.callEdges) {
        if (propagateEdge(state, key, edge)) changed = true;
      }
    }
  }
}

function propagateEdge(
  state: ReachableHandlers,
  callerKey: QualifiedKey,
  edge: InterruptCallGraph[string]["callEdges"][number],
): boolean {
  const calleeState = state[edge.calleeKey];
  if (!calleeState) return false;
  let grew = false;
  for (const [sid, calleeHandlers] of Object.entries(calleeState)) {
    // Reaching a new site for `callerKey` is itself growth — even if the
    // merged handler set is empty, we now know `callerKey` can reach
    // `sid`, which means its callers will see this site on the next
    // pass. Without this, a chain `main → a1 → shared` where `shared`
    // has an unhandled interrupt fails to propagate, because the empty
    // handler set on each hop would otherwise be reported as "not grown".
    const isNewSite = !(sid in state[callerKey]);
    const merged = mergeHandlers(state[callerKey][sid], calleeHandlers, edge.enclosingHandlers);
    if (isNewSite || merged.grew) {
      state[callerKey][sid] = merged.set;
      grew = true;
    }
  }
  return grew;
}

function handlerSetFrom(handlers: TaggedHandler[]): HandlerSet {
  return new Map(handlers.map((th) => [th.block, th]));
}

function mergeHandlers(
  existing: HandlerSet | undefined,
  fromCallee: HandlerSet,
  fromEdge: TaggedHandler[],
): { set: HandlerSet; grew: boolean } {
  const out: HandlerSet = new Map(existing ?? []);
  const before = out.size;
  for (const [k, v] of fromCallee) out.set(k, v);
  for (const th of fromEdge) out.set(th.block, th);
  return { set: out, grew: out.size !== before };
}

// -- Phase 4: Entry detection + union across entries --
//
// Every non-stdlib function/node in the merged call graph is treated as
// an "entry" — i.e. its reachable handler state contributes to the final
// per-site union. We deliberately do NOT restrict to scopes with no
// incoming call edges: that definition would drop mutually-recursive
// groups (every member has an incoming edge from within the cycle) and
// other disconnected components whose external caller hasn't yet been
// added to the graph, silently omitting their interrupt sites from the
// report. Filtering by stdlib is sufficient to keep stdlib-only sites
// out of the output. Stdlib functions can still be CALLEES — when
// reached from a user entry, their sites propagate normally through
// the graph.

function collectEntries(cg: InterruptCallGraph): QualifiedKey[] {
  const stdlibDir = getStdlibDir();
  return Object.keys(cg).filter((key) => {
    const file = cg[key].file;
    if (file && isInStdlib(file, stdlibDir)) return false;
    return true;
  });
}

function isInStdlib(filePath: string, stdlibDir: string): boolean {
  const rel = path.relative(stdlibDir, filePath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function unionAcrossEntries(
  reachable: ReachableHandlers,
  entries: QualifiedKey[],
): Map<SiteId, HandlerSet> {
  const perSite = new Map<SiteId, HandlerSet>();
  for (const entry of entries) {
    for (const [sid, handlers] of Object.entries(reachable[entry] ?? {})) {
      const acc = perSite.get(sid) ?? new Map();
      for (const [k, v] of handlers) acc.set(k, v);
      perSite.set(sid, acc);
    }
  }
  return perSite;
}

// -- Phase 5: Build the public result --

/** `loc.line` is 0-indexed (see lib/parsers/parsers.ts line-number comment
 *  and parser.test.ts "loc.line invariant"). Convert to 1-indexed for the
 *  human-facing output. */
function toDisplayLine(line: number | undefined): number {
  return (line ?? -1) + 1;
}

function buildResult(
  sitesById: Map<SiteId, SiteRecord>,
  perSite: Map<SiteId, HandlerSet>,
): AnalysisResult {
  const sites = Array.from(perSite.entries())
    .map(([sid, hSet]) => buildSiteResult(sitesById.get(sid)!, hSet))
    .sort(compareSites);
  return { sites };
}

function buildSiteResult(rec: SiteRecord, handlers: HandlerSet): SiteResult {
  return {
    site: {
      file: rec.file,
      line: toDisplayLine(rec.site.loc?.line),
      effect: rec.site.effect,
    },
    handlers: Array.from(handlers.values()).map(toHandlerRef).sort(compareHandlerRefs),
  };
}

function toHandlerRef(th: TaggedHandler): HandlerRef {
  const { block, file } = th;
  const line = toDisplayLine(block.loc?.line);
  if (block.handler.kind === "functionRef") {
    return { file, line, shape: "functionRef", functionName: block.handler.functionName };
  }
  return { file, line, shape: "inline" };
}

function compareHandlerRefs(a: HandlerRef, b: HandlerRef): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

function compareSites(a: SiteResult, b: SiteResult): number {
  if (a.site.file !== b.site.file) return a.site.file < b.site.file ? -1 : 1;
  return a.site.line - b.site.line;
}
