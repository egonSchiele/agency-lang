/**
 * expressionSlots — the single source of truth for "which positions of a
 * node hold expressions, and when those positions execute". The
 * expression twin of `bodySlots` (bodySlots.ts), which owns the same
 * question for statement bodies.
 *
 * Why it exists: hand-written expression-position lists drift. The
 * hoisting pass (lib/preprocessors/hoistCalls.ts) shipped with its own
 * list and three holes were found in one week — thread blocks in value
 * position, goto arguments, indexed-assignment targets — each a place
 * where the resume desync the pass exists to fix silently survived.
 * `bodySlots`' header records the identical history for statement
 * bodies; this file is the same cure one level over.
 *
 * Consumers:
 *   - `expressionChildren` (node.ts) — the derived read view
 *   - `hoistCalls` (preprocessors) — rewrites via each slot's `write`
 *
 * NOT yet on this table (each threads ancestor/scope state a plain slot
 * list does not model; migrating them is a recorded follow-up, not an
 * oversight): the `walkNodes` generator's own expression descent and
 * `getAllVariablesInBody`, both in node.ts. Until then, a new node kind
 * registers expression positions HERE and, if it needs symbol-table or
 * variable-collection coverage, in those two as well.
 *
 * The expression/statement seam: some expressions also own statement
 * bodies (a thread block in value position; a call with a block
 * argument). The rule, mirrored in bodySlots.ts: when a consumer walks a
 * slot's expression and that node has `bodySlots`, its statement bodies
 * are reached through `bodySlots`, never through expression slots. An
 * `ifElse` therefore contributes only its condition here — its branches
 * are statement bodies even in the (parse-time-lowered) value form.
 *
 * Slots are returned in EVALUATION order and never overlap (each targets
 * a distinct field or index) — that is what makes folding `write` calls
 * safe; the corpus round-trip test enforces both properties.
 *
 * Completeness is enforced, not assumed: every member of
 * `EXPRESSION_NODE_TYPES` must appear either in the switch (tracked in
 * `HANDLED_KINDS`) or in `NO_EXPRESSION_SLOTS`; the unit test fails by
 * name on an unregistered kind, and `hoistCalls` throws at compile time
 * if one ever reaches it.
 */
import type { AgencyNode } from "../types.js";

/** When a slot's expression executes, relative to its owner running.
 *  Rewriters key safety decisions on this; read-only consumers ignore
 *  it. NOTE: no consumer today branches on conditional-vs-opaque — both
 *  mean "skip" to rewriters and "include" to readers. The distinction
 *  is kept as documentation of WHY a position is untouchable; do not
 *  build logic on it without adding tests that distinguish them.
 *  - "once": exactly once when the owner executes. Hoisting a call out
 *    to a prior statement preserves semantics.
 *  - "perIteration": re-evaluated every loop pass (a while condition).
 *    A rewriter cannot hoist it before the owner; it must restructure
 *    or leave it. The mode is the prohibition; the restructure strategy
 *    belongs to the rewriter and is keyed on the owner's kind.
 *  - "conditional": may never execute (short-circuit right sides,
 *    catch fallbacks). Hoisting would run code the program skipped.
 *  - "opaque": executes inside a runtime boundary that must not move
 *    (try operands, the whole catch expression, with/static wrapped
 *    statements, pipe stages). */
export type EvalMode = "once" | "perIteration" | "conditional" | "opaque";

export type ExpressionSlot = {
  /** The expression at this position. A read view — never mutate. */
  expr: AgencyNode;
  mode: EvalMode;
  /** Fresh copy of `owner` with this slot's expression replaced. Takes
   *  the CURRENT owner (not the node expressionSlots was called on) so
   *  a fold over several slots composes. */
  write: (owner: AgencyNode, expr: AgencyNode) => AgencyNode;
};

/** Expression node kinds that genuinely carry no expression children.
 *  The completeness test requires every EXPRESSION_NODE_TYPES member to
 *  appear either here or in HANDLED_KINDS — an unlisted kind is a test
 *  failure, not a silent []. */
export const NO_EXPRESSION_SLOTS: Record<string, true> = {
  number: true,
  unitLiteral: true,
  variableName: true,
  boolean: true,
  null: true,
  regex: true,
  // A schema literal carries a type argument, not runtime expressions.
  schemaExpression: true,
  // Params are binders; the body is STATEMENTS, owned by bodySlots.
  blockArgument: true,
};

