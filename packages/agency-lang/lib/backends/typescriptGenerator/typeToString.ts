import { VariableType } from "../../types.js";

const MAX_LENGTH = 50;

/**
 * Converts a VariableType to a string representation for naming/logging
 */
export function variableTypeToString(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  forFormatting: boolean = false,
): string {
  if (variableType.type === "primitiveType") {
    if (variableType.value === "object") {
      if (forFormatting) {
        return "object";
      }
      return "Record<string, any>";
    }
    return variableType.value;
  } else if (variableType.type === "arrayType") {
    // Recursively build array type string
    return `${variableTypeToString(variableType.elementType, typeAliases, forFormatting)}[]`;
  } else if (variableType.type === "stringLiteralType") {
    return `"${variableType.value}"`;
  } else if (variableType.type === "numberLiteralType") {
    return `${variableType.value}`;
  } else if (variableType.type === "booleanLiteralType") {
    return `${variableType.value}`;
  } else if (variableType.type === "unionType") {
    const str = variableType.types
      .map((t) => variableTypeToString(t, typeAliases, forFormatting))
      .join(" | ");
    if (str.length > MAX_LENGTH) {
      const arr = str.split(" | ");
      return "\n  | " + arr.join("\n  | ");
    }
    return str;
  } else if (variableType.type === "objectType") {
    const props = variableType.properties
      .map(
        (prop) =>
          `${prop.key}: ${variableTypeToString(prop.value, typeAliases, forFormatting)}`,
      )
      .join("; ");
    return `{ ${props} }`;
  } else if (variableType.type === "typeAliasVariable") {
    return variableType.aliasName;
  } else if (variableType.type === "blockType") {
    const params = variableType.params
      .map((p) => variableTypeToString(p.typeAnnotation, typeAliases, forFormatting))
      .join(", ");
    const ret = variableTypeToString(variableType.returnType, typeAliases, forFormatting);
    return `(${params}) => ${ret}`;
  } else if (variableType.type === "resultType") {
    const s = variableTypeToString(variableType.successType, typeAliases, forFormatting);
    const f = variableTypeToString(variableType.failureType, typeAliases, forFormatting);
    if (s === "any" && f === "any") return "Result";
    if (f === "string") return `Result<${s}>`;
    return `Result<${s}, ${f}>`;
  }
  return "unknown";
}
