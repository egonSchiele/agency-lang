import { color } from "@/utils/termcolors.js";
import { Tag, TypeAliasEntry, VariableType } from "../../types.js";
import { escape } from "../../utils.js";
import { tagArgToTs } from "./tagArgToTs.js";
import { mergeJsonSchemaArgs, mergeTagSets } from "@/typeChecker/mergeTags.js";
import { applyValueArgs } from "@/typeChecker/valueParamSubstitution.js";

export const DEFAULT_SCHEMA = "z.string()";

/**
 * Append a `.meta({...})` call to a Zod schema string when the type
 * carries a `@jsonSchema(...)` tag.
 *
 * `.meta()` MUST be the last call in the Zod chain (Zod's API requires
 * it for the metadata to be picked up by `toJSONSchema`). Every callsite
 * that finishes a Zod expression for a type should route through here.
 */
export function appendMeta(schemaExpr: string, tags: Tag[] | undefined): string {
  if (!tags || tags.length === 0) return schemaExpr;
  const jsonSchemas = tags.filter((t) => t.name === "jsonSchema");
  if (jsonSchemas.length === 0) return schemaExpr;
  // Multiple `@jsonSchema(...)` tags on the same target — or a single
  // tag with several object-literal arguments — flatten through the
  // same merge as alias-vs-use-site combining. `mergeJsonSchemaArgs`
  // returns a single object expression we render as the `.meta(...)`
  // argument.
  const mergedArgs = mergeJsonSchemaArgs(jsonSchemas);
  if (mergedArgs.length === 0) return schemaExpr;
  return `${schemaExpr}.meta(${tagArgToTs(mergedArgs[0])})`;
}

/**
 * Internal recursive schema mapper. The `resultHandler` parameter controls
 * how Result types are converted:
 * - For LLM structured output: returns just the success type schema
 * - For validation: returns a schema that validates the full Result shape
 *
 * `typeAliasesFull` is optional; when present it lets the object-property
 * code path look up alias-level tags for a `typeAliasVariable` reference
 * and merge them with the use-site property tags. This is what makes
 * patterns like:
 *
 *   @jsonSchema({description: "alias desc"})
 *   type Email = string
 *
 *   type User = { @jsonSchema({description: "primary"}) contact: Email }
 *
 * produce a single merged `.meta(...)` at the use site (with description
 * concatenation per `mergeTagSets`) instead of letting Zod's chained
 * `.meta()` overwrite the alias-level metadata.
 */
function mapTypeToSchema(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  resultHandler: (vt: VariableType, ta: Record<string, VariableType>) => string,
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): string {
  return appendMeta(
    mapTypeToSchemaInner(variableType, typeAliases, resultHandler, typeAliasesFull),
    variableType.tags,
  );
}

function mapTypeToSchemaInner(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  resultHandler: (vt: VariableType, ta: Record<string, VariableType>) => string,
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): string {
  const recurse = (vt: VariableType) =>
    appendMeta(
      mapTypeToSchemaInner(vt, typeAliases, resultHandler, typeAliasesFull),
      vt.tags,
    );

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
        // Merge alias-level tags (either already attached to prop.value
        // during resolveType, or — for an unresolved `typeAliasVariable`
        // reference — looked up via `typeAliasesFull`) with the
        // property-level tags. @jsonSchema keys from the property
        // override alias keys (with `description` concatenating per
        // `mergeTagSets`); @validate validators concat.
        const aliasEntryTags =
          typeAliasesFull && prop.value.type === "typeAliasVariable"
            ? typeAliasesFull[prop.value.aliasName]?.tags
            : undefined;
        const aliasSideTags = mergeTagSets(aliasEntryTags, prop.value.tags);
        const mergedTags = mergeTagSets(aliasSideTags, prop.tags);
        const inner = mapTypeToSchemaInner(
          prop.value,
          typeAliases,
          resultHandler,
          typeAliasesFull,
        );
        // .describe(...) must come BEFORE .meta(...) — Zod requires
        // .meta() to be the final call in the chain or the metadata is
        // dropped from toJSONSchema(...).
        let inner2 = inner;
        if (prop.description) {
          inner2 += `.describe("${escape(prop.description)}")`;
        }
        const str = `"${prop.key.replace(/"/g, '\\"')}": ${appendMeta(inner2, mergedTags)}`;
        return str;
      })
      .join(", ");
    return `z.object({ ${props} })`;
  } else if (variableType.type === "resultType") {
    return resultHandler(variableType, typeAliases);
  } else if (variableType.type === "typeAliasVariable") {
    // Value-parameterized alias reference (e.g. `Age(18)`): there is
    // no single top-level schema const for the alias, so we inline the
    // substituted body's Zod schema at this use-site. The substituted
    // tags drive `appendMeta`.
    if (variableType.valueArgs && typeAliasesFull) {
      const aliasEntry = typeAliasesFull[variableType.aliasName];
      if (aliasEntry?.valueParams) {
        const substituted = applyValueArgs(
          aliasEntry,
          variableType.valueArgs,
          variableType.aliasName,
        );
        const bodyWithAliasTags: VariableType = {
          ...substituted.body,
          tags: mergeTagSets(substituted.tags, substituted.body.tags),
        };
        return mapTypeToSchema(
          bodyWithAliasTags,
          typeAliases,
          resultHandler,
          typeAliasesFull,
        );
      }
    }
    return variableType.aliasName;
  } else if (variableType.type === "genericType") {
    if (variableType.name === "Record") {
      const keySchema = recurse(variableType.typeArgs[0]);
      const valueSchema = recurse(variableType.typeArgs[1]);
      return `z.record(${keySchema}, ${valueSchema})`;
    }
    // Array/Schema should have been normalized by resolveType before reaching
    // codegen; user-defined generics likewise. A leftover here is a bug.
    throw new Error(
      `Unresolved generic type at codegen: ${variableType.name}`,
    );
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
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): string {
  return mapTypeToSchema(
    variableType,
    typeAliases,
    (vt, ta) => mapTypeToZodSchema((vt as any).successType, ta, typeAliasesFull),
    typeAliasesFull,
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
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): string {
  return mapTypeToSchema(
    variableType,
    typeAliases,
    (vt, ta) => {
      const successSchema = mapTypeToValidationSchema(
        (vt as any).successType,
        ta,
        typeAliasesFull,
      );
      return `z.union([z.object({ __type: z.literal("resultType"), success: z.literal(true), value: ${successSchema} }), z.object({ __type: z.literal("resultType"), success: z.literal(false), error: z.any() })])`;
    },
    typeAliasesFull,
  );
}