/** Every kind the switch below enumerates — expression kinds AND the
 *  statement kinds that carry expression positions. Exported for the
 *  completeness test and for isRegisteredExpressionKind. */
export const HANDLED_KINDS: readonly string[] = [
  "assignment",
  "returnStatement",
  "matchYield",
  "functionCall",
  "interruptStatement",
  "gotoStatement",
  "ifElse",
  "whileLoop",
  "forLoop",
  "matchBlock",
  "messageThread",
  "withModifier",
  "staticStatement",
  "binOpExpression",
  "tryExpression",
  "valueAccess",
  "agencyArray",
  "agencyObject",
  "string",
  "multiLineString",
  "comprehension",
  "newExpression",
  "isExpression",
  "typeTestExpression",
];

/** True when `type` is known to this enumeration — either it has slots
 *  or it is declared expression-free. hoistCalls throws on anything
 *  else: an unregistered kind must fail by name, not fall into a silent
 *  generic walk (that walk is how the drift holes stayed hidden). */
export function isRegisteredExpressionKind(type: string): boolean {
  return HANDLED_KINDS.includes(type) || type in NO_EXPRESSION_SLOTS;
}

const slot = (
  expr: AgencyNode,
  mode: EvalMode,
  write: (owner: AgencyNode, expr: AgencyNode) => AgencyNode,
): ExpressionSlot => ({ expr, mode, write });

function replaceAt<T>(arr: T[], i: number, item: T): T[] {
  return arr.map((x, j) => (j === i ? item : x));
}

/** Slots for a call-shaped argument list (functionCall,
 *  interruptStatement, newExpression, and — via `rebase` — the
 *  arguments of a gotoStatement's node call). Handles the
 *  namedArgument wrapper: the slot's expr is the wrapped value and the
 *  writer rebuilds the wrapper. `rebase` lifts a write on the
 *  args-owner into a write on the outer owner (identity by default). */
function argumentSlots(
  args: any[],
  mode: EvalMode,
  rebase: (
    write: (argsOwner: any, expr: AgencyNode) => any,
  ) => (owner: AgencyNode, expr: AgencyNode) => AgencyNode,
): ExpressionSlot[] {
  return args.flatMap((arg: any, i: number) => {
    if (!arg || typeof arg !== "object") return [];
    // Splat and named-argument wrappers: the slot's expr is the wrapped
    // value (matching unwrapCallArg in node.ts) and the writer rebuilds
    // the wrapper.
    if (arg.type === "splat" || arg.type === "namedArgument") {
      if (!arg.value || typeof arg.value !== "object") return [];
      return [
        slot(
          arg.value,
          mode,
          rebase((o, e) => ({
            ...o,
            arguments: replaceAt(o.arguments, i, { ...o.arguments[i], value: e }),
          })),
        ),
      ];
    }
    return [
      slot(
        arg,
        mode,
        rebase((o, e) => ({ ...o, arguments: replaceAt(o.arguments, i, e) })),
      ),
    ];
  });
}

/** Slots for an access chain (`a[i]`, `a[i:j]`, `a.m(x)`), shared by
 *  valueAccess expressions and indexed-assignment targets so the two
 *  cannot diverge. A methodCall entry exposes its whole functionCall
 *  node (matching what expressionChildren always returned); whether
 *  that call itself may be rewritten is consumer policy. `key` is the
 *  owner field holding the chain ("chain" / "accessChain"). */
function chainSlots(chain: any[], key: string): ExpressionSlot[] {
  return chain.flatMap((entry: any, i: number) => {
    if (!entry || typeof entry !== "object") return [];
    const writeEntry =
      (patch: (entry: any, expr: AgencyNode) => any) =>
      (owner: any, expr: AgencyNode): AgencyNode => ({
        ...owner,
        [key]: replaceAt(owner[key], i, patch(owner[key][i], expr)),
      });
    if (entry.kind === "index" && entry.index) {
      return [slot(entry.index, "once", writeEntry((en, e) => ({ ...en, index: e })))];
    }
    if (entry.kind === "slice") {
      const out: ExpressionSlot[] = [];
      if (entry.start) {
        out.push(slot(entry.start, "once", writeEntry((en, e) => ({ ...en, start: e }))));
      }
      if (entry.end) {
        out.push(slot(entry.end, "once", writeEntry((en, e) => ({ ...en, end: e }))));
      }
      return out;
    }
    if (entry.kind === "methodCall" && entry.functionCall) {
      return [
        slot(entry.functionCall, "once", writeEntry((en, e) => ({ ...en, functionCall: e }))),
      ];
    }
    return [];
  });
}

