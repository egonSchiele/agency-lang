import type { TsNode } from "../../ir/tsIR.js";
import { ts } from "../../ir/builders.js";
import type { AgencyNode, Assignment } from "../../types.js";
import type { HandleBlock } from "../../types/handleBlock.js";
import { bodySlots } from "../../utils/bodySlots.js";
import { walkNodesArray, type WalkAncestor } from "../../utils/node.js";
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

  /** The flips for one statement, for a function that is NOT itself
   *  `destructive`. A `destructive def` commits at entry (see `init`), so it
   *  needs no per-statement flips.
   *
   *  Rule 2 (any function calling a destructive fn): when the call's result
   *  binds to a simple local (`const r = burn()` / `const r = try burn()`), an
   *  outcome-dependent POST flip trusts the result's own destructiveRan (a
   *  swallowed destructive failure still marks us; a clean refusal does not).
   *  The caller wraps that statement in `markOnThrow`, because a throw skips
   *  the post-flip. Every other destructive call in the statement's own
   *  expressions or in an inline handler body gets a conservative PRE flip.
   *  A call inside a nested body that `processBodyAsParts` compiles is left
   *  to that body's own flips (#1278). */
  statementFlips(
    stmt: AgencyNode,
    inDestructiveFunction: boolean,
  ): { pre?: TsNode; post?: TsNode } {
    // A `destructive def` commits at entry; no per-statement flips.
    if (inDestructiveFunction) {
      return {};
    }
    const tracked = this.trackedCall(stmt);
    const needsPre = this.callSites(stmt).some(
      (site) => site.root === null && !tracked.includes(site.call),
    );
    return {
      pre: needsPre ? this.markDestructiveRan() : undefined,
      post: tracked.length > 0 ? this.outcomeFlip((stmt as Assignment).variableName!) : undefined,
    };
  }

  /** The statements in nested bodies that `statementFlips` relies on for a
   *  destructive call under `stmt`. Codegen checks that each one went
   *  through `processBodyAsParts`, so a body compiled without flips fails
   *  the build instead of under-reporting `destructiveRan`. */
  nestedRoots(stmt: AgencyNode): AgencyNode[] {
    return this.callSites(stmt)
      .map((site) => site.root)
      .filter((root): root is AgencyNode => root !== null);
  }

  /** `__activation.__destructiveRan = true` — sets the activation's destructive-ran
   *  flag. Emitted at a `destructive { }` region entry (via the
   *  `markDestructiveRan` node) and as the Rule-2 conservative pre-flip. */
  markDestructiveRan(): TsNode {
    return ts.assign(this.slot(), ts.bool(true));
  }

  /** Wraps the statement of a tracked call so a throw out of it marks the
   *  activation before it propagates. The post-flip runs only when the call
   *  returns, and a destructive JS extern called without `try`, or an abort
   *  such as a guard trip, leaves by throwing. Run-control signals (pause,
   *  restore) say nothing about the call's work and pass through unmarked. */
  markOnThrow(statement: TsNode): TsNode {
    return ts.tryCatch(
      ts.statements([statement]),
      ts.statements([
        ts.if(
          ts.raw("!(__error instanceof RunControlSignal)"),
          ts.statements([this.markDestructiveRan()]),
        ),
        ts.throw("__error"),
      ]),
      "__error",
    );
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

  /** The call nodes of a tracked assignment: a simple local bound to a direct
   *  call to a destructive function, optionally `try`-wrapped. `[call]` for a
   *  direct call, `[tryExpr, call]` for a `try` call, because the walk yields
   *  both. `[]` for anything else: bare calls, nested calls, access chains,
   *  non-innermost block targets. */
  private trackedCall(stmt: AgencyNode): AgencyNode[] {
    if (stmt.type !== "assignment") {
      return [];
    }
    const asn = stmt as Assignment;
    if (asn.pattern || asn.accessChain || asn.blockDepth || !asn.variableName) {
      return [];
    }
    const value = asn.value as AgencyNode & { call?: AgencyNode };
    if (value?.type === "functionCall" && this.names.isDestructiveCall(value)) {
      return [value];
    }
    if (
      value?.type === "tryExpression" &&
      value.call?.type === "functionCall" &&
      this.names.isDestructiveCall(value)
    ) {
      return [value, value.call];
    }
    return [];
  }

  /** Every destructive call under `stmt`, with the statement of the first
   *  nested body on its path (`root`). `root` is null when the call sits in
   *  `stmt`'s own expressions or under an inline handler body, which
   *  `processHandleBlockWithSteps` compiles statement by statement with no
   *  flips. Every other body is compiled by `processBodyAsParts`, which gives
   *  `root` flips of its own. docs/dev/language/destructive-regions.md. */
  private callSites(stmt: AgencyNode): { call: AgencyNode; root: AgencyNode | null }[] {
    return walkNodesArray([stmt])
      .filter(({ node }) => this.names.isDestructiveCall(node))
      .map(({ node, ancestors }) => ({ call: node, root: nestedBodyRoot([...ancestors, node]) }));
  }
}

/** Walks a root-first ancestor chain to the first step into a statement
 *  body. Returns the statement entered, or null when there is none or the
 *  body is an inline handler body. */
function nestedBodyRoot(chain: WalkAncestor[]): AgencyNode | null {
  for (let i = 0; i + 1 < chain.length; i++) {
    const parent = chain[i] as AgencyNode;
    const child = chain[i + 1] as AgencyNode;
    const slot = bodySlots(parent).find((candidate) => candidate.body.includes(child));
    if (slot) {
      return isInlineHandlerBody(parent, slot.body) ? null : child;
    }
  }
  return null;
}

function isInlineHandlerBody(stmt: AgencyNode, body: AgencyNode[]): boolean {
  if (stmt.type !== "handleBlock") {
    return false;
  }
  const handler = (stmt as HandleBlock).handler;
  return handler.kind === "inline" && handler.body === body;
}
