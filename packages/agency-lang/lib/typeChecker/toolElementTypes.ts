/**
 * Refuse an `llm()` tools entry that is provably a plain value (issue #769).
 *
 *   import { summary } from "std::wikipedia"
 *   const summary: string = llm("...", tools: [summary])
 *
 * Inside the list `summary` is the new local, a string that is still
 * unassigned, so the call fails at runtime with "received undefined". The
 * `tools` option is typed `any[]`, so nothing else catches it.
 *
 * Only primitives and literals are refused. An object or an `any` may hold a
 * tool built elsewhere, and the runtime check covers those.
 */
import { diagnostic } from "./diagnostics.js";
import { synthType } from "./synthesizer.js";
import { safeResolveType } from "./assignability.js";
import { isAnyType } from "./utils.js";
import { formatTypeHint } from "../utils/formatType.js";
import { findToolsOption, resolveStaticTools } from "./toolBlockBinding.js";
import type { AgencyNode, Expression, FunctionCall, VariableType } from "../types.js";
import type { Scope } from "./scope.js";
import type { TypeCheckerContext } from "./types.js";

const PLAIN_PRIMITIVES = ["string", "number", "boolean", "regex", "null", "void"];
const LITERAL_TYPES = ["stringLiteralType", "numberLiteralType", "booleanLiteralType"];

function isPlainValue(resolved: VariableType): boolean {
  if (resolved.type === "primitiveType") {
    return PLAIN_PRIMITIVES.includes(resolved.value);
  }
  return LITERAL_TYPES.includes(resolved.type);
}

/** Says so when the plain value hides a function of the same name. */
function shadowHint(toolExpr: AgencyNode, ctx: TypeCheckerContext): string {
  if (toolExpr.type !== "variableName") return "";
  const name = toolExpr.value;
  if (!ctx.functionDefs[name] && !ctx.importedFunctions[name]) return "";
  return ` A local variable named '${name}' hides the function '${name}' here. Rename the variable.`;
}

export function checkToolElementTypes(
  call: FunctionCall,
  scope: Scope,
  ctx: TypeCheckerContext,
): void {
  for (const toolExpr of resolveStaticTools(findToolsOption(call))) {
    const actual = synthType(toolExpr as Expression, scope, ctx);
    if (isAnyType(actual)) continue;
    const resolved = safeResolveType(actual, ctx.getTypeAliases());
    if (isAnyType(resolved) || !isPlainValue(resolved)) continue;
    ctx.errors.push(
      diagnostic(
        "toolIsNotAFunction",
        {
          expr: toolExpr.type === "variableName" ? toolExpr.value : "This entry",
          actual: formatTypeHint(actual),
          shadowHint: shadowHint(toolExpr, ctx),
        },
        toolExpr.loc ?? call.loc ?? null,
      ),
    );
  }
}