/** Operator-position rulings for binOpExpression. Unlisted operators
 *  evaluate both sides unconditionally. */
const OPERATOR_MODES: Record<string, { left: EvalMode; right: EvalMode }> = {
  // The whole catch expression is a boundary today: the fallback runs
  // only on Failure (__catchResult), and the left side is excluded for
  // boundary simplicity — a deliberate landed ruling; revisit only with
  // a test change.
  catch: { left: "opaque", right: "conditional" },
  // Pipe input evaluates inline at statement level, outside the
  // per-stage memoization; stages are memoized AND failure-gated.
  "|>": { left: "once", right: "opaque" },
  // Short-circuits: the right side may never run.
  "&&": { left: "once", right: "conditional" },
  "||": { left: "once", right: "conditional" },
  "??": { left: "once", right: "conditional" },
};

/** Immediate expression positions of `node`, in evaluation order, each
 *  with an immutable writer. Returns `[]` for kinds in
 *  NO_EXPRESSION_SLOTS and for statement kinds that carry no
 *  expressions. Shallow by design: consumers drive their own
 *  recursion. */
// eslint-disable-next-line max-lines-per-function -- exhaustive per-node-kind enumeration; one case per kind
export function expressionSlots(node: AgencyNode): ExpressionSlot[] {
  const n = node as any;
  switch (n.type) {
    case "assignment": {
      // The target's index expressions evaluate before the value.
      const out: ExpressionSlot[] = Array.isArray(n.accessChain)
        ? chainSlots(n.accessChain, "accessChain")
        : [];
      if (n.value && typeof n.value === "object") {
        out.push(slot(n.value, "once", (o, e) => ({ ...o, value: e }) as AgencyNode));
      }
      return out;
    }
    case "returnStatement":
    case "matchYield": {
      if (!n.value || typeof n.value !== "object") return [];
      return [slot(n.value, "once", (o, e) => ({ ...o, value: e }) as AgencyNode)];
    }
    case "functionCall":
    case "interruptStatement":
    case "newExpression":
      return argumentSlots(n.arguments ?? [], "once", (w) => w as any);
    case "gotoStatement":
      // The node call is control flow (it transfers, and node calls
      // throw in value position), so it is not a slot; its arguments
      // evaluate before the transfer.
      return argumentSlots(n.nodeCall?.arguments ?? [], "once", (w) => (o: any, e) => ({
        ...o,
        nodeCall: w(o.nodeCall, e),
      }));
    case "ifElse":
      // Branches are statement bodies (bodySlots), even for the
      // value-position form pattern lowering rewrites at parse time.
      return [slot(n.condition, "once", (o, e) => ({ ...o, condition: e }) as AgencyNode)];
    case "whileLoop":
      return [
        slot(n.condition, "perIteration", (o, e) => ({ ...o, condition: e }) as AgencyNode),
      ];
    case "forLoop":
      return [slot(n.iterable, "once", (o, e) => ({ ...o, iterable: e }) as AgencyNode)];
    case "matchBlock":
      return [slot(n.expression, "once", (o, e) => ({ ...o, expression: e }) as AgencyNode)];
    case "messageThread": {
      const out: ExpressionSlot[] = [];
      for (const key of ["label", "summarize", "continueExpr", "sessionExpr", "hidden"]) {
        const arg = n[key];
        if (arg && typeof arg === "object") {
          out.push(slot(arg, "once", (o: any, e) => ({ ...o, [key]: e })));
        }
      }
      return out;
    }
    case "withModifier":
    case "staticStatement":
      // Opaque: rewriting inside would cross the approval region /
      // init-topsort territory, and the slot holds exactly one
      // statement. Readers still see it (expressionChildren parity).
      return [slot(n.statement, "opaque", (o, e) => ({ ...o, statement: e }) as AgencyNode)];
    case "binOpExpression": {
      const modes = OPERATOR_MODES[n.operator] ?? { left: "once" as const, right: "once" as const };
      const out: ExpressionSlot[] = [];
      if (n.left && typeof n.left === "object") {
        out.push(slot(n.left, modes.left, (o, e) => ({ ...o, left: e }) as AgencyNode));
      }
      if (n.right && typeof n.right === "object") {
        out.push(slot(n.right, modes.right, (o, e) => ({ ...o, right: e }) as AgencyNode));
      }
      return out;
    }
    case "tryExpression":
      // The whole operand compiles into the __tryCall thunk; moving
      // anything out moves the error boundary.
      return [slot(n.call, "opaque", (o, e) => ({ ...o, call: e }) as AgencyNode)];
    case "valueAccess": {
      const out: ExpressionSlot[] = [];
      if (n.base && typeof n.base === "object") {
        out.push(slot(n.base, "once", (o, e) => ({ ...o, base: e }) as AgencyNode));
      }
      out.push(...chainSlots(n.chain ?? [], "chain"));
      return out;
    }
    case "agencyArray":
      return (n.items ?? []).flatMap((item: any, i: number) => {
        if (!item || typeof item !== "object") return [];
        if (item.type === "splat") {
          return [
            slot(item.value, "once", (o: any, e) => ({
              ...o,
              items: replaceAt(o.items, i, { ...o.items[i], value: e }),
            })),
          ];
        }
        return [
          slot(item, "once", (o: any, e) => ({ ...o, items: replaceAt(o.items, i, e) })),
        ];
      });
    case "agencyObject":
      return (n.entries ?? []).flatMap((entry: any, i: number) => {
        if (!entry || typeof entry !== "object") return [];
        if (entry.type === "splat") {
          if (!entry.value || typeof entry.value !== "object") return [];
          return [
            slot(entry.value, "once", (o: any, e) => ({
              ...o,
              entries: replaceAt(o.entries, i, { ...o.entries[i], value: e }),
            })),
          ];
        }
        const out: ExpressionSlot[] = [];
        // A computed key evaluates before its value.
        if (entry.computedKey && typeof entry.computedKey === "object") {
          out.push(
            slot(entry.computedKey, "once", (o: any, e) => ({
              ...o,
              entries: replaceAt(o.entries, i, { ...o.entries[i], computedKey: e }),
            })),
          );
        }
        if (entry.value && typeof entry.value === "object") {
          out.push(
            slot(entry.value, "once", (o: any, e) => ({
              ...o,
              entries: replaceAt(o.entries, i, { ...o.entries[i], value: e }),
            })),
          );
        }
        return out;
      });
    case "string":
    case "multiLineString":
      return (n.segments ?? []).flatMap((seg: any, i: number) => {
        if (seg?.type !== "interpolation" || !seg.expression) return [];
        return [
          slot(seg.expression, "once", (o: any, e) => ({
            ...o,
            segments: replaceAt(o.segments, i, { ...o.segments[i], expression: e }),
          })),
        ];
      });
    case "comprehension": {
      // Only the type checker ever sees comprehensions (parse-time
      // desugar to map/fork calls), and it ignores modes — these are
      // the honest values. The binder is a binding site, not a slot.
      const out: ExpressionSlot[] = [
        slot(n.iterable, "once", (o, e) => ({ ...o, iterable: e }) as AgencyNode),
        slot(n.expression, "perIteration", (o, e) => ({ ...o, expression: e }) as AgencyNode),
      ];
      if (n.condition && typeof n.condition === "object") {
        out.push(
          slot(n.condition, "perIteration", (o, e) => ({ ...o, condition: e }) as AgencyNode),
        );
      }
      return out;
    }
    case "isExpression":
    case "typeTestExpression":
      // Recorded ruling: the parser rejects a call on the left of `is`,
      // so calls are unreachable in these positions today. The slots
      // exist so the enumeration is complete and the ruling visible,
      // not because hoisting has work to do.
      return [slot(n.expression, "once", (o, e) => ({ ...o, expression: e }) as AgencyNode)];
    default:
      return [];
  }
}
