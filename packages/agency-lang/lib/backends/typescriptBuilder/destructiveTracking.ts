import type { TsNode } from "../../ir/tsIR.js";
import { ts } from "../../ir/builders.js";
import type { AgencyNode, Assignment } from "../../types.js";
import type { HandleBlock } from "../../types/handleBlock.js";
import { bodySlots } from "../../utils/bodySlots.js";
import type { CompilationUnit } from "../../compilationUnit.js";
import type { NameClassifier } from "./nameClassifier.js";

/**
 * Emits the destructive-execution tracking codegen: the per-function
 * `__destructiveRan` init, the function-exit boundary stamp, the region-entry
 * flip (`markDestructiveRan`, emitted by a `markDestructiveRan` node from an
 * inlined `destructive { }` region), and the Rule-2 caller-side flips. Extracted
 * from TypeScriptBuilder so the tracking rules live in one declarative place.
 *
 * Stateless by design: every method is a pure function of its arguments (the
 * `inDestructiveFunction` flag is passed in, not held), so it can be
 * unit-tested directly — feed it a statement, assert the emitted nodes.
 *
 * How the flag works: every function activation carries a boolean
 * `__destructiveRan` on its locals, written as `__activation.__destructiveRan`.
 * It starts false and is only ever flipped to true (sticky). It is set at
 * ENTRY for a `destructive def` (init(true)), or at region entry for a
 * `destructive { }` region. The function exit folds it into any departing
 * failure via `stampFailureBoundary`, so a failure reports whether execution
 * entered a destructive region.
 *
 * Why `__activation` and not `__self`: a block argument and a fork branch each
 * declare their own `__self` for their own frame. A region or destructive call
 * inside one of them still belongs to the enclosing function, whose exit stamp
 * is the only place the flag is read. Writing the block's `__self` lost the
 * flag when the block returned, so a failure escaping a decorated or
 * block-wrapped function read `destructiveRan: false` (ADI-56). `__activation`
 * is declared once per function and node, next to `__self`, and a block or
 * branch reaches it lexically. docs/dev/language/destructive-regions.md.
 */
export class DestructiveTracking {
  constructor(
    private readonly names: NameClassifier,
    private readonly compilationUnit: Pick<CompilationUnit, "destructiveFunctions">,
  ) {}

  /** `__activation.__destructiveRan`: the flag on the enclosing function or
   *  node activation. Not `ts.self(...)`: inside a block argument or a fork
   *  branch `__self` is that frame's locals, which are dropped when it
   *  returns, and a flip written there never reaches the function's exit
   *  stamp (ADI-56). `__activation` is declared once per function and node
   *  by `ts.setupEnv` and is never shadowed. */
  private slot(): TsNode {
    return ts.prop(ts.runtime.activation, "__destructiveRan");
  }

  /** `__activation.__destructiveRan = __activation.__destructiveRan ?? false` — emitted
   *  UNCONDITIONALLY in every function. Decision 8 sets this at runtime (a
   *  destructive tool inside an llm() call), which the builder cannot see
   *  statically; the unconditional boolean init keeps the exit stamp from
   *  ever computing `x || undefined`. */
  init(inDestructiveFunction: boolean): TsNode {
    // A `destructive def` commits its whole body: set the flag true at entry.
    // `init()` runs inside step 0, after the `!` parameter checks, so a
    // refused argument halts before it and the failure leaves with
    // destructiveRan false. A non-destructive function keeps the `?? false`
    // default so an externally set value (decision-8, or a `destructive { }`
    // region's flip) is preserved.
    return ts.assign(
      this.slot(),
      inDestructiveFunction ? ts.bool(true) : ts.binOp(this.slot(), "??", ts.bool(false)),
    );
  }

  /** `stampFailureBoundary(runner.haltResult, __activation.__destructiveRan)` — the
   *  expression the function-exit halt check embeds to fold this activation's
   *  flag into a departing failure. */
  exitStamp(): TsNode {
    // A `!` parameter check that fails halts before `init()` has run, so
    // the slot can be unset here.
    return ts.call(ts.id("stampFailureBoundary"), [
      ts.prop(ts.id("runner"), "haltResult"),
      ts.binOp(this.slot(), "??", ts.bool(false)),
    ]);
  }

