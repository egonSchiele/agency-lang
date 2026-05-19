import type {
  Expression,
  AgencyObject,
  AgencyObjectKV,
  SplatExpression,
  AgencyProgram,
} from "../types.js";
import type { CompilationUnit } from "../compilationUnit.js";

/**
 * Enforces the spec's restriction on what may appear inside `@jsonSchema(...)`:
 *
 * - String / number / boolean / null literals.
 * - Object literals containing only allowed expressions / spreads.
 * - Function calls to top-level `def` functions or imported functions,
 *   whose arguments are themselves allowed expressions.
 * - Identifiers that resolve to a static `const` global (module-level
 *   `const` binding, including const-bound imports). `let` bindings,
 *   function parameters, and local declarations are rejected.
 *
 * Anything else (member access, ternaries, binary ops, pipes, template
 * strings, array literals, etc.) is rejected.
 */
export type JsonSchemaArgValidationResult =
  | { ok: true }
  | { ok: false; reason: string; loc?: { line: number; col: number } };

/**
 * Subset of the compilation unit we need to look up identifiers.
 * Kept minimal so unit tests don't need a full CompilationUnit.
 */
export type JsonSchemaArgScope = {
  /** Names that resolve to a top-level const binding in this module. */
  topLevelConstNames: Set<string>;
  /** Names imported from another module (treated as const-bound). */
  importedNames: Set<string>;
  /** Names of top-level `def` functions. */
  topLevelFunctionNames: Set<string>;
};

export function validateJsonSchemaArg(
  expr: Expression,
  scope: JsonSchemaArgScope,
): JsonSchemaArgValidationResult {
  switch (expr.type) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      return { ok: true };

    case "agencyObject":
      return validateObjectLiteral(expr as AgencyObject, scope);

    case "functionCall":
      return validateFunctionCall(expr, scope);

    case "variableName":
      return validateIdentifier(expr, scope);

    default:
      return {
        ok: false,
        reason: `expressions of type "${expr.type}" are not allowed inside @jsonSchema(...)`,
        loc: (expr as any).loc,
      };
  }
}

function validateObjectLiteral(
  obj: AgencyObject,
  scope: JsonSchemaArgScope,
): JsonSchemaArgValidationResult {
  for (const entry of obj.entries) {
    if ("key" in entry) {
      const kv = entry as AgencyObjectKV;
      const r = validateJsonSchemaArg(kv.value, scope);
      if (!r.ok) return r;
    } else {
      const splat = entry as SplatExpression;
      const r = validateJsonSchemaArg(splat.value, scope);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

function validateFunctionCall(
  call: any,
  scope: JsonSchemaArgScope,
): JsonSchemaArgValidationResult {
  // The callee must be a known top-level / imported function.
  const name: string | undefined = call.functionName;
  if (!name) {
    return {
      ok: false,
      reason: "function call inside @jsonSchema(...) must be a direct call by name",
      loc: call.loc,
    };
  }
  if (!scope.topLevelFunctionNames.has(name) && !scope.importedNames.has(name)) {
    return {
      ok: false,
      reason: `${name} is not a top-level def or imported function; cannot be used inside @jsonSchema(...)`,
      loc: call.loc,
    };
  }
  // Validate each argument as a restricted expression.
  for (const arg of (call.arguments as Expression[]) ?? []) {
    const r = validateJsonSchemaArg(arg, scope);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function validateIdentifier(
  id: any,
  scope: JsonSchemaArgScope,
): JsonSchemaArgValidationResult {
  const name: string = id.value;
  if (scope.topLevelConstNames.has(name) || scope.importedNames.has(name)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `${name} is not a static const global; only top-level const bindings or imports may be used inside @jsonSchema(...)`,
    loc: id.loc,
  };
}

/**
 * Build the scope view needed for validation from a CompilationUnit
 * and the original AgencyProgram (we need the program to walk top-level
 * `const` assignments — CompilationUnit doesn't retain them directly).
 */
export function buildJsonSchemaArgScope(
  program: AgencyProgram,
  unit: CompilationUnit,
): JsonSchemaArgScope {
  const topLevelConstNames = new Set<string>();
  const topLevelFunctionNames = new Set<string>();
  for (const node of program.nodes) {
    if (node.type === "assignment") {
      const n: any = node;
      if (n.declKind === "const" || n.static === true) {
        const name = n.variableName ?? n.name;
        if (typeof name === "string") topLevelConstNames.add(name);
      }
    }
    if (node.type === "function") {
      const name: string | undefined = (node as any).functionName;
      if (name) topLevelFunctionNames.add(name);
    }
  }
  const importedNames = new Set<string>(Object.keys(unit.importedFunctions));
  for (const stmt of unit.importStatements) {
    collectImportedNames(stmt, importedNames);
  }
  return { topLevelConstNames, importedNames, topLevelFunctionNames };
}

function collectImportedNames(stmt: unknown, out: Set<string>): void {
  const items: unknown = (stmt as any)?.importedNames;
  if (!Array.isArray(items)) return;
  for (const n of items) {
    if (typeof n === "string") {
      out.add(n);
    } else if (n && typeof n === "object") {
      addNamedImportEntry(n as Record<string, unknown>, out);
    }
  }
}

function addNamedImportEntry(
  entry: Record<string, unknown>,
  out: Set<string>,
): void {
  const arr: unknown = entry.importedNames;
  const aliases = entry.aliases as Record<string, string> | undefined;
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      if (typeof raw === "string") {
        out.add((aliases && aliases[raw]) ?? raw);
      }
    }
    return;
  }
  if (typeof arr === "string") {
    out.add((aliases && aliases[arr]) ?? arr);
    return;
  }
  const local =
    (entry.local as string | undefined) ??
    (entry.name as string | undefined) ??
    (entry.originalName as string | undefined) ??
    (entry.alias as string | undefined);
  if (typeof local === "string") out.add(local);
}
