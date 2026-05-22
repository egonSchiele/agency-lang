import type {
  AgencyNode,
  AgencyProgram,
  Assignment,
  FunctionCall,
  FunctionDefinition,
  GraphNodeDefinition,
} from "@/types.js";
import type { ImportedFunctionSignature } from "@/compilationUnit.js";
import type { VariableType } from "@/types/typeHints.js";
import type { FunctionParameter } from "@/types/function.js";
import type { SchemaExpression } from "@/types/schemaExpression.js";
import { findSchemaParam } from "@/utils/schemaParam.js";

/**
 * Preprocessor pass: inject `schema(T)` arguments at call sites whose
 * target function declares a `Schema<...>` parameter that the caller
 * did not supply explicitly. The expected type `T` is derived from
 * the call's context: the LHS annotation of a `const`/`let`, or the
 * enclosing function's declared return type when the call is the
 * value of a `return` statement.
 *
 * Why a preprocessor pass:
 *   - Keeps the type checker simple (a Schema param is treated as
 *     "always optional" — see `paramListSignature`).
 *   - Keeps the TypeScript builder simple — calls reach the builder
 *     with all arguments explicit. Downstream tools (`agency fmt`,
 *     `pnpm run ast`) still see the original user-written AST because
 *     this pass runs only inside the TS preprocessor.
 *   - The injected node is a regular `schemaExpression`, so codegen
 *     for it already works (it's the same node `schema(T)` produces).
 *
 * Rules:
 *   - At most one Schema-typed parameter per function (enforced lazily,
 *     only when the function is actually called from a context where
 *     the rule matters; see `findSchemaParam`).
 *   - If the caller passes the Schema arg explicitly (positional or
 *     named), no injection happens.
 *   - If no expected type is available, no injection happens and the
 *     missing argument is reported as a normal type error elsewhere.
 *     (Practically, the type checker skips arity for Schema params,
 *     so the user would see a downstream runtime error when the
 *     function tries to use the missing schema. We trade that for a
 *     simpler implementation; the documentation in `appendix/`
 *     spells out the contract for users.)
 */
export function injectSchemaArgsInProgram(
  program: AgencyProgram,
  functionDefinitions: Record<string, FunctionDefinition>,
  importedFunctions: Record<string, ImportedFunctionSignature>,
): void {
  const lookup = (name: string): FunctionParameter[] | undefined =>
    functionDefinitions[name]?.parameters ??
    importedFunctions[name]?.parameters;

  // Top-level program nodes (graph nodes, exported function defs, etc.)
  // get walked through their bodies below — the program body itself
  // doesn't host return statements, but it does host top-level `const`
  // / `let` assignments.
  walkBody(program.nodes, undefined, lookup);

  for (const fn of Object.values(functionDefinitions)) {
    walkBody(fn.body, fn.returnType ?? undefined, lookup);
  }

  for (const node of program.nodes) {
    if (node.type === "graphNode") {
      walkBody(node.body, undefined, lookup);
    }
  }
}

/**
 * Walk a body recursively, processing each statement. `enclosingReturnType`
 * is the declared return type of the function whose body we are inside;
 * `undefined` means there is none (e.g. graph nodes, top-level, or a
 * function with no return annotation).
 */
function walkBody(
  body: AgencyNode[],
  enclosingReturnType: VariableType | undefined,
  lookup: (name: string) => FunctionParameter[] | undefined,
): void {
  for (const node of body) {
    walkNode(node, enclosingReturnType, lookup);
  }
}

function walkNode(
  node: AgencyNode,
  enclosingReturnType: VariableType | undefined,
  lookup: (name: string) => FunctionParameter[] | undefined,
): void {
  if (node.type === "assignment") {
    handleAssignment(node, lookup);
  } else if (node.type === "returnStatement") {
    if (node.value && enclosingReturnType) {
      handleExpectedAt(node.value, enclosingReturnType, lookup);
    }
  } else if (node.type === "ifElse") {
    walkBody(node.thenBody, enclosingReturnType, lookup);
    if (node.elseBody) walkBody(node.elseBody, enclosingReturnType, lookup);
  } else if (
    node.type === "forLoop" ||
    node.type === "whileLoop" ||
    node.type === "messageThread"
  ) {
    walkBody(node.body, enclosingReturnType, lookup);
  } else if (node.type === "matchBlock") {
    for (const caseItem of node.cases) {
      if (caseItem.type === "comment" || caseItem.type === "newLine") continue;
      // Match case bodies are themselves nodes; treat as a 1-node body.
      walkNode(caseItem.body, enclosingReturnType, lookup);
    }
  } else if (node.type === "handleBlock") {
    walkBody(node.body, enclosingReturnType, lookup);
    if (node.handler.kind === "inline") {
      walkBody(node.handler.body, enclosingReturnType, lookup);
    }
  } else if (node.type === "withModifier") {
    walkNode(node.statement, enclosingReturnType, lookup);
  } else if (node.type === "functionCall" && node.block) {
    walkBody(node.block.body, enclosingReturnType, lookup);
  } else if (node.type === "parallelBlock" || node.type === "seqBlock") {
    walkBody(node.body, enclosingReturnType, lookup);
  } else if (node.type === "classDefinition") {
    for (const method of node.methods) {
      walkBody(method.body, method.returnType, lookup);
    }
  }
}

