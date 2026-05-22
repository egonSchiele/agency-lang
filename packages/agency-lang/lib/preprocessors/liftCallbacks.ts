import type { AgencyNode, AgencyProgram, Expression } from "@/types.js";
import type { FunctionCall, FunctionDefinition } from "@/types/function.js";
import type { VariableNameLiteral } from "@/types/literals.js";
import { walkNodes } from "@/utils/node.js";

/**
 * Lifts `callback("onX") as data { ... body ... }` (or the bare `{ ... }`
 * form) into a synthesized top-level `def __cb_<scope>_<n>(data: any) { ... }`
 * plus a rewritten `callback("onX", __cb_<scope>_<n>)` call.
 *
 * Why:
 *   - Inline closures over `__ctx` (created at the call site by codegen) do
 *     NOT survive interrupt + resume — the resurrected closure references a
 *     dead `__ctx` from the previous run. Lifting to a top-level `def` makes
 *     the callback a registered AgencyFunction whose serialized form is just
 *     its name, and which is re-bound to the live `__ctx` on resume through
 *     the normal function-registry path.
 *
 *   - As a side benefit, the typechecker now sees the lifted body as an
 *     ordinary top-level function — so any reference to an enclosing
 *     function/node local becomes a normal "Variable 'x' is not defined"
 *     diagnostic from `undefinedVariableDiagnostic.ts`, with the original
 *     source location preserved.
 *
 * Named-fn form (`callback("onX", myFn)`) has no `block` and passes through
 * unchanged.
 *
 * Must run BEFORE `buildCompilationUnit` so the lifted defs appear in
 * `info.functionDefinitions`, and BEFORE typecheck so the
 * undefined-variable check runs over them.
 */

const NAME_PREFIX = "__cb";

let counter = 0;

function nextName(scope: string): string {
  return `${NAME_PREFIX}_${scope}_${counter++}`;
}

/** Reset for deterministic tests. Production callers never need this. */
export function resetCallbackCounter(): void {
  counter = 0;
}

export function liftCallbackBlocks(program: AgencyProgram): AgencyProgram {
  resetCallbackCounter();
  const lifted: FunctionDefinition[] = [];
  const newNodes: AgencyNode[] = [];

  for (const node of program.nodes) {
    newNodes.push(transformTopLevel(node, lifted));
  }

  const result: AgencyProgram = { ...program, nodes: [...lifted, ...newNodes] };
  assertNoUnliftedCallbackBlocks(result);
  return result;
}

/**
 * After lifting, scan the whole program for any `callback("...") { ... }`
 * call that still carries a `block`. These can only come from positions
 * the statement-oriented transformer doesn't descend into — currently
 * non-statement expression positions like a function argument
 * (`outer(callback("onX") { ... })`), a binop operand, or an array/object
 * literal element. `callback()` returns nothing, so these uses don't make
 * semantic sense; rather than silently emit an inline `__AgencyFunction.create({ fn: ... })`
 * closure that would re-introduce the resume-bug this whole module
 * exists to fix, fail loudly with a clear diagnostic pointing at the
 * source location.
 */
function assertNoUnliftedCallbackBlocks(program: AgencyProgram): void {
  for (const { node } of walkNodes(program.nodes)) {
    if (
      node.type === "functionCall" &&
      node.functionName === "callback" &&
      node.block
    ) {
      const loc = node.loc
        ? ` at line ${node.loc.line}, col ${node.loc.col}`
        : "";
      throw new Error(
        `callback("...") { ... } block is only supported at statement ` +
          `position${loc}. Bind to a let/const first, or use the named-function ` +
          `form: callback("...", myFn).`,
      );
    }
  }
}

/**
 * Walk a top-level node. For `function` / `graphNode` bodies we descend with
 * the enclosing-scope name; everything else uses `"top"` as the scope name.
 *
 * Mutates `node` in place (matches `parallelDesugar`'s pattern).
 */
function transformTopLevel(
  node: AgencyNode,
  lifted: FunctionDefinition[],
): AgencyNode {
  if (node.type === "function") {
    node.body = transformBody(node.body, node.functionName, lifted);
    return node;
  }
  if (node.type === "graphNode") {
    node.body = transformBody(node.body, node.nodeName, lifted);
    return node;
  }
  if (node.type === "classDefinition") {
    for (const m of node.methods) {
      m.body = transformBody(m.body, `${node.className}_${m.name}`, lifted);
    }
    return node;
  }
  // Statements at module top level (assignments, top-level callback calls).
  return transformStatement(node, "top", lifted);
}

function transformBody(
  body: AgencyNode[],
  scopeName: string,
  lifted: FunctionDefinition[],
): AgencyNode[] {
  return body.map((n) => transformStatement(n, scopeName, lifted));
}

