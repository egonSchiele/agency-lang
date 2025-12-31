import { VariableType } from "@/types";

/**
 * Maps ADL types to Zod schema strings
 */
export function mapTypeToZodSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>
): string {
  if (variableType.type === "primitiveType") {
    switch (variableType.value.toLowerCase()) {
      case "number":
        return "z.number()";
      case "string":
        return "z.string()";
      case "boolean":
        return "z.boolean()";
      default:
        // Default to string for unknown types
        return "z.string()";
    }
  } else if (variableType.type === "arrayType") {
    // Recursively handle array element type
    const elementSchema = mapTypeToZodSchema(
      variableType.elementType,
      typeAliases
    );
    return `z.array(${elementSchema})`;
  } else if (variableType.type === "stringLiteralType") {
    return `z.literal("${variableType.value}")`;
  } else if (variableType.type === "numberLiteralType") {
    return `z.literal(${variableType.value})`;
  } else if (variableType.type === "booleanLiteralType") {
    return `z.literal(${variableType.value})`;
  } else if (variableType.type === "unionType") {
    const unionSchemas = variableType.types.map((t) =>
      mapTypeToZodSchema(t, typeAliases)
    );
    return `z.union([${unionSchemas.join(", ")}])`;
  } else if (variableType.type === "objectType") {
    const props = variableType.properties
      .map(
        (prop) =>
          `"${prop.key}": ${mapTypeToZodSchema(prop.value, typeAliases)}`
      )
      .join(", ");
    return `z.object({ ${props} })`;
  } else if (variableType.type === "typeAliasVariable") {
    return mapTypeToZodSchema(typeAliases[variableType.aliasName], typeAliases);
  }

  // Fallback (should never reach here)
  return "z.string()";
}
