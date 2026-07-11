import { VariableType } from "@/types.js";
import { effectSetToSource } from "@/backends/typescriptGenerator/typeToString.js";

/** Maps Agency primitive type names to their TypeScript equivalents. */
export const TS_PRIMITIVE_ALIASES: Record<string, string> = {
  regex: "RegExp",
};

/**
 * Output dialect for `formatTypeHint`. Drives surface-syntax choices
 * such as the block-type arrow (`->` vs `=>`) — anything where Agency
 * and TS use different glyphs for the same semantic construct.
 */
export type FormatTarget = "agency" | "ts";

/**
 * Format a VariableType for display.
 *
 * Pass `primitiveAliases` (e.g. for codegen) to substitute Agency-only
 * primitive names with target-language equivalents. Default omits the map
 * so diagnostics, LSP hover, and CLI prompts show source-level keywords.
 *
 * `target` controls dialect-specific surface syntax independent of
 * `primitiveAliases` — pass `"ts"` for TypeScript codegen (uses `=>`),
 * default `"agency"` for everything else (uses `->`).
 */
export function formatTypeHint(
  vt: VariableType,
  primitiveAliases?: Record<string, string>,
  target: FormatTarget = "agency",
): string {
  const recurse = (v: VariableType) => formatTypeHint(v, primitiveAliases, target);
  switch (vt.type) {
    case "primitiveType":
      return primitiveAliases?.[vt.value] ?? vt.value;
    case "arrayType": {
      // Parenthesize keyof, union, and intersection elements:
      // `(keyof User)[]`, `(A | B)[]`, and `(A & B)[]` re-parse as
      // written, while the unparenthesized forms re-parse as
      // keyof (User[]), A | (B[]), and A & (B[]).
      const el = recurse(vt.elementType);
      return vt.elementType.type === "keyofType" ||
        vt.elementType.type === "unionType" ||
        vt.elementType.type === "intersectionType"
        ? `(${el})[]`
        : `${el}[]`;
    }
    case "stringLiteralType":
      return `"${vt.value}"`;
    case "numberLiteralType":
      return vt.value;
    case "booleanLiteralType":
      return vt.value;
    case "unionType":
      return vt.types.map(recurse).join(" | ");
    case "objectType":
      return `{ ${vt.properties.map((p) => `${p.key}: ${recurse(p.value)}`).join(", ")} }`;
    case "typeAliasVariable":
      return vt.aliasName;
    case "blockType": {
      // Dialect-keyed arrow: `->` for Agency, `=>` for TypeScript.
      // Param names are surfaced in both dialects when present; TS
      // function types accept named params (`(a: string) => string`)
      // and the call sites that hand a `blockType` here pass it as a
      // *type* (e.g. a parameter's typeHint), not as a declaration
      // list, so there's no risk of double-naming.
      const arrow = target === "ts" ? "=>" : "->";
      const params = vt.params
        .map((p) => {
          const t = recurse(p.typeAnnotation);
          return p.name ? `${p.name}: ${t}` : t;
        })
        .join(", ");
      const base = `(${params}) ${arrow} ${recurse(vt.returnType)}`;
      // Agency-only surface syntax. `formatTypeHint` has no alias map; rendering
      // a clause needs member/alias names, not resolution, so `{}` is fine.
      return target === "agency" && vt.raises
        ? `${base} raises ${effectSetToSource(vt.raises, {})}`
        : base;
    }
    case "resultType": {
      const s = recurse(vt.successType);
      const f = recurse(vt.failureType);
      if (s === "any" && f === "any") return "Result";
      return `Result<${s}, ${f}>`;
    }
    case "schemaType":
      return `Schema<${recurse(vt.inner)}>`;
    case "functionRefType": {
      const params = vt.params
        .map((p) => `${p.name}${p.typeHint ? `: ${recurse(p.typeHint)}` : ""}`)
        .join(", ");
      const ret = vt.returnType ? `: ${recurse(vt.returnType)}` : "";
      return `function ${vt.name}(${params})${ret}`;
    }
    case "genericType":
      return `${vt.name}<${vt.typeArgs.map(recurse).join(", ")}>`;
    case "intersectionType":
      // A union member needs parens (`(A | B) & C`) because & binds
      // tighter; an intersection inside a union needs none for the same
      // reason.
      return vt.types
        .map((m) => (m.type === "unionType" ? `(${recurse(m)})` : recurse(m)))
        .join(" & ");
    case "keyofType": {
      // Parenthesize union AND intersection operands: `keyof (A | B)` /
      // `keyof (A & B)` must not print bare, which would re-parse as
      // (keyof A) | B and (keyof A) & B.
      const op = recurse(vt.operand);
      return vt.operand.type === "unionType" ||
        vt.operand.type === "intersectionType"
        ? `keyof (${op})`
        : `keyof ${op}`;
    }
    case "indexedAccessType": {
      // Parenthesize keyof and union objects for the same re-parse
      // reasons as the arrayType case: `(A | B)["k"]` must not print as
      // `A | B["k"]`.
      const obj = recurse(vt.objectType);
      const wrapped =
        vt.objectType.type === "keyofType" ||
        vt.objectType.type === "unionType" ||
        vt.objectType.type === "intersectionType"
          ? `(${obj})`
          : obj;
      return `${wrapped}[${recurse(vt.index)}]`;
    }
    default:
      throw new Error(`Unknown variable type: ${(vt as any).type}`);
  }
}

/** Convenience wrapper for codegen contexts. */
export function formatTypeHintTs(vt: VariableType): string {
  return formatTypeHint(vt, TS_PRIMITIVE_ALIASES, "ts");
}
