import type { TsNode } from "../../ir/tsIR.js";
import { ts } from "../../ir/builders.js";
import type { AgencyNode, Assignment } from "../../types.js";
import type { CompilationUnit } from "../../compilationUnit.js";
import type { NameClassifier } from "./nameClassifier.js";

/**
 * Emits the destructive-execution tracking codegen: the per-function
 * `__destructiveRan` init, the function-exit boundary stamp, and the
 * per-statement flips. Extracted from TypeScriptBuilder so the tracking rules
 * live in one declarative place instead of scattered through a 4k-line file.
 *
 * Stateless by design: every method is a pure function of its arguments (the
 * `inDestructiveFunction` flag is passed in, not held), so it can be
 * unit-tested directly — feed it a statement, assert the emitted nodes.
 *
 * How the flag works: every function activation carries a boolean
 * `__self.__destructiveRan`. It starts false and is only ever flipped to true
 * (sticky). The function exit folds it into any departing failure via
 * `stampFailureBoundary`, so a failure reports whether destructive work ran.
 */
export class DestructiveTracking {
  constructor(
    private readonly names: NameClassifier,
    private readonly compilationUnit: Pick<
      CompilationUnit,
      "destructiveFunctions"
    >,
  ) {}

  /** `__self.__destructiveRan = __self.__destructiveRan ?? false` — emitted
   *  UNCONDITIONALLY in every function. Decision 8 sets this at runtime (a
   *  destructive tool inside an llm() call), which the builder cannot see
   *  statically; the unconditional boolean init keeps the exit stamp from
   *  ever computing `x || undefined`. */
  init(inDestructiveFunction: boolean): TsNode {
    // A `destructive def` commits its whole body: set the flag true at entry.
    // `init()` runs AFTER argument binding, so an arg-binding failure that halts
    // before it stays retryable (`neverStarted`). A non-destructive function
    // keeps the `?? false` default so an externally set value (decision-8, or a
    // `destructive { }` region's flip) is preserved.
    return ts.assign(
      ts.self("__destructiveRan"),
      inDestructiveFunction
        ? ts.bool(true)
        : ts.binOp(ts.self("__destructiveRan"), "??", ts.bool(false)),
    );
  }

  /** `__self.__destructiveRan = true` — the entry flip a `destructive { }`
   *  region emits (via the `markDestructiveRan` node). Because the region is
   *  inlined into the function body, `ts.self` resolves to the function's
   *  `__self`, not a block frame. */
  blockEntryFlip(): TsNode {
    return this.markTrue();
  }

  /** `stampFailureBoundary(runner.haltResult, __self.__destructiveRan)` — the
   *  expression the function-exit halt check embeds to fold this activation's
   *  flag into a departing failure. */
  exitStamp(): TsNode {
    return ts.call(ts.id("stampFailureBoundary"), [
      ts.prop(ts.id("runner"), "haltResult"),
      ts.self("__destructiveRan"),
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
   *  Otherwise a conservative PRE flip fires whenever the statement textually
   *  contains a destructive call. */
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
    return this.names.containsDestructiveCall(stmt)
      ? { pre: this.markTrue() }
      : {};
  }

  /** `__self.__destructiveRan = true` — the conservative pre-flip. */
  private markTrue(): TsNode {
    return ts.assign(ts.self("__destructiveRan"), ts.bool(true));
  }

  /** `__self.__destructiveRan = __self.__destructiveRan || (isFailure(__self.v)
   *  ? __self.v.destructiveRan : true)`. The destructive callee's result is
   *  bound at `__self.<var>`; OR its outcome into the activation. The ternary
   *  printer parenthesizes itself, which is exactly what precedence needs here
   *  (`||` binds tighter than `?:`), so no explicit paren option is required. */
  private outcomeFlip(varName: string): TsNode {
    const bound = ts.self(varName);
    return ts.assign(
      ts.self("__destructiveRan"),
      ts.binOp(
        ts.self("__destructiveRan"),
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
    if (stmt.type !== "assignment") return null;
    const asn = stmt as Assignment;
    if (asn.pattern || asn.accessChain || asn.blockDepth) return null;
    if (!asn.variableName) return null;
    const value = asn.value as {
      type?: string;
      functionName?: string;
      call?: { type?: string; functionName?: string };
    };
    let call: { type?: string; functionName?: string } | undefined;
    if (value?.type === "functionCall") {
      call = value;
    } else if (
      value?.type === "tryExpression" &&
      value.call?.type === "functionCall"
    ) {
      call = value.call;
    }
    if (!call?.functionName) return null;
    // Object.hasOwn, not a truthy index: `destructiveFunctions` is a plain
    // object, so a call to a function named `toString` / `constructor` would
    // otherwise resolve an inherited prototype member as truthy and be
    // misclassified as destructive.
    return Object.hasOwn(
      this.compilationUnit.destructiveFunctions,
      call.functionName,
    )
      ? asn.variableName
      : null;
  }
}
