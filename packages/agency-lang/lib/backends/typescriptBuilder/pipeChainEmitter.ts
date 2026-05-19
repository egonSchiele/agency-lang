import type {
  AgencyNode,
  Assignment,
  Expression,
  ScopeType,
} from "../../types.js";
import type { BinOpExpression } from "../../types/binop.js";
import type { AccessChainElement, ValueAccess } from "../../types/access.js";
import type { TsNode } from "../../ir/tsIR.js";
import { ts } from "../../ir/builders.js";
import { mapTypeToValidationSchema } from "../typescriptGenerator/typeToZodSchema.js";
import type { ScopeManager } from "./scopeManager.js";

/**
 * Callbacks PipeChainEmitter needs from the parent TypeScriptBuilder.
 *
 * Pipe lowering recursively delegates back into the main expression /
 * statement emitter, so we accept the relevant builder methods as
 * dependencies rather than holding a reference to the whole builder.
 */
export type PipeChainEmitterDeps = {
  processNode: (node: AgencyNode) => TsNode;
  /**
   * The builder's full ValueAccess lowering. Used to build pipe-stage
   * receivers correctly — see the doc comment on `processValueAccessPartial`.
   */
  processValueAccess: (node: ValueAccess) => TsNode;
  buildAssignmentLhs: (
    scope: ScopeType,
    varName: string,
    accessChain?: AccessChainElement[],
  ) => TsNode;
  buildStateConfig: () => TsNode;
  scopes: ScopeManager;
};

/**
 * Lowers `|>` pipe chains into runner steps.
 *
 * A pipe chain `a |> f |> g` is parsed left-associatively as
 * `(a |> f) |> g`. This emitter flattens that tree into ordered stages
 * (`[a, f, g]`) and produces one runner step per stage so that interrupts
 * resume between stages without replaying the earlier ones.
 *
 * Public API:
 *   - {@link tryGetChainStages} — flatten an assignment-of-pipe into stages
 *   - {@link expand}           — turn an assignment + stages into runner nodes
 *   - {@link bind}             — lower a bare `lhs |> rhs` expression
 */
export class PipeChainEmitter {
  private counter = 0;

  constructor(private deps: PipeChainEmitterDeps) {}

  /**
   * Walk a left-recursive `|>` tree under an assignment and return
   * [initial, stage1, stage2, ...] in evaluation order.
   * Returns null if the node is not an assignment whose value is a pipe chain.
   */
  tryGetChainStages(node: AgencyNode): Expression[] | null {
    if (node.type !== "assignment") return null;
    const expr = node.value;
    if (expr.type !== "binOpExpression" || expr.operator !== "|>") return null;

    const stages: Expression[] = [];
    let current: Expression = expr;
    while (
      current.type === "binOpExpression" &&
      (current as BinOpExpression).operator === "|>"
    ) {
      stages.push((current as BinOpExpression).right);
      current = (current as BinOpExpression).left;
    }
    stages.push(current);
    return stages.reverse();
  }

  /**
   * Lower a bare pipe expression `left |> stage` (not an assignment) into
   * `await __pipeBind(left, async (__pipeArg) => stage(__pipeArg))`.
   */
  bind(leftIR: TsNode, stage: Expression): TsNode {
    return ts.await(
      ts.call(ts.raw("__pipeBind"), [leftIR, this.buildPipeLambda(stage)]),
    );
  }

