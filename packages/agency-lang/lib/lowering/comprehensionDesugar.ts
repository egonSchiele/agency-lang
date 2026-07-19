import type { AgencyNode, Expression } from "../types.js";
import type { BlockArgument } from "../types/blockArgument.js";
import type { Comprehension } from "../types/comprehension.js";
import type { FunctionCall } from "../types/function.js";
import type { VariableNameLiteral } from "../types/literals.js";

/**
 * Rewrite every `comprehension` node into ordinary `map` / `filter` /
 * `fork` calls carrying block arguments - the exact shape those calls
 * have when written by hand. After this pass the rest of the compiler
 * cannot tell the construct existed, so typing, codegen, interrupts,
 * and fork branch semantics are inherited rather than reimplemented.
 *
 * Runs inside parseAgency's `if (lower)` block, BEFORE lowerPatterns, so
 * a destructuring binder becomes an ordinary pattern assignment that
 * lowerPatterns then handles with its existing machinery.
 *
 * MUTATES IN PLACE, for the same reason guardDesugar does: consumers
 * hold references to the same node objects, so a copying rewrite would
 * leave half the pipeline looking at stale bodies. Idempotent - a second
 * run finds no comprehension nodes.
 *
 * The `fork` case emits a real `fork` functionCall node rather than
 * calling a helper. `fork` is NOT a function: the builder intercepts it
 * at typescriptBuilder.ts processFunctionCall and compiles the block body
 * differently, supplying the branch stack and per-branch frames. A helper
 * receiving an ordinary lifted block would get none of that.
 * parallelDesugar.ts synthesizes the same shape for `parallel { }`, which
 * proves it compiles.
 */
export function desugarComprehensionsInBody(
  body: AgencyNode[],
): AgencyNode[] {
  body.forEach((node, i) => {
    body[i] = desugarNode(node);
  });
  return body;
}

/** The generated block parameter. Double underscore is compiler-reserved,
 *  so it cannot collide with a user binder. */
const PARAM = "__comprehensionItem";

/**
 * Apply `fn` to every object-valued child and put the result back.
 *
 * Deliberately generic rather than driven by `bodySlots` or
 * `expressionChildren`. `bodySlots` covers statement bodies only, and
 * `expressionChildren` is a read view with no writer, so neither alone
 * reaches every place a comprehension can appear: call arguments, object
 * literal fields, array items, binary operands, interpolations. A
 * hardcoded key list develops coverage holes; this cannot.
 *
 * `loc` is skipped because it holds plain position data, not nodes.
 */
function mapChildren(node: any, fn: (child: any) => any): void {
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach((item, i) => {
        if (item && typeof item === "object") child[i] = fn(item);
      });
    } else if (child && typeof child === "object") {
      node[key] = fn(child);
    }
  }
}

function desugarNode(node: AgencyNode): AgencyNode {
  if (!node || typeof node !== "object") return node;

  // Recurse first, so nested comprehensions lower innermost-out.
  mapChildren(node, desugarNode);

  if (node.type !== "comprehension") return node;
  return lower(node as Comprehension);
}

function varRef(name: string): VariableNameLiteral {
  return { type: "variableName", value: name };
}

function blockArg(body: AgencyNode[], paramName: string): BlockArgument {
  return {
    type: "blockArgument",
    params: [{ type: "functionParameter", name: paramName }],
    body,
  };
}

function call(
  functionName: string,
  args: Expression[],
  block: BlockArgument,
): FunctionCall {
  return { type: "functionCall", functionName, arguments: args, block };
}

function returnStmt(value: Expression): AgencyNode {
  return { type: "returnStatement", value } as AgencyNode;
}

/** The block parameter name. A single-name binder becomes the parameter
 *  directly, which keeps the user's own name in generated code and in
 *  diagnostics. Every other shape needs unpacking in the body, so it
 *  takes the reserved name. */
function paramNameFor(node: Comprehension): string {
  return typeof node.itemVar === "string" && !node.indexVar
    ? node.itemVar
    : PARAM;
}

function lower(node: Comprehension): FunctionCall {
  const paramName = paramNameFor(node);
  const source = node.condition
    ? call(
        "filter",
        [node.iterable],
        blockArg([returnStmt(node.condition)], paramName),
      )
    : node.iterable;

  return call(
    node.parallel ? "fork" : "map",
    [source],
    blockArg([returnStmt(node.expression)], paramName),
  );
}