/**
 * `const x: T = call(...)` — propagate `T` as the expected type into
 * the call. Reassignments (`x = call(...)`) carry no annotation, so
 * they are skipped (no injection from already-typed variable refs;
 * could be added later if there's demand).
 */
function handleAssignment(
  node: Assignment,
  lookup: (name: string) => FunctionParameter[] | undefined,
): void {
  if (!node.typeHint) return;
  handleExpectedAt(node.value, node.typeHint, lookup);
}

/**
 * Try to inject a schema arg into a call expression. The expression is
 * accepted as a function call directly, or as an `if`/`match` whose
 * branches each yield a call — recurses through those to inject in
 * every branch (each branch's call gets the same expected type).
 *
 * Other expression shapes (binary ops, value access, etc.) are not
 * recursed into. The user can always pass the schema explicitly when
 * they need it in those positions.
 */
function handleExpectedAt(
  expr: AgencyNode,
  expectedType: VariableType,
  lookup: (name: string) => FunctionParameter[] | undefined,
): void {
  if (expr.type === "functionCall") {
    maybeInject(expr, expectedType, lookup);
    return;
  }
  if (expr.type === "ifElse") {
    for (const stmt of expr.thenBody) {
      if (stmt.type === "returnStatement" && stmt.value) {
        handleExpectedAt(stmt.value, expectedType, lookup);
      }
    }
    if (expr.elseBody) {
      for (const stmt of expr.elseBody) {
        if (stmt.type === "returnStatement" && stmt.value) {
          handleExpectedAt(stmt.value, expectedType, lookup);
        }
      }
    }
    return;
  }
}

function maybeInject(
  call: FunctionCall,
  expectedType: VariableType,
  lookup: (name: string) => FunctionParameter[] | undefined,
): void {
  const params = lookup(call.functionName);
  if (!params) return;

  const schemaParam = findSchemaParam(params, call.functionName);
  if (!schemaParam) return;

  // Already supplied?
  if (isSchemaArgSupplied(call, schemaParam.index, schemaParam.param.name)) {
    return;
  }

  // Build a synthetic `schema(T)` AST node and append it. The codegen
  // for `schemaExpression` already exists — `processSchemaExpression`
  // in the TypeScript builder lowers it to a Zod schema reference.
  //
  // We name-tag the inject as a named arg so it doesn't fight ordering
  // with later positional arguments (none today; defends against
  // future calls that interleave positional and named).
  const injected: SchemaExpression = {
    type: "schemaExpression",
    typeArg: expectedType,
    loc: call.loc,
  };
  call.arguments.push({
    type: "namedArgument",
    name: schemaParam.param.name,
    value: injected,
  });
}

/**
 * Decide whether the caller already supplied the Schema parameter:
 *   - a positional arg at the right index (and the call is positional
 *     up to that point — no named args appearing earlier)
 *   - a named arg matching the param's name
 *
 * Splat args are conservative: we treat a splat anywhere before the
 * Schema slot as "may have supplied it" and skip injection (the runtime
 * would receive the unrolled splat values).
 */
function isSchemaArgSupplied(
  call: FunctionCall,
  paramIndex: number,
  paramName: string,
): boolean {
  // Named arg match.
  for (const arg of call.arguments) {
    if (arg.type === "namedArgument" && arg.name === paramName) return true;
  }
  // Splat before the slot → can't tell statically.
  for (let i = 0; i < Math.min(call.arguments.length, paramIndex); i++) {
    if (call.arguments[i].type === "splat") return true;
  }
  // Positional fill — any non-named arg at the Schema slot counts.
  if (paramIndex < call.arguments.length) {
    const arg = call.arguments[paramIndex];
    if (arg.type !== "namedArgument") return true;
  }
  return false;
}
