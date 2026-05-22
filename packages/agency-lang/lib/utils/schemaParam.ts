import type { VariableType } from "../types/typeHints.js";
import type { FunctionParameter } from "../types/function.js";

/**
 * A parameter is a "Schema-injectable" parameter when its declared type
 * is `Schema<...>`. Two parser/checker representations show up in the wild:
 *
 *  - `genericType { name: "Schema", typeArgs: [...] }` — the surface form
 *    a user writes (e.g. `s: Schema<any>`). `resolveType` later lowers
 *    this to the `schemaType` shape, but in the preprocessor we still see
 *    the genericType form because resolution happens during type-checking.
 *  - `schemaType { inner: T }` — the post-resolution form. Listed here as
 *    defense in depth so the helper works in both contexts.
 *
 * Schema-injectable parameters can be omitted at the call site when the
 * compiler can synthesize a Zod schema from a known expected type (the
 * LHS annotation of a `const`/`let`, the enclosing function's declared
 * return type, etc.). The `typescriptPreprocessor`'s `injectSchemaArgs`
 * pass inserts a synthetic `schema(T)` expression in those cases.
 */
export function isSchemaTypeHint(t: VariableType | undefined): boolean {
  if (!t) return false;
  if (t.type === "schemaType") return true;
  if (t.type === "genericType" && t.name === "Schema") return true;
  return false;
}

/**
 * Find the unique Schema-typed parameter in a function's parameter list,
 * if any. Throws when more than one Schema parameter is declared — the
 * compiler currently restricts functions to at most one Schema parameter
 * because there is only one expected-type slot at any call site.
 *
 * Returns:
 *   - { param, index } when exactly one Schema param exists
 *   - undefined when none exist
 */
export function findSchemaParam(
  params: FunctionParameter[],
  functionName: string,
): { param: FunctionParameter; index: number } | undefined {
  let found: { param: FunctionParameter; index: number } | undefined;
  for (let i = 0; i < params.length; i++) {
    if (!isSchemaTypeHint(params[i].typeHint)) continue;
    if (found) {
      throw new Error(
        `Function '${functionName}' declares more than one Schema parameter ('${found.param.name}' and '${params[i].name}'). At most one Schema parameter is allowed.`,
      );
    }
    found = { param: params[i], index: i };
  }
  return found;
}