  /**
   * Expand a pipe-chain assignment into one runner node per stage.
   *
   * Layout (for `x = a |> f |> g`):
   *   step baseId+0:   __pipe_N = a
   *   pipe baseId+1:   __pipe_N = await __pipeBind(__pipe_N, lambda(f))
   *   pipe baseId+2:   x        = await __pipeBind(__pipe_N, lambda(g))
   *
   * If the assignment is validated (`x!: T = ...`), an extra runner step
   * wraps the final result in `__validateType`.
   */
  expand(
    stmt: Assignment,
    stages: Expression[],
    baseId: number,
  ): TsNode[] {
    const tempName = `__pipe_${this.counter++}`;
    const tempVar = ts.scopedVar(tempName, "local");
    const targetVar = this.deps.buildAssignmentLhs(
      stmt.scope!,
      stmt.variableName,
      stmt.accessChain,
    );
    const nodes: TsNode[] = [];

    nodes.push(
      ts.runnerStep({
        id: baseId,
        body: [ts.assign(tempVar, this.deps.processNode(stages[0]))],
      }),
    );

    for (let i = 1; i < stages.length - 1; i++) {
      nodes.push(
        ts.runnerPipe({
          id: baseId + i,
          target: tempVar,
          input: tempVar,
          fn: this.buildPipeLambda(stages[i]),
        }),
      );
    }

    const lastIdx = stages.length - 1;
    nodes.push(
      ts.runnerPipe({
        id: baseId + lastIdx,
        target: targetVar,
        input: tempVar,
        fn: this.buildPipeLambda(stages[lastIdx]),
      }),
    );

    if (stmt.validated && stmt.typeHint) {
      const zodSchema = mapTypeToValidationSchema(
        stmt.typeHint,
        this.deps.scopes.visibleTypeAliases(),
      );
      nodes.push(
        ts.runnerStep({
          id: baseId + stages.length,
          body: [ts.assign(targetVar, ts.validateType(targetVar, ts.raw(zodSchema)))],
        }),
      );
    }

    return nodes;
  }

  // ── Internal: arrow-function construction per stage ──

  private buildPipeLambda(stage: Expression): TsNode {
    const pipeArg = ts.raw("__pipeArg");

    if (stage.type === "valueAccess") {
      const lastElement = stage.chain[stage.chain.length - 1];

      // Method call with args (e.g. multiply.partial(a: 3)):
      // call the method first to produce a function, then invoke with piped value
      if (lastElement?.kind === "methodCall" && lastElement.functionCall.arguments.length > 0) {
        const fnExpr = this.deps.processNode(stage);
        const descriptor = ts.obj({ type: ts.str("positional"), args: ts.arr([pipeArg]) });
        const callExpr = ts.call(ts.id("__call"), [fnExpr, descriptor, this.deps.buildStateConfig()]);
        return ts.arrowFn([{ name: "__pipeArg" }], ts.await(callExpr), { async: true });
      }

      // No placeholder: bare method/property reference — use __callMethod to preserve `this`
      const receiver = this.processValueAccessPartial(stage);
      const lastEl = stage.chain[stage.chain.length - 1];
      const propName = lastEl.kind === "property" ? lastEl.name
        : lastEl.kind === "methodCall" ? lastEl.functionCall.functionName
          : null;
      if (propName) {
        const descriptor = ts.obj({ type: ts.str("positional"), args: ts.arr([pipeArg]) });
        const callExpr = ts.call(
          ts.id("__callMethod"),
          [receiver, ts.str(propName), descriptor, this.deps.buildStateConfig()],
        );
        return ts.arrowFn([{ name: "__pipeArg" }], ts.await(callExpr), { async: true });
      }
      // Fallback for non-property access (e.g. index): use __call
      const callee = this.deps.processNode(stage);
      const descriptor = ts.obj({ type: ts.str("positional"), args: ts.arr([pipeArg]) });
      const callExpr = ts.call(ts.id("__call"), [callee, descriptor, this.deps.buildStateConfig()]);
      return ts.arrowFn([{ name: "__pipeArg" }], ts.await(callExpr), { async: true });
    }

    if (stage.type === "variableName" || stage.type === "functionCall") {
      return ts.arrowFn([{ name: "__pipeArg" }], this.buildPipeStageBody(stage), { async: true });
    }

    if (stage.type === "binOpExpression" && stage.operator === "catch") {
      const innerBody = this.buildPipeStageBody(stage.left);
      const fallback = this.deps.processNode(stage.right as AgencyNode);
      const wrapped = ts.await(
        ts.call(ts.id("__catchResult"), [
          innerBody,
          ts.arrowFn([], ts.statements([ts.return(fallback)]), { async: true }),
        ]),
      );
      return ts.arrowFn([{ name: "__pipeArg" }], wrapped, { async: true });
    }

    throw new Error(`Invalid pipe stage type: ${stage.type}`);
  }

