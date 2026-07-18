import { ts } from "../../ir/builders.js";
import { printTs } from "../../ir/prettyPrint.js";
import type { TsNode } from "../../ir/tsIR.js";
import type { AgencyNode } from "../../types.js";
import type { FinalizeBlock } from "../../types/finalizeBlock.js";
import type { ScopeManager } from "./scopeManager.js";
import * as renderFinalizeClosure from "../../templates/backends/typescriptGenerator/finalizeClosure.js";
import { formatTypeHintTs } from "../../utils/formatType.js";

/** Everything a scope's compilation needs from its (possible) finalize
 *  block. Produced by FinalizeCodegen.compileScope for every function and
 *  block scope, whether or not one was declared. */
export type CompiledScopeFinalize = {
  /** The scope's compiled statements, with the finalize stripped. */
  bodyCode: TsNode[];
  /** The `const __finalize = ...` closure declaration, or undefined when
   *  the scope declared no finalize. */
  decl: TsNode | undefined;
  /** `decl` rendered for the setup templates; "" when there is no
   *  finalize. Pre-rendered strings (not mustache sections) keep the
   *  no-finalize output byte-identical to the pre-finalize compiler. */
  declText: string;
  /** The catch-site abort return statement. With a finalize it runs the
   *  closure first (`.withFinalize`); without one it returns the plain
   *  AbortedResult. */
  abortReturn: string;
};

/**
 * Compiles `finalize { ... }` blocks: the statement-stream split, the
 * `__finalize` closure, and the abort stop sites that run it. Extracted
 * from TypeScriptBuilder so every finalize emission lives in one place.
 *
 * The model: a finalize is a declaration, not a statement. compileScope
 * strips it from the scope's statement stream and compiles it into a
 * `const __finalize = ...` closure. Three stop sites call the closure
 * through `AbortedResult.withFinalize`:
 *
 *   1. the frame catch — `abortReturn`, rendered into the catch template;
 *   2. the post-call aborted guard — `stopScope`, emitted by the
 *      builder's assignmentAbortedGuard;
 *   3. the return-position temp check — `interceptedReturn`.
 *
 * The closure runs on the container's own frame: locals live there, so
 * the finalize body reads them with zero passing. Runner step counters
 * are frame-keyed, so the closure's statements compile at STEP_BASE, a
 * disjoint id range the main body can never reach. Small ids would
 * collide with counters the main body already advanced past, silently
 * skipping the finalize's steps. Advancing the dying frame's counter past
 * the base is inert, because an aborted frame never resumes.
 */
export class FinalizeCodegen {
  /** Step-id base for compiled finalize bodies — far above anything a
   *  main body can reach. See the class doc. */
  private static readonly STEP_BASE = 1000000;

  /** One entry per function/block scope being compiled, true when that
   *  scope declared a finalize. Pushed/popped by compileScope, in
   *  lockstep with the builder's scope stack. */
  private presence: boolean[] = [];

  constructor(
    private readonly scopes: ScopeManager,
    private readonly moduleId: string,
    /** TypeScriptBuilder.processBodyAsParts — compiles statements with
     *  step ids starting at `stepBase`. */
    private readonly compileBody: (
      body: AgencyNode[],
      stepBase: number,
    ) => TsNode[],
  ) {}

  /**
   * Compile a scope's body, separating out its finalize block. Call with
   * the scope already pushed on the ScopeManager; `compileBodyRest` runs
   * between the presence push/pop so the finalize-aware return and
   * post-call lowerings see the right flag while the body compiles.
   */
  compileScope(args: {
    body: AgencyNode[];
    scopeName: string;
    /** The catch template's error binding: `__error` in function catches,
     *  `__blockError` in block catches. */
    errorVar: string;
    /** Compiles the scope's own statements (the stream minus the
     *  finalize). Owns the step base: functions start at 1 (id 0 is the
     *  onFunctionStart hook), blocks at 0. */
    compileBodyRest: (rest: AgencyNode[]) => TsNode[];
  }): CompiledScopeFinalize {
    // Defensive split: extras beyond the first finalize are dropped here
    // but already rejected by AG6032.
    const rest = args.body.filter((n) => n.type !== "finalizeBlock");
    const finalize = args.body.find(
      (n): n is FinalizeBlock => n.type === "finalizeBlock",
    );
    this.presence.push(finalize !== undefined);
    const bodyCode = args.compileBodyRest(rest);
    const decl = finalize ? this.closure(finalize, args.scopeName) : undefined;
    this.presence.pop();
    return {
      bodyCode,
      decl,
      declText: decl !== undefined ? printTs(decl, 0) + "\n" : "",
      abortReturn: this.abortReturn(
        args.scopeName,
        args.errorVar,
        finalize !== undefined,
      ),
    };
  }