  /** Post-statement destructive flip for one statement, for a function that is
   *  NOT itself `destructive`. A `destructive def` commits at entry (see
   *  `init`), so it needs no per-statement flips.
   *
   *  Rule 2 (any function calling a destructive fn): when the call's result
   *  binds to a simple local (`const r = burn()` / `const r = try burn()`), an
   *  outcome-dependent POST flip trusts the result's own destructiveRan (a
   *  swallowed destructive failure still marks us; a clean refusal does not).
   *  Otherwise a conservative PRE flip fires when the statement contains a
   *  destructive call that no nested post-flip covers (#1278). */
  statementFlips(
    stmt: AgencyNode,
    inDestructiveFunction: boolean,
  ): { pre?: TsNode; post?: TsNode } {
    // A `destructive def` commits at entry; no per-statement flips.
    if (inDestructiveFunction) return {};
    const outcomeVar = this.destructiveOutcomeVar(stmt);
    if (outcomeVar) {
      return { post: this.outcomeFlip(outcomeVar) };
    }
    return this.names.containsDestructiveCall(stmt, this.coveredCalls([stmt]))
      ? { pre: this.markDestructiveRan() }
      : {};
  }

  /** `__activation.__destructiveRan = true` — sets the activation's destructive-ran
   *  flag. Emitted at a `destructive { }` region entry (via the
   *  `markDestructiveRan` node) and as the Rule-2 conservative pre-flip. */
  markDestructiveRan(): TsNode {
    return ts.assign(this.slot(), ts.bool(true));
  }

  /** `__activation.__destructiveRan = __activation.__destructiveRan ||
   *  (isFailure(__self.v) ? __self.v.destructiveRan : true)`. The destructive callee's result is
   *  bound at `__self.<var>`; OR its outcome into the activation. The ternary
   *  printer parenthesizes itself, which is exactly what precedence needs here
   *  (`||` binds tighter than `?:`), so no explicit paren option is required. */
  private outcomeFlip(varName: string): TsNode {
    const bound = ts.self(varName);
    return ts.assign(
      this.slot(),
      ts.binOp(
        this.slot(),
        "||",
        ts.ternary(
          ts.call(ts.id("isFailure"), [bound]),
          ts.prop(bound, "destructiveRan"),
          ts.bool(true),
        ),
      ),
    );
  }

  /** If `stmt` is a simple assignment whose value is a direct call to a
   *  destructive function (optionally `try`-wrapped), return the local it
   *  binds to. Null for bare calls, nested-in-expression calls, patterns,
   *  access chains, or non-innermost block targets — those get the
   *  conservative pre-flip instead. */
  private destructiveOutcomeVar(stmt: AgencyNode): string | null {
    return this.trackedCallNodes(stmt).length > 0
      ? ((stmt as Assignment).variableName ?? null)
      : null;
  }

  /** The call nodes of a tracked assignment, as the destructive-call walk
   *  presents them: `[call]` for a direct call, `[tryExpr, call]` for a `try`
   *  call (the walk yields both). `[]` when `stmt` is not a tracked assignment. */
  private trackedCallNodes(stmt: AgencyNode): AgencyNode[] {
    if (stmt.type !== "assignment") {
      return [];
    }
    const asn = stmt as Assignment;
    if (asn.pattern || asn.accessChain || asn.blockDepth || !asn.variableName) {
      return [];
    }
    const value = asn.value as AgencyNode & {
      functionName?: string;
      call?: AgencyNode & { functionName?: string };
    };
    let nodes: AgencyNode[] = [];
    let functionName: string | undefined;
    if (value?.type === "functionCall") {
      nodes = [value];
      functionName = value.functionName;
    } else if (value?.type === "tryExpression" && value.call?.type === "functionCall") {
      nodes = [value, value.call];
      functionName = value.call.functionName;
    }
    if (!functionName) {
      return [];
    }
    // Object.hasOwn, not a truthy index: `destructiveFunctions` is a plain
    // object, so a call to a function named `toString` / `constructor` would
    // otherwise resolve an inherited prototype member as truthy and be
    // misclassified as destructive.
    return Object.hasOwn(this.compilationUnit.destructiveFunctions, functionName) ? nodes : [];
  }

  /** Destructive calls under `body` that get their own post-flip: tracked
   *  assignments in any nested body `processBodyAsParts` compiles. An inline
   *  handler body is skipped, because `processHandleBlockWithSteps` compiles it
   *  statement by statement with no flips, so nothing in it is covered.
   *  docs/dev/language/destructive-regions.md. */
  private coveredCalls(body: AgencyNode[]): AgencyNode[] {
    const covered: AgencyNode[] = [];
    for (const stmt of body) {
      covered.push(...this.trackedCallNodes(stmt));
      for (const slot of bodySlots(stmt)) {
        if (isInlineHandlerBody(stmt, slot.body)) {
          continue;
        }
        covered.push(...this.coveredCalls(slot.body));
      }
    }
    return covered;
  }
}

function isInlineHandlerBody(stmt: AgencyNode, body: AgencyNode[]): boolean {
  if (stmt.type !== "handleBlock") {
    return false;
  }
  const handler = (stmt as HandleBlock).handler;
  return handler.kind === "inline" && handler.body === body;
}
