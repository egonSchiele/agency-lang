import type { AgencyNode, SeqBlock } from "../types.js";
import { walkNodesArray } from "../utils/node.js";

/** True if any `destructive { }` region appears anywhere in `body`, including
 *  nested blocks/ifs/loops. Used for the is-destructive METADATA only — the
 *  emitted descriptor marker, the MCP/HTTP hint, and the `destructiveFunctions`
 *  registry. NEVER for the entry flip, which keys on the raw `destructive def`
 *  marker alone.
 *
 *  This answers only "does the function DECLARE its own destructive work" — via
 *  a region here, or via the raw `destructive def` marker checked by the caller.
 *  It deliberately does NOT treat a function that merely CALLS a `destructive`
 *  function as destructive: that runtime taint is handled separately by Rule 2
 *  (`NameClassifier.containsDestructiveCall` + the `destructiveFunctions`
 *  registry), which folds a callee's `destructiveRan` into the caller's failure.
 *  (Agency has no nested function definitions, so there is no destructive-marked
 *  function to find inside a body.)
 *
 *  Matches BOTH forms of the region so it works on either side of the
 *  parallelDesugar pass: pre-desugar it is a `seqBlock` flagged `destructive`
 *  (what `compilationUnit` sees); post-desugar the seqBlock is inlined and the
 *  region survives as a `markDestructiveRan` leaf (what `TypeScriptBuilder`
 *  sees). */
export function functionContainsDestructiveBlock(body: AgencyNode[]): boolean {
  for (const { node } of walkNodesArray(body)) {
    if (node.type === "markDestructiveRan") return true;
    if (node.type === "seqBlock" && (node as SeqBlock).destructive) return true;
  }
  return false;
}
