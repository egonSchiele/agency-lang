import { color } from "@/utils/termcolors.js";
import { VariableType } from "../../types.js";
import { escape } from "../../utils.js";

export const DEFAULT_SCHEMA = "z.string()";

/**
 * Internal recursive schema mapper. The `resultHandler` parameter controls
 * how Result types are converted:
 * - For LLM structured output: returns just the success type schema
 * - For validation: returns a schema that validates the full Result shape
 */
function mapTypeToSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  resultHandler: (vt: VariableType, ta: Record<string, VariableType>) => string,
): string {
  const recurse = (vt: VariableType) => mapTypeToSchema(vt, typeAliases, resultHandler);

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
        return "z.null()";
      case "any":
        return "z.any()";
      case "unknown":
        return "z.unknown()";
      case "object":
        return "z.record(z.string(), z.any())";
      case "regex":
        return "z.instanceof(RegExp)";
      default:
        return DEFAULT_SCHEMA;
    }
  } else if (variableType.type === "arrayType") {
    return `z.array(${recurse(variableType.elementType)})`;
  } else if (variableType.type === "stringLiteralType") {
    return `z.literal("${variableType.value.replace(/"/g, '\\"')}")`;
  } else if (variableType.type === "numberLiteralType") {
    return `z.literal(${variableType.value})`;
  } else if (variableType.type === "booleanLiteralType") {
    return `z.literal(${variableType.value})`;
  } else if (variableType.type === "unionType") {
    const schemas = variableType.types.map(recurse);
    return `z.union([${schemas.join(", ")}])`;
  } else if (variableType.type === "objectType") {
    const props = variableType.properties
      .map((prop) => {
        let str = `"${prop.key.replace(/"/g, '\\"')}": ${recurse(prop.value)}`;
        if (prop.description) {
          str += `.describe("${escape(prop.description)}")`;
        }
        return str;
      })
      .join(", ");
    return `z.object({ ${props} })`;
  } else if (variableType.type === "resultType") {
    return resultHandler(variableType, typeAliases);
  } else if (variableType.type === "typeAliasVariable") {
    return variableType.aliasName;
  }

  return "z.string()";
}

/**
 * Maps Agency types to Zod schema strings for LLM structured output.
 * For Result types, returns only the success type schema (the LLM
 * doesn't return Result objects).
 */
export function mapTypeToZodSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
): string {
  return mapTypeToSchema(variableType, typeAliases, (vt, ta) =>
    mapTypeToZodSchema((vt as any).successType, ta),
  );
}

/**
 * Maps Agency types to Zod schema strings for validation contexts.
 * For Result types, generates a schema that validates the full Result
 * structure ({__type: "resultType", success: true, value: T} | {__type: "resultType", success: false, error: any}).
 */
export function mapTypeToValidationSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
): string {
  return mapTypeToSchema(variableType, typeAliases, (vt, ta) => {
    const successSchema = mapTypeToValidationSchema((vt as any).successType, ta);
    return `z.union([z.object({ __type: z.literal("resultType"), success: z.literal(true), value: ${successSchema} }), z.object({ __type: z.literal("resultType"), success: z.literal(false), error: z.any() })])`;
  });
}