  /**
   * Build the body expression for a pipe stage (without the outer arrow
   * function wrapper). Returns `await __call(...)` — the caller wraps this
   * in an arrow function or `__catchResult(...)`.
   */
  private buildPipeStageBody(stage: Expression): TsNode {
    const pipeArg = ts.raw("__pipeArg");

    if (stage.type === "variableName") {
      const callee = this.deps.processNode(stage);
      const descriptor = ts.obj({ type: ts.str("positional"), args: ts.arr([pipeArg]) });
      return ts.await(ts.call(ts.id("__call"), [callee, descriptor, this.deps.buildStateConfig()]));
    }

    if (stage.type === "functionCall") {
      throw new Error(
        `Function call '${stage.functionName}(...)' cannot appear as a pipe stage. Use .partial() to bind arguments, e.g. ${stage.functionName}.partial(...)`,
      );
    }

    if (stage.type === "valueAccess") {
      const lastElement = stage.chain[stage.chain.length - 1];
      if (lastElement?.kind === "methodCall" && lastElement.functionCall.arguments.length > 0) {
        // e.g. map.partial(func: \x -> x * 2) — call the method, then invoke result with piped value
        const fnExpr = this.deps.processNode(stage);
        const descriptor = ts.obj({ type: ts.str("positional"), args: ts.arr([pipeArg]) });
        return ts.await(ts.call(ts.id("__call"), [fnExpr, descriptor, this.deps.buildStateConfig()]));
      }
      // Bare method/property reference — use __callMethod
      const receiver = this.processValueAccessPartial(stage);
      const lastEl = stage.chain[stage.chain.length - 1];
      const propName = lastEl.kind === "property" ? lastEl.name
        : lastEl.kind === "methodCall" ? lastEl.functionCall.functionName
          : null;
      if (propName) {
        const descriptor = ts.obj({ type: ts.str("positional"), args: ts.arr([pipeArg]) });
        return ts.await(ts.call(
          ts.id("__callMethod"),
          [receiver, ts.str(propName), descriptor, this.deps.buildStateConfig()],
        ));
      }
      const callee = this.deps.processNode(stage);
      const descriptor = ts.obj({ type: ts.str("positional"), args: ts.arr([pipeArg]) });
      return ts.await(ts.call(ts.id("__call"), [callee, descriptor, this.deps.buildStateConfig()]));
    }

    throw new Error(`Unsupported pipe stage type in catch: ${stage.type}`);
  }

  /**
   * Process a ValueAccess up to but not including the last chain element.
   * Used by pipe lowering to get the receiver for a method call —
   * the LAST chain element is the pipe stage's method name, which the
   * caller hands to `__callMethod(receiver, name, …)` directly.
   *
   * Delegates to the builder's full `processValueAccess` (via deps) on
   * a synthetic node with `chain.slice(0, -1)`. This keeps every
   * subtlety of receiver lowering in one place — awaiting + paren-
   * wrapping a `functionCall` base, paren-wrapping a non-trivial base,
   * propagating the `optional` flag through chain elements, handling
   * the `call` chain-element kind, etc. Previously this method
   * duplicated the chain-walk and silently dropped all of those
   * behaviours; see the "pipe receiver precedence" issue for the
   * shapes that were broken (`getObj().foo.bar |> stage`, `obj?.foo
   * |> stage`, `factories.makeOne().bar |> stage`, etc.).
   */
  private processValueAccessPartial(node: ValueAccess): TsNode {
    return this.deps.processValueAccess({
      ...node,
      chain: node.chain.slice(0, -1),
    });
  }
}
