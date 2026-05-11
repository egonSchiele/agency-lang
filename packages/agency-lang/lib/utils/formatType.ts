import { VariableType } from "@/types.js";

/** Maps Agency primitive type names to their TypeScript equivalents. */
export const TS_PRIMITIVE_ALIASES: Record<string, string> = {
  regex: "RegExp",
};

/**
 * Format a VariableType for display.
 *
 * Pass `primitiveAliases` (e.g. for codegen) to substitute Agency-only
 * primitive names with target-language equivalents. Default omits the map
 * so diagnostics, LSP hover, and CLI prompts show source-level keywords.
 */
export function formatTypeHint(
  vt: VariableType,
  primitiveAliases?: Record<string, string>,
): string {
  const recurse = (v: VariableType) => formatTypeHint(v, primitiveAliases);
  switch (vt.type) {
    case "primitiveType":
      return primitiveAliases?.[vt.value] ?? vt.value;
    case "arrayType":
      return `${recurse(vt.elementType)}[]`;
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
      const params = vt.params.map((p) => recurse(p.typeAnnotation)).join(", ");
      return `(${params}) => ${recurse(vt.returnType)}`;
    }
    case "resultType": {
      const s = recurse(vt.successType);
      const f = recurse(vt.failureType);
      if (s === "any" && f === "any") return "Result";
      return `Result<${s}, ${f}>`;
    }
    case "functionRefType": {
      const params = vt.params
        .map((p) => `${p.name}${p.typeHint ? `: ${recurse(p.typeHint)}` : ""}`)
        .join(", ");
      const ret = vt.returnType ? `: ${recurse(vt.returnType)}` : "";
      return `function ${vt.name}(${params})${ret}`;
    }
    default:
      throw new Error(`Unknown variable type: ${(vt as any).type}`);
  }
}

/** Convenience wrapper for codegen contexts. */
export function formatTypeHintTs(vt: VariableType): string {
  return formatTypeHint(vt, TS_PRIMITIVE_ALIASES);
}
