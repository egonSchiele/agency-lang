/**
 * mapBodies — apply a transform to every `body: AgencyNode[]` field reachable
 * from a node, returning a structurally-fresh copy with bodies replaced.
 *
 * Useful for AST passes that need to recurse into every block-bearing node
 * uniformly (lowering passes, instrumenting, scope analysis, …) without
 * hand-listing every body-bearing node type at every call site.
 *
 * Coverage: function definitions, graph nodes, if/else (then + else),
 * while/for loops, match block arm bodies, handle blocks (incl. inline
 * handler body), parallel/seq blocks, block arguments (including the inline
 * `block:` field on function calls).
 *
 * Class methods are intentionally NOT recursed into — classes are being
 * removed from the language. Add them here if that decision is reversed.
 */
import type { AgencyNode } from "../types.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import type { IfElse } from "../types/ifElse.js";
import type { WhileLoop } from "../types/whileLoop.js";
import type { ForLoop } from "../types/forLoop.js";
import type { MatchBlock, MatchBlockCase } from "../types/matchBlock.js";
import type { HandleBlock } from "../types/handleBlock.js";
import type { ParallelBlock, SeqBlock } from "../types/parallelBlock.js";
import type { BlockArgument } from "../types/blockArgument.js";
import type { FunctionCall } from "../types/function.js";

export type BodyTransform = (body: AgencyNode[]) => AgencyNode[];

/** Return a shallow copy of `node` with every body field transformed by `fn`. */
export function mapBodies(node: AgencyNode, fn: BodyTransform): AgencyNode {
  switch (node.type) {
    case "function":
      return { ...(node as FunctionDefinition), body: fn((node as FunctionDefinition).body) };
    case "graphNode":
      return { ...(node as GraphNodeDefinition), body: fn((node as GraphNodeDefinition).body) };
    case "ifElse": {
      const n = node as IfElse;
      return { ...n, thenBody: fn(n.thenBody), elseBody: n.elseBody ? fn(n.elseBody) : undefined };
    }
    case "whileLoop":
      return { ...(node as WhileLoop), body: fn((node as WhileLoop).body) };
    case "forLoop":
      return { ...(node as ForLoop), body: fn((node as ForLoop).body) };
    case "matchBlock": {
      const n = node as MatchBlock;
      return {
        ...n,
        cases: n.cases.map((c) =>
          c.type === "matchBlockCase"
            ? ({ ...c, body: fn([c.body])[0] } as MatchBlockCase)
            : c,
        ),
      };
    }
    case "handleBlock": {
      const n = node as HandleBlock;
      const handler = n.handler.kind === "inline"
        ? { ...n.handler, body: fn(n.handler.body) }
        : n.handler;
      return { ...n, body: fn(n.body), handler };
    }
    case "parallelBlock":
      return { ...(node as ParallelBlock), body: fn((node as ParallelBlock).body) };
    case "seqBlock":
      return { ...(node as SeqBlock), body: fn((node as SeqBlock).body) };
    case "blockArgument":
      return { ...(node as BlockArgument), body: fn((node as BlockArgument).body) };
    case "functionCall": {
      const n = node as FunctionCall;
      if (n.block) {
        return { ...n, block: { ...n.block, body: fn(n.block.body) } };
      }
      return n;
    }
    default:
      return node;
  }
}
