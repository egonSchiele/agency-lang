import type {
  ResultType,
  UnionType,
  VariableType,
  TypeAliasEntry,
} from "../types/typeHints.js";
import { ANY_T, BOOLEAN_T, STRING_T, NULL_T } from "./primitives.js";

const bool = (v: "true" | "false"): VariableType => ({
  type: "booleanLiteralType",
  value: v,
});

/**
 * The canonical discriminated-union view of a Result, keyed on `success`.
 * Single source of truth for "what fields a Result has" — mirrors the runtime
 * shape in lib/runtime/result.ts. The type checker consumes Result through this
 * (narrowing + field access) rather than special-casing `resultType`.
 */
export function resultToObjectUnion(
  rt: ResultType,
  _aliases: Record<string, TypeAliasEntry>,
): UnionType {
  return {
    type: "unionType",
    types: [
      {
        type: "objectType",
        properties: [
          { key: "success", value: bool("true") },
          { key: "value", value: rt.successType },
        ],
      },
      {
        type: "objectType",
        properties: [
          { key: "success", value: bool("false") },
          { key: "error", value: rt.failureType },
          { key: "checkpoint", value: ANY_T },
          { key: "retryable", value: BOOLEAN_T },
          // Tool-failure classification (lib/runtime/result.ts).
          { key: "neverStarted", value: BOOLEAN_T },
          { key: "destructiveRan", value: BOOLEAN_T },
          // runtime is `string | null` (result.ts); under nullish unification
          // the one nothing-value is `null`, so the surface type is `string | null`.
          {
            key: "functionName",
            value: { type: "unionType", types: [STRING_T, NULL_T] },
          },
          // runtime is `Record<string, any> | null` (a record, not an array);
          // typed `any` here — tighten to a Record type later if useful.
          { key: "args", value: ANY_T },
          // Propagation trail appended by the failure-propagation runtime
          // check (lib/runtime/failurePropagation.ts). Mirrors
          // SkippedFunction in lib/runtime/result.ts.
          {
            key: "skippedFunctions",
            value: {
              type: "arrayType",
              elementType: {
                type: "objectType",
                properties: [
                  { key: "name", value: STRING_T },
                  { key: "param", value: STRING_T },
                ],
              },
            },
          },
        ],
      },
    ],
  };
}
