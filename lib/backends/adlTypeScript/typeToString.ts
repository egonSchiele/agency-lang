import { VariableType } from "@/types";

/**
 * Converts a VariableType to a string representation for naming/logging
 */
export function variableTypeToString(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>
): string {
  if (variableType.type === "primitiveType") {
    return variableType.value;
  } else if (variableType.type === "arrayType") {
    // Recursively build array type string
    return `${variableTypeToString(variableType.elementType, typeAliases)}[]`;
  } else if (variableType.type === "stringLiteralType") {
    return `"${variableType.value}"`;
  } else if (variableType.type === "numberLiteralType") {
    return `${variableType.value}`;
  } else if (variableType.type === "booleanLiteralType") {
    return `${variableType.value}`;
  } else if (variableType.type === "unionType") {
    return variableType.types
      .map((t) => variableTypeToString(t, typeAliases))
      .join(" | ");
  } else if (variableType.type === "objectType") {
    const props = variableType.properties
      .map(
        (prop) =>
          `${prop.key}: ${variableTypeToString(prop.value, typeAliases)}`
      )
      .join("; ");
    return `{ ${props} }`;
  } else if (variableType.type === "typeAliasVariable") {
    return variableType.aliasName;
  }
  return "unknown";
}
