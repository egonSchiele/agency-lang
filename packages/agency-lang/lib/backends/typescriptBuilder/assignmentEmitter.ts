import type { AgencyNode, ScopeType } from "../../types.js";
import type { AccessChainElement } from "../../types/access.js";
import type { FunctionCall } from "../../types/function.js";
import type { TsNode } from "../../ir/tsIR.js";
import { $, ts } from "../../ir/builders.js";

/**
 * Callbacks AssignmentEmitter needs from the parent TypeScriptBuilder.
 *
 * Access chains and slice bounds can contain arbitrary expressions, so we
 * take the relevant builder routines as dependencies rather than holding
 * a reference to the whole builder.
 */
export type AssignmentEmitterDeps = {
  moduleId: string;
  processNode: (node: AgencyNode) => TsNode;
  buildCallDescriptor: (call: FunctionCall) => TsNode;
  buildStateConfig: () => TsNode | undefined;
  /** Resolve a relative block depth to the owning block's frame binding
   *  (`__bframe_<blockName>`), or undefined for the current block. */
  resolveBlockFrameVar: (blockDepth: number) => string | undefined;
};

/**
 * Encapsulates the construction of assignment LHS nodes and assignment
 * statements. This is the boring half of assignment lowering — building
 * `obj.foo[i] = value` style nodes from a scope + variable name + access
 * chain.
 *
 * The interesting / stateful half (handling llm calls, interrupts, async
 * function calls, message threads, etc.) stays in TypeScriptBuilder
 * because it touches most other subsystems; extracting it would not
 * meaningfully reduce coupling.
 *
 * Public API:
 *   - {@link scopedAssign} — build a full assignment statement
 *     (`lhs = value`, or `__ctx.globals.set(...)` for globals, or
 *     `.splice(...)` for slice assignment)
 *   - {@link lhs}          — build just the assignment target node
 *   - {@link accessChain}  — apply an access chain to an arbitrary base
 *     expression (used for `this.field = value` lowering)
 */
export class AssignmentEmitter {
  constructor(private deps: AssignmentEmitterDeps) {}

  /**
   * Assign a value to a scoped variable.
   *
   * - Global scope, no access chain → `__ctx.globals.set(moduleId, name, value)`
   * - Slice as the last access element → array `.splice(...)` call
   * - Otherwise → ordinary `lhs = value`
   */
  scopedAssign(
    scope: ScopeType,
    varName: string,
    value: TsNode,
    accessChain?: AccessChainElement[],
    blockDepth = 0,
  ): TsNode {
    if (
      accessChain &&
      accessChain.length > 0 &&
      accessChain[accessChain.length - 1].kind === "slice"
    ) {
      return this.sliceAssign(scope, varName, value, accessChain, blockDepth);
    }
    if (scope === "global" && (!accessChain || accessChain.length === 0)) {
      return ts.globalSet(this.deps.moduleId, varName, value);
    }
    return ts.assign(this.lhs(scope, varName, accessChain, blockDepth), value);
  }

  /** Build the assignment target node (no value) for `scope.varName.chain`. */
  lhs(
    scope: ScopeType,
    variableName: string,
    chain?: AccessChainElement[],
    blockDepth = 0,
  ): TsNode {
    const blockFrameVar =
      scope === "block" || scope === "blockArgs"
        ? this.deps.resolveBlockFrameVar(blockDepth)
        : undefined;
    return this.accessChain(
      ts.scopedVar(variableName, scope, this.deps.moduleId, blockFrameVar),
      chain,
    );
  }

  /**
   * Apply an access chain (`.foo`, `[i]`, `.method(args)`) to an
   * arbitrary base expression. Used both for ordinary LHS construction
   * and for `this.field = value` / `super.field = value` lowering where
   * the base is a bare identifier rather than a scoped variable.
   */
  accessChain(base: TsNode, chain?: AccessChainElement[]): TsNode {
    if (!chain || chain.length === 0) return base;
    let result = base;
    for (const el of chain) {
      switch (el.kind) {
        case "property":
          result = ts.prop(result, el.name);
          break;
        case "index":
          result = ts.index(result, this.deps.processNode(el.index));
          break;
        case "methodCall": {
          const fnCall = el.functionCall;
          const config = this.deps.buildStateConfig();
          const callArgs: TsNode[] = [
            result,
            ts.str(fnCall.functionName),
            this.deps.buildCallDescriptor(fnCall),
          ];
          if (config) callArgs.push(config);
          const callExpr = ts.call(ts.id("__callMethod"), callArgs);
          result = ts.await(callExpr);
          break;
        }
      }
    }
    return result;
  }

  /**
   * Slice assignment lowering:
   *
   *   arr[1:3] = [10, 20]  →  arr.splice(1, 3 - 1, ...[10, 20])
   *   arr[2:]  = [10]      →  arr.splice(2, arr.length - 2, ...[10])
   */
  private sliceAssign(
    scope: ScopeType,
    varName: string,
    value: TsNode,
    accessChain: AccessChainElement[],
    blockDepth = 0,
  ): TsNode {
    const sliceEl = accessChain[accessChain.length - 1] as Extract<
      AccessChainElement,
      { kind: "slice" }
    >;
    const baseChain = accessChain.length > 1 ? accessChain.slice(0, -1) : undefined;
    const base = this.lhs(scope, varName, baseChain, blockDepth);

    const startNode = sliceEl.start ? this.deps.processNode(sliceEl.start) : ts.raw("0");
    const endNode = sliceEl.end
      ? this.deps.processNode(sliceEl.end)
      : ts.prop(base, "length");
    const deleteCount = ts.binOp(endNode, "-", startNode);

    return $(base)
      .prop("splice")
      .call([startNode, deleteCount, ts.spread(value)])
      .done();
  }
}
