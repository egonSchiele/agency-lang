import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";
import type { AgencyNode } from "../types.js";
import type { ValueAccess } from "../types/access.js";
import type { NewExpression } from "../types/newExpression.js";
import type { StringLiteral } from "../types/literals.js";
import { walkNodes } from "../utils/node.js";
import { collectProgramShadowing } from "./shadowing.js";
import { resolveCall, SANDBOX_JS_GLOBALS } from "./resolveCall.js";
import { resolveVariable } from "./resolveVariable.js";

/**
 * Property names that walk from any value toward JavaScript's `Function` or
 * a prototype: `x.constructor.constructor` reaches `Function`, `__proto__`
 * and `prototype` reach the prototype chain. Reviewed security list, like
 * SANDBOX_JS_GLOBALS — review every addition.
 *
 * BEST-EFFORT: this catches the literal spellings only. A runtime-computed
 * key (`m[a + b]`) reaches the same property and no syntactic check can see
 * it. The real boundary for reaching Function and calling it with a string
 * is the `--disallow-code-generation-from-strings` layer (see
 * docs/dev/security/roadmap.md A1 layer 2); this is a clear compile-time
 * error for the obvious case, not the guarantee.
 */
const SANDBOX_FORBIDDEN_PROPERTIES = ["constructor", "prototype", "__proto__"];

/**
 * The `--agency-only` (jsGlobals: "sandbox") name checks that the two
 * general passes (undefinedFunctions / undefinedVariables) do not cover:
 *
 *   - `new` expression callees — `new Function(...)`, `new Proxy(...)`; the
 *     class name is a grammar literal the general passes never resolve.
 *   - forbidden property access on ANY value — `k.constructor`, which the
 *     function pass skips because the base is not a JS global.
 *   - names inside declaration-hanging expressions — `@validate(...)` /
 *     `@jsonSchema({...})` tag arguments and array/object default parameter
 *     values, which sit outside the scope bodies the general passes walk.
 *
 * The rule is shared: name resolution goes through the same
 * `resolveCall`/`resolveVariable` against SANDBOX_JS_GLOBALS the general
 * passes use. Only the set of positions differs.
 */
export function checkSandboxNames(ctx: TypeCheckerContext): void {
  if (ctx.config.typechecker?.jsGlobals !== "sandbox") return;

  const { importedNodeNames } = collectProgramShadowing(ctx.programNodes);

  // Positions the general passes DO reach (bodies): only the new-callee and
  // forbidden-property rules are added here — bare names and calls are
  // already reported by the general passes.
  for (const { node } of walkNodes(ctx.programNodes)) {
    checkNewCallee(node, ctx);
    checkForbiddenProperty(node, ctx);
  }

  // Positions the general passes do NOT reach (declaration-hanging
  // expressions): every name-bearing node is checked here, including bare
  // names and calls, since nothing else looks at them.
  for (const expr of collectDeclHangingExpressions(ctx.programNodes)) {
    for (const { node } of walkNodes([expr])) {
      checkNewCallee(node, ctx);
      checkForbiddenProperty(node, ctx);
      checkDeclExpressionName(node, ctx, importedNodeNames);
    }
  }
}

/** Refuse `new X()` whose class name is not an allowlisted global. The class
 *  name is a grammar literal (no `new (x + y)()`), so this is complete. */
function checkNewCallee(node: AgencyNode, ctx: TypeCheckerContext): void {
  if (node.type !== "newExpression") return;
  const className = (node as NewExpression).className;
  if (Object.prototype.hasOwnProperty.call(SANDBOX_JS_GLOBALS, className)) return;
  ctx.errors.push(
    diagnostic("undefinedFunction", { name: className }, node.loc ?? null, { severity: "error" }),
  );
}

/** Refuse `.constructor` / `.prototype` / `.__proto__`, spelled or as a
 *  string-literal computed key. A non-literal computed key is left alone
 *  (best-effort; layer 2 is the boundary). */
