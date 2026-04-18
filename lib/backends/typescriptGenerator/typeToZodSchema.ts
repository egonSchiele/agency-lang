import { color } from "termcolors";
import { VariableType } from "../../types.js";
import { escape } from "../../utils.js";

export const DEFAULT_SCHEMA = "z.string()";

/**
 * Maps Agency types to Zod schema strings
 */
export function mapTypeToZodSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
): string {
  /* console.log(
    color.yellow(
      `Variable type is`,
      JSON.stringify(variableType),
    ),
  );
 */
  if (!variableType) {
    throw new Error(
      `Received undefined variableType. typeAliases: ${JSON.stringify(typeAliases)}`,
    );
  }
  if (variableType.type === "primitiveType") {
    switch (variableType.value.toLowerCase()) {
      case "number":
        return "z.number()";
      case "string":
        return DEFAULT_SCHEMA;
      case "boolean":
        return "z.boolean()";
      case "null":
        return "z.null()";
      case "undefined":
        // Undefined cannot be represented in JSON Schema
        return "z.null()";
      case "any":
        return "z.any()";
      case "unknown":
        return "z.unknown()";
      case "object":
        return "z.record(z.string(), z.any())";
      default:
        // Default to string for unknown types
        return DEFAULT_SCHEMA;
    }
  } else if (variableType.type === "arrayType") {
    // Recursively handle array element type
    const elementSchema = mapTypeToZodSchema(
      variableType.elementType,
      typeAliases,
    );
    return `z.array(${elementSchema})`;
  } else if (variableType.type === "stringLiteralType") {
    return `z.literal("${variableType.value.replace(/"/g, '\\"')}")`;
  } else if (variableType.type === "numberLiteralType") {
    return `z.literal(${variableType.value})`;
  } else if (variableType.type === "booleanLiteralType") {
    return `z.literal(${variableType.value})`;
  } else if (variableType.type === "unionType") {
    const unionSchemas = variableType.types.map((t) =>
      mapTypeToZodSchema(t, typeAliases),
    );
    return `z.union([${unionSchemas.join(", ")}])`;
  } else if (variableType.type === "objectType") {
    const props = variableType.properties
      .map((prop) => {
        let str = `"${prop.key.replace(/"/g, '\\"')}": ${mapTypeToZodSchema(
          prop.value,
          typeAliases,
        )}`;
        if (prop.description) {
          str += `.describe("${escape(prop.description)}")`;
        }
        return str;
      })
      .join(", ");
    return `z.object({ ${props} })`;
  } else if (variableType.type === "resultType") {
    return mapTypeToZodSchema(variableType.successType, typeAliases);
  } else if (variableType.type === "typeAliasVariable") {
    if (!typeAliases || !typeAliases[variableType.aliasName]) {
      throw new Error(
        `Type alias '${variableType.aliasName}' not found in provided type aliases: ${JSON.stringify(typeAliases)}`,
      );
    }
    return mapTypeToZodSchema(typeAliases[variableType.aliasName], typeAliases);
  }

  // Fallback (should never reach here)
  return "z.string()";
}

/**
 * Maps Agency types to Zod schema strings for validation contexts.
 * Unlike mapTypeToZodSchema (used for LLM structured output), this generates
 * schemas that validate the full Result structure rather than just the success type.
 */
export function mapTypeToValidationSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
): string {
  if (variableType.type === "resultType") {
    const successSchema = mapTypeToValidationSchema(variableType.successType, typeAliases);
    return `z.union([z.object({ success: z.literal(true), value: ${successSchema} }), z.object({ success: z.literal(false), error: z.any() })])`;
  }
  if (variableType.type === "typeAliasVariable") {
    if (!typeAliases || !typeAliases[variableType.aliasName]) {
      throw new Error(
        `Type alias '${variableType.aliasName}' not found in provided type aliases: ${JSON.stringify(typeAliases)}`,
      );
    }
    return mapTypeToValidationSchema(typeAliases[variableType.aliasName], typeAliases);
  }
  return mapTypeToZodSchema(variableType, typeAliases);
}
