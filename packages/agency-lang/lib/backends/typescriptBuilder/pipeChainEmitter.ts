import type { AgencyNode, Assignment, Expression } from "../../types.js";
import { BinOpExpression } from "../../../lib/types/binop.js";
import type { ValueAccess } from "../../types/access.js";
import type { FunctionCall } from "../../types/function.js";
import type { TsNode } from "../../ir/tsIR.js";
import { $, ts } from "../../ir/builders.js";
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
  buildAssignmentLhs: (
    scope: import("../../types.js").ScopeType,
    varName: string,
    accessChain?: import("../../types/access.js").AccessChainElement[],
  ) => TsNode;
  buildStateConfig: () => TsNode;
  generateFunctionCallExpression: (
    call: FunctionCall,
    context: "topLevelStatement" | "functionArg" | "valueAccess",
  ) => TsNode;
  str: (node: TsNode) => string;
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
   * Process a valueAccess up to but not including the last chain element.
   * Used by pipe lowering to get the receiver for a method call.
   */
  private processValueAccessPartial(node: ValueAccess): TsNode {
    let result = this.deps.processNode(node.base);
    for (let i = 0; i < node.chain.length - 1; i++) {
      const element = node.chain[i];
      switch (element.kind) {
        case "property":
          result = ts.prop(result, element.name);
          break;
        case "index":
          result = ts.index(result, this.deps.processNode(element.index));
          break;
        case "slice": {
          const args: TsNode[] = [];
          if (element.start) {
            args.push(this.deps.processNode(element.start));
            if (element.end) args.push(this.deps.processNode(element.end));
          } else if (element.end) {
            args.push(ts.raw("0"));
            args.push(this.deps.processNode(element.end));
          }
          result = $(result).prop("slice").call(args).done();
          break;
        }
        case "methodCall": {
          const callNode = this.deps.generateFunctionCallExpression(
            element.functionCall,
            "valueAccess",
          );
          if (
            callNode.kind === "call" &&
            callNode.callee.kind === "identifier"
          ) {
            result = $(result)
              .prop(callNode.callee.name)
              .call(callNode.arguments)
              .done();
          } else {
            result = ts.raw(`${this.deps.str(result)}.${this.deps.str(callNode)}`);
          }
          break;
        }
      }
    }
    return result;
  }
}