function checkForbiddenProperty(node: AgencyNode, ctx: TypeCheckerContext): void {
  if (node.type !== "valueAccess") return;
  for (const element of (node as ValueAccess).chain) {
    const name = forbiddenPropertyName(element);
    if (name === null) continue;
    ctx.errors.push(
      diagnostic("sandboxForbiddenProperty", { name }, node.loc ?? null, { severity: "error" }),
    );
  }
}

/** The forbidden property name a chain element names, or null. */
function forbiddenPropertyName(element: ValueAccess["chain"][number]): string | null {
  if (element.kind === "property" && SANDBOX_FORBIDDEN_PROPERTIES.includes(element.name)) {
    return element.name;
  }
  if (element.kind === "index") {
    const literal = stringLiteralValue(element.index);
    if (literal !== null && SANDBOX_FORBIDDEN_PROPERTIES.includes(literal)) return literal;
  }
  return null;
}

/** The constant value of a single-text-segment string literal, or null. */
function stringLiteralValue(node: AgencyNode): string | null {
  if (node.type !== "string") return null;
  const segments = (node as StringLiteral).segments;
  if (segments.length !== 1 || segments[0].type !== "text") return null;
  return segments[0].value;
}

/** A bare name or call inside a declaration-hanging expression. Resolved
 *  against SANDBOX_JS_GLOBALS with the program's defs/imports and no local
 *  scope (these expressions bind no locals of their own). A local `def`
 *  named in a `@validate(...)` still resolves via functionDefs. */
function checkDeclExpressionName(
  node: AgencyNode,
  ctx: TypeCheckerContext,
  importedNodeNames: readonly string[],
): void {
  if (node.type === "variableName") {
    const resolution = resolveVariable(node.value, {
      functionDefs: ctx.functionDefs,
      nodeDefs: ctx.nodeDefs,
      importedFunctions: ctx.importedFunctions,
      importedNodeNames,
      jsImportedNames: ctx.jsImportedNames,
      scopeHas: () => false,
      registry: SANDBOX_JS_GLOBALS,
    });
    if (resolution.kind === "unresolved") {
      ctx.errors.push(
        diagnostic("undefinedVariable", { name: node.value }, node.loc ?? null, {
          severity: "error",
        }),
      );
    }
  } else if (node.type === "functionCall" && typeof node.functionName === "string") {
    const resolution = resolveCall(node.functionName, {
      functionDefs: ctx.functionDefs,
      nodeDefs: ctx.nodeDefs,
      importedFunctions: ctx.importedFunctions,
      importedNodeNames,
      jsImportedNames: ctx.jsImportedNames,
      scopeHas: () => false,
      registry: SANDBOX_JS_GLOBALS,
    });
    if (resolution.kind === "unresolved") {
      ctx.errors.push(
        diagnostic("undefinedFunction", { name: node.functionName }, node.loc ?? null, {
          severity: "error",
        }),
      );
    }
  }
}

/**
 * Every expression that hangs off a declaration rather than sitting in an
 * executable body: `@validate(...)` / `@jsonSchema(...)` tag arguments, and
 * array/object default parameter values. Collected by a structural walk so
 * a tag on a type property (which `walkNodes` does not reach) is still
 * found. Each returned expression is then descended with `walkNodes`, so the
 * traversal of the expression itself is shared, not reimplemented.
 */
function collectDeclHangingExpressions(nodes: AgencyNode[]): AgencyNode[] {
  const found: AgencyNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;

    if (record.type === "tag" && Array.isArray(record.arguments)) {
      for (const arg of record.arguments) found.push(arg as AgencyNode);
    }
    // A parameter's array/object default holds arbitrary sub-expressions;
    // a bare Literal default cannot.
    if (
      record.defaultValue !== undefined &&
      record.defaultValue !== null &&
      typeof record.defaultValue === "object"
    ) {
      const dv = record.defaultValue as Record<string, unknown>;
      if (dv.type === "agencyArray" || dv.type === "agencyObject") {
        found.push(record.defaultValue as AgencyNode);
      }
    }

    for (const key of Object.keys(record)) {
      if (key === "loc") continue;
      visit(record[key]);
    }
  };
  visit(nodes);
  return found;
}