/**
 * Transform a single statement. Handles `functionCall` (the actual lift
 * trigger) and recurses into control-flow constructs. The enclosing-scope
 * name does NOT change when we descend into `if` / `for` / etc. — only
 * `function` / `graphNode` reset it (handled in `transformTopLevel`).
 */
function transformStatement(
  node: AgencyNode,
  scopeName: string,
  lifted: FunctionDefinition[],
): AgencyNode {
  switch (node.type) {
    case "functionCall":
      return transformFunctionCall(node, scopeName, lifted);
    case "ifElse":
      node.thenBody = transformBody(node.thenBody, scopeName, lifted);
      if (node.elseBody) node.elseBody = transformBody(node.elseBody, scopeName, lifted);
      return node;
    case "forLoop":
    case "whileLoop":
    case "messageThread":
      node.body = transformBody(node.body, scopeName, lifted);
      return node;
    case "handleBlock":
      node.body = transformBody(node.body, scopeName, lifted);
      if (node.handler.kind === "inline") {
        node.handler.body = transformBody(node.handler.body, scopeName, lifted);
      }
      return node;
    case "matchBlock":
      for (const c of node.cases) {
        if (c.type === "comment") continue;
        if (c.type === "newLine") continue;
        c.body = transformBody([c.body as any], scopeName, lifted)[0] as any;
      }
      return node;
    case "withModifier":
      node.statement = transformBody([node.statement as any], scopeName, lifted)[0];
      return node;
    case "parallelBlock":
    case "seqBlock":
      node.body = transformBody(node.body, scopeName, lifted);
      return node;
    case "assignment":
      // RHS may itself be a function call with a block (e.g. `let x = foo() { ... }`).
      if (node.value && (node.value as AgencyNode).type === "functionCall") {
        node.value = transformFunctionCall(
          node.value as FunctionCall,
          scopeName,
          lifted,
        ) as any;
      }
      return node;
    case "returnStatement":
      if (node.value && (node.value as AgencyNode).type === "functionCall") {
        node.value = transformFunctionCall(
          node.value as FunctionCall,
          scopeName,
          lifted,
        ) as any;
      }
      return node;
    default:
      return node;
  }
}

/**
 * Lift `callback("onX") { ... }` if present; otherwise pass through after
 * recursing into any block body (other block-form calls like `xs.map()`).
 */
function transformFunctionCall(
  call: FunctionCall,
  scopeName: string,
  lifted: FunctionDefinition[],
): FunctionCall {
  // Recurse into a non-callback block body first so nested callback blocks
  // inside e.g. `xs.map()` get lifted too.
  if (call.block && call.functionName !== "callback") {
    call.block.body = transformBody(call.block.body, scopeName, lifted);
    return call;
  }

  if (call.functionName !== "callback" || !call.block) {
    return call;
  }

  const block = call.block;
  // Recurse first so any nested `callback(...) { ... }` inside this block body
  // is lifted before we lift the outer one. Lifted ordering doesn't matter
  // (all lifted defs go to module top), but recursion preserves source
  // ordering within `lifted`, which makes test output predictable.
  block.body = transformBody(block.body, scopeName, lifted);

  const name = nextName(scopeName);
  // Runtime hook dispatch always invokes the callback's AgencyFunction
  // via `fn.invoke({ type: "positional", args: [eventData] })`
  // (see `invokeCallback` in lib/runtime/hooks.ts), which lowers to
  // `__cb_*_impl(eventData, __state)` at the JS level. If we declare
  // zero parameters here the event data lands in the synthesized
  // `__state` slot instead — silently corrupting state for any callback
  // body that uses the bare `callback("onX") { ... }` form (no
  // `as data`). Synthesize a single `data: any` parameter when the
  // source omits it; user code can't reference it (the name isn't in
  // scope without `as data`), but the calling convention stays
  // consistent with the named-fn form.
  const parameters = block.params.length > 0
    ? block.params.map((p) => ({
        type: "functionParameter" as const,
        name: p.name,
        typeHint: { type: "primitiveType" as const, value: "any" as const },
      }))
    : [{
        type: "functionParameter" as const,
        name: "data",
        typeHint: { type: "primitiveType" as const, value: "any" as const },
      }];
  const liftedDef: FunctionDefinition = {
    type: "function",
    functionName: name,
    parameters,
    body: block.body,
    returnType: null,
    loc: block.loc ?? call.loc,
  };
  lifted.push(liftedDef);

  // Build a `variableName` arg referencing the lifted def.
  const fnRef: VariableNameLiteral = {
    type: "variableName",
    value: name,
    loc: call.loc,
  };

  const rewritten: FunctionCall = {
    ...call,
    block: undefined,
    arguments: [...call.arguments, fnRef as Expression],
  };
  return rewritten;
}
