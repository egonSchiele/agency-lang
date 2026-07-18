/**
 * bodySlots — the single source of truth for "which fields of a node hold
 * statements". The statement-body twin of `expressionChildren` (node.ts).
 *
 * Consumed by:
 *   - `mapBodies` (mapBodies.ts) — immutable rewrite of every body
 *   - `walkNodes` (node.ts) — read descent into every body
 *
 * Adding a new body-bearing node type means adding ONE case here; both
 * consumers pick it up. Before this existed, each consumer hand-listed the
 * node types and they drifted (mapBodies missed `messageThread`, then
 * `withModifier`/`staticStatement` — each miss silently skipped lowering).
 *
 * Class methods are intentionally NOT included — classes are being removed
 * from the language. Add them here if that decision is reversed.
 */
import type { AgencyNode } from "../types.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";
import type { IfElse } from "../types/ifElse.js";
import type { WhileLoop } from "../types/whileLoop.js";
import type { ForLoop } from "../types/forLoop.js";
import type { MatchBlock, MatchBlockCase } from "../types/matchBlock.js";
import type { HandleBlock } from "../types/handleBlock.js";
import type { FinalizeBlock } from "../types/finalizeBlock.js";
import type { GuardBlock } from "../types/guardBlock.js";
import type { ParallelBlock, SeqBlock } from "../types/parallelBlock.js";
import type { BlockArgument } from "../types/blockArgument.js";
import type { FunctionCall } from "../types/function.js";
import type { MessageThread } from "../types/messageThread.js";
import type { WithModifier } from "../types/withModifier.js";
import type { StaticStatement } from "../types/staticStatement.js";

export type BodySlot = {
  /** Statements at this slot. A read view — never mutate it in place. */
  body: AgencyNode[];
  /** Set on slots that wrap a single statement field (`with ...` /
   *  `static ...`): a rewrite must map the one statement to exactly one. */
  single?: boolean;
  /** Extra ancestor between the owner and the body during walks — the
   *  functionCall's `block:` argument (inline or not). */
  blockAncestor?: BlockArgument;
  /** True when a `return` inside this slot's body yields to the slot's
   *  own closure rather than the enclosing def: block arguments (the
   *  __block_N lifting), inline handler bodies (their own arrow), and
   *  finalize bodies (the __finalize closure). guardDesugar's return-
   *  target rule keys on this — a new return-retargeting construct
   *  must set it here or that feature silently mis-stamps. */
  retargetsReturn?: boolean;
  /** Fresh copy of `owner` with this slot's statements replaced. Takes the
   *  CURRENT owner (not the node bodySlots was called on) so a fold over
   *  several slots composes: each write builds on the previous one. */
  write: (owner: AgencyNode, body: AgencyNode[]) => AgencyNode;
};

/** One slot for a plain top-level `body` field. */
function bodyField(node: { body: AgencyNode[] }): BodySlot {
  return {
    body: node.body,
    write: (owner, body) => ({ ...owner, body }) as AgencyNode,
  };
}

/** One `single` slot for a `statement` field (`with ...` / `static ...`). */
function statementField(node: { statement: AgencyNode }): BodySlot {
  return {
    body: [node.statement],
    single: true,
    write: (owner, body) => ({ ...owner, statement: body[0] }) as AgencyNode,
  };
}

/** Immediate statement bodies of `node`, each with an immutable writer.
 *  Returns `[]` for nodes that carry no statements. Shallow by design:
 *  consumers drive their own recursion. */
// eslint-disable-next-line max-lines-per-function -- exhaustive per-node-type enumeration; one case per body-bearing kind
export function bodySlots(node: AgencyNode): BodySlot[] {
  switch (node.type) {
    case "function":
      return [bodyField(node as FunctionDefinition)];
    case "graphNode":
      return [bodyField(node as GraphNodeDefinition)];
    case "ifElse": {
      const n = node as IfElse;
      const slots: BodySlot[] = [
        {
          body: n.thenBody,
          write: (owner, body) => ({ ...owner, thenBody: body }) as AgencyNode,
        },
      ];
      if (n.elseBody) {
        slots.push({
          body: n.elseBody,
          write: (owner, body) => ({ ...owner, elseBody: body }) as AgencyNode,
        });
      }
      return slots;
    }
    case "whileLoop":
      return [bodyField(node as WhileLoop)];
    case "forLoop":
      return [bodyField(node as ForLoop)];
    case "matchBlock": {
      const n = node as MatchBlock;
      const slots: BodySlot[] = [];
      n.cases.forEach((c, index) => {
        if (c.type !== "matchBlockCase") {
          return;
        }
        slots.push({
          body: c.body,
          write: (owner, body) => {
            const o = owner as MatchBlock;
            return {
              ...o,
              cases: o.cases.map((oc, j) =>
                j === index ? ({ ...oc, body } as MatchBlockCase) : oc,
              ),
            };
          },
        });
      });
      return slots;
    }
    case "handleBlock": {
      const n = node as HandleBlock;
      const slots: BodySlot[] = [
        {
          body: n.body,
          write: (owner, body) => ({ ...owner, body }) as AgencyNode,
        },
      ];
      if (n.handler.kind === "inline") {
        slots.push({
          body: n.handler.body,
          retargetsReturn: true,
          write: (owner, body) => {
            const o = owner as HandleBlock;
            return { ...o, handler: { ...o.handler, body } } as AgencyNode;
          },
        });
      }
      return slots;
    }
    case "finalizeBlock": {
      // Same-scope statements (like an if body): the finalize reads the
      // enclosing scope's locals, so every walker and rewriter must
      // descend into it as part of that scope.
      const n = node as FinalizeBlock;
      return [
        {
          body: n.body,
          retargetsReturn: true,
          write: (owner, body) => ({ ...owner, body }) as AgencyNode,
        },
      ];
    }
    case "guardBlock": {
      // The guarded block. Distinct-scope statements (the body compiles
      // to a lifted closure after desugaring), but walkers and
      // rewriters must descend into it like any other body.
      const n = node as GuardBlock;
      return [
        {
          body: n.body,
          write: (owner, body) => ({ ...owner, body }) as AgencyNode,
        },
      ];
    }
    case "parallelBlock":
      return [bodyField(node as ParallelBlock)];
    case "seqBlock":
      return [bodyField(node as SeqBlock)];
    case "markDestructiveRan":
      // Synthetic leaf (no body) introduced post-typecheck by parallelDesugar.
      return [];
    case "messageThread":
      return [bodyField(node as MessageThread)];
    case "blockArgument": {
      const n = node as unknown as BlockArgument;
      return [
        {
          body: n.body,
          retargetsReturn: true,
          write: (owner, body) => ({ ...owner, body }) as AgencyNode,
        },
      ];
    }
    case "functionCall": {
      const n = node as FunctionCall;
      if (!n.block) {
        return [];
      }
      const block = n.block;
      return [
        {
          body: block.body,
          blockAncestor: block,
          retargetsReturn: true,
          write: (owner, body) => {
            const o = owner as FunctionCall;
            if (!o.block) {
              return o;
            }
            return { ...o, block: { ...o.block, body } };
          },
        },
      ];
    }
    case "withModifier":
      return [statementField(node as WithModifier)];
    case "staticStatement":
      return [statementField(node as StaticStatement)];
    default:
      return [];
  }
}
