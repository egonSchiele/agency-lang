import type { FunctionDefinition, GraphNodeDefinition } from "../types.js";
import type { ImportedFunctionSignature } from "../compilationUnit.js";
import { BUILTIN_FUNCTION_TYPES } from "./builtins.js";
import { JS_GLOBALS } from "./resolveCall.js";

/**
 * Inputs for variable name resolution. Mirrors `ResolveCallInput` in
 * `resolveCall.ts` but adds class names and uses `scopeHas` to cover
 * let/const/params/for-vars/lambda-params/handler-params.
 *
 * `classNames` only holds presence info — value type is `true`. We don't
 * import the full `ClassDefinition` here because the resolver doesn't
 * need anything beyond name existence.
 */
type ResolveVariableInput = {
  functionDefs: Record<string, FunctionDefinition>;
  nodeDefs: Record<string, GraphNodeDefinition>;
  importedFunctions: Record<string, ImportedFunctionSignature>;
  importedNodeNames: readonly string[];
  /** Names imported via `import { foo } from "./helpers.js"` (non-Agency). */
  jsImportedNames?: Record<string, true>;
  classNames: Record<string, true>;
  scopeHas: (name: string) => boolean;
};

/**
 * Tagged union describing where a variable name resolved to. The
 * diagnostic only cares whether `kind === "unresolved"`; the other kinds
 * are informational.
 *
 *   scopeBinding  — bound in the local scope (let/const, parameter,
 *                   for-loop variable, lambda/block parameter, handler
 *                   param, etc.).
 *   def           — references a locally-defined `def`/`node` as a
 *                   first-class function reference (e.g. `map(xs, foo)`).
 *   imported      — references an imported function or node.
 *   class         — references a class defined in this file.
 *   builtin       — references a builtin (success, failure, llm, …) as
 *                   a function reference.
 *   jsGlobal      — references a JS global (parseInt, JSON, Math, …)
 *                   either as a flat callable or a namespace base.
 *   unresolved    — none of the above. The diagnostic emits.
 *
 * The names in `RESERVED_FUNCTION_NAMES` that aren't also in
 * `BUILTIN_FUNCTION_TYPES` (`schema`, `interrupt`, `debugger`) are parsed
 * into their own AST node types and never appear as `variableName`, so
 * there's no `kind: "reserved"` here.
 */
export type VariableResolution =
  | { kind: "scopeBinding" }
  | { kind: "def" }
  | { kind: "imported" }
  | { kind: "jsImported" }
  | { kind: "class" }
  | { kind: "builtin" }
  | { kind: "jsGlobal" }
  | { kind: "unresolved" };

const has = (obj: object, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, name);

/**
 * Resolution order for variable references — mirrors `resolveCall` but
 * starts from local scope, since variable references are usually local.
 *
 *   1. Local scope binding              — let/const, params, for-vars, …
 *   2. Local `def`/`node`               — function reference.
 *   3. Imported function/node           — cross-file function reference.
 *   4. Class definition                 — `new MyClass()` and `MyClass`
 *                                         as a value (instanceof, etc.).
 *   5. `BUILTIN_FUNCTION_TYPES`         — Agency primitive as function ref.
 *   6. JS global (callable or namespace) — covers both bare `parseInt` and
 *                                          namespace bases like `JSON`.
 *   7. Otherwise: unresolved.
 */
export function resolveVariable(
  name: string,
  input: ResolveVariableInput,
): VariableResolution {
  if (input.scopeHas(name)) return { kind: "scopeBinding" };
  if (has(input.functionDefs, name) || has(input.nodeDefs, name)) {
    return { kind: "def" };
  }
  if (has(input.importedFunctions, name)) return { kind: "imported" };
  if (input.importedNodeNames.includes(name)) return { kind: "imported" };
  if (input.jsImportedNames && has(input.jsImportedNames, name))
    return { kind: "jsImported" };
  if (has(input.classNames, name)) return { kind: "class" };
  if (has(BUILTIN_FUNCTION_TYPES, name)) return { kind: "builtin" };
  if (has(JS_GLOBALS, name)) return { kind: "jsGlobal" };
  return { kind: "unresolved" };
}