  /** True when the innermost function/block scope being compiled declared
   *  a finalize. Drives the finalize-aware post-call guard and the
   *  return-position lowering. */
  isActive(): boolean {
    return this.presence[this.presence.length - 1] === true;
  }

  /** The statements every in-body stop site emits: halt the scope with
   *  the aborted result after running the finalize over it, then leave
   *  the step body. carryThrough applies the salvage rule (drop the
   *  callee's partial, carry this scope's own draft) before the finalize
   *  runs; the finalize's value then outranks the draft. */
  stopScope(abortedVar: string): TsNode[] {
    const scope = JSON.stringify(this.scopes.currentName());
    return [
      ts.raw(
        `runner.halt(await ${abortedVar}.carryThrough(${this.frameVar()}, ${scope}).withFinalize(__finalize, ${scope}))`,
      ),
      ts.return(),
    ];
  }

  /** Lower `return <call>` to a checked temp. A normal value returns
   *  exactly as before. An interrupt result passes through the temp as
   *  the return value, for the caller's post-call check to handle. An
   *  aborted result stops here and runs the finalize — pass-through would
   *  silently skip it. Nothing binds into a local: the value was headed
   *  for the return. */
  interceptedReturn(
    valueNode: TsNode,
    emit: (value: TsNode) => TsNode,
  ): TsNode {
    return ts.statements([
      ts.constDecl("__returnTemp", valueNode),
      ts.if(
        ts.raw("isAborted(__returnTemp)"),
        ts.statements(this.stopScope("__returnTemp")),
      ),
      emit(ts.id("__returnTemp")),
    ]);
  }

  /** Compile the finalize body into the `__finalize` closure. The fresh
   *  Runner shares the container's frame and gets a "#finalize" scope
   *  name; the disjoint step base (see the class doc) is what actually
   *  keeps its counters from colliding with the main body's. */
  private closure(finalize: FinalizeBlock, scopeName: string): TsNode {
    const parts = this.compileBody(finalize.body, FinalizeCodegen.STEP_BASE);
    const bodyStr = parts.map((n) => printTs(n, 1)).join("\n");
    // The binder is a plain closure parameter (never a frame local): it
    // was never declared via let/const, so body references print as the
    // bare identifier — the same mechanism inline handler params use.
    // AG6037 guarantees the name cannot collide with a real local, and
    // AG6038 guarantees at most one param reaches codegen. The TS
    // annotation follows the inline-handler-param convention: the
    // user's explicit annotation when written (plus the null arm the
    // empty slot implies), `any` otherwise. It is documentation only —
    // generated TS is transpiled, not type-checked; the enforced
    // typing is the checker's `T | null` on the Agency side.
    const binder = finalize.params[0];
    let binderParam = "";
    if (binder !== undefined) {
      const tsType = binder.typeHint
        ? `${formatTypeHintTs(binder.typeHint)} | null`
        : "any";
      binderParam = `${binder.name}: ${tsType}`;
    }
    return ts.raw(
      renderFinalizeClosure
        .default({
          binderParam,
          frameVar: this.frameVar(),
          moduleId: JSON.stringify(this.moduleId),
          scopeName: JSON.stringify(scopeName + "#finalize"),
          body: bodyStr,
        })
        .trimEnd(),
    );
  }

  private abortReturn(
    scopeName: string,
    errorVar: string,
    hasFinalize: boolean,
  ): string {
    const scope = JSON.stringify(scopeName);
    const fromError = `AbortedResult.fromError(${errorVar}, ${this.frameVar()}, ${scope})`;
    return hasFinalize
      ? `return await ${fromError}.withFinalize(__finalize, ${scope});`
      : `return ${fromError};`;
  }

  /** The frame variable generated scopes bind their own frame to. */
  private frameVar(): string {
    return this.scopes.current().type === "block" ? "__bstack" : "__stack";
  }
}
