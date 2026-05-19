import type { Tag, VariableType, TypeAliasEntry } from "../../types.js";
import { mapTypeToValidationSchema } from "./typeToZodSchema.js";
import { tagArgToTs } from "./tagArgToTs.js";
import { mergeTagSets } from "@/typeChecker/mergeTags.js";

/**
 * Render a TS source expression that evaluates to a runtime
 * `TypeValidationDescriptor`. Mirrors `mapTypeToValidationSchema`'s
 * structural recursion but threads validator lists collected from
 * `@validate(...)` tags at each level.
 *
 * Use this only when the type carries at least one `@validate` tag
 * somewhere — callers should check via `hasAnyValidateTag` first.
 *
 * `typeAliasesFull` (when provided) lets the walker pick up alias-level
 * validators for `typeAliasVariable` references that `resolveTypeDeep`
 * intentionally leaves intact (so codegen can keep `.meta(...)` on the
 * one top-level alias schema). Without it, alias-level `@validate`
 * tags reachable only through a non-generic alias reference would be
 * silently dropped.
 */
export function buildValidationDescriptorTs(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): string {
  return descriptor(variableType, typeAliases, typeAliasesFull ?? {});
}

/**
 * Walks a resolved type tree to determine whether any `@validate(...)`
 * tag is present at any depth. Builders use this to gate the
 * descriptor-based emit path; types without any `@validate` continue
 * to use the existing zero-cost `__validateType(...)` codegen.
 *
 * `aliasesFull` (optional) lets us see through non-generic
 * `typeAliasVariable` references — `deepResolveNode` leaves those
 * intact for codegen-by-name purposes, so we have to look them up
 * here to decide if the alias body carries `@validate`.
 */
export function hasAnyValidateTag(
  t: VariableType,
  aliasesFull?: Record<string, TypeAliasEntry>,
  seen: Set<string> = new Set(),
): boolean {
  if (tagsHaveValidate(t.tags)) return true;
  switch (t.type) {
    case "arrayType":
      return hasAnyValidateTag(t.elementType, aliasesFull, seen);
    case "objectType":
      return t.properties.some(
        (p) =>
          tagsHaveValidate(p.tags) ||
          hasAnyValidateTag(p.value, aliasesFull, seen),
      );
    case "unionType":
      return t.types.some((m) => hasAnyValidateTag(m, aliasesFull, seen));
    case "resultType":
      return hasAnyValidateTag(t.successType, aliasesFull, seen);
    case "genericType":
      return (t.typeArgs ?? []).some((a) =>
        hasAnyValidateTag(a, aliasesFull, seen),
      );
    case "typeAliasVariable": {
      if (!aliasesFull) return false;
      const entry = aliasesFull[t.aliasName];
      if (!entry) return false;
      if (tagsHaveValidate(entry.tags)) return true;
      // Guard against recursive alias self-reference.
      if (seen.has(t.aliasName)) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(t.aliasName);
      return hasAnyValidateTag(entry.body, aliasesFull, nextSeen);
    }
    default:
      return false;
  }
}

function tagsHaveValidate(tags: Tag[] | undefined): boolean {
  return !!tags && tags.some((t) => t.name === "validate");
}

/**
 * True when `entry`'s tags or its body carry any `@validate(...)` tag.
 * Used to decide whether a `typeAliasVariable` reference should emit a
 * `(Alias as any).__agency_descriptor` reference vs. a flat leaf schema.
 */
function hasAliasValidate(
  entry: TypeAliasEntry,
  typeAliasesFull: Record<string, TypeAliasEntry>,
): boolean {
  if (tagsHaveValidate(entry.tags)) return true;
  return hasAnyValidateTag(entry.body, typeAliasesFull);
}

function collectValidators(tags: Tag[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (t.name !== "validate") continue;
    for (const arg of t.arguments) {
      out.push(tagArgToTs(arg));
    }
  }
  return out;
}

function isNullableType(t: VariableType): boolean {
  if (t.type !== "unionType") return false;
  return t.types.some(
    (m) =>
      m.type === "primitiveType" &&
      (m.value === "null" || m.value === "undefined"),
  );
}

function descriptor(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  typeAliasesFull: Record<string, TypeAliasEntry>,
  seen: Set<string> = new Set(),
): string {
  // For an alias reference whose alias body has any `@validate(...)` tag,
  // reference the alias's runtime descriptor (attached as
  // `(Alias as any).__agency_descriptor` by `processTypeAlias`) rather than
  // inlining the alias body. Inlining would leak identifiers (validators,
  // schema-helper consts) that live in the alias-defining module's scope but
  // not the consumer's. Use-site validators are concatenated on top of the
  // alias's via a runtime helper.
  if (variableType.type === "typeAliasVariable") {
    const entry = typeAliasesFull[variableType.aliasName];
    const useSiteValidators = collectValidators(variableType.tags);
    if (entry && hasAliasValidate(entry, typeAliasesFull)) {
      const ref = `(${variableType.aliasName} as any).__agency_descriptor`;
      if (useSiteValidators.length === 0) return ref;
      // Append use-site validators to the alias's chain.
      return `{ ...${ref}, validators: [...(${ref}?.validators ?? []), ${useSiteValidators.join(", ")}] }`;
    }
    // No alias-level validators — emit a leaf using only the alias schema and
    // any use-site validators.
    const schema = mapTypeToValidationSchema(variableType, typeAliases);
    return `{ kind: "leaf", schema: ${schema}, validators: [${useSiteValidators.join(
      ", ",
    )}] }`;
  }

  const schema = mapTypeToValidationSchema(variableType, typeAliases);
  const validators = collectValidators(variableType.tags);
  const validatorsLit = `[${validators.join(", ")}]`;

  if (variableType.type === "arrayType") {
    const el = descriptor(
      variableType.elementType,
      typeAliases,
      typeAliasesFull,
      seen,
    );
    return `{ kind: "array", schema: ${schema}, validators: ${validatorsLit}, element: ${el} }`;
  }

  if (variableType.type === "objectType") {
    const propEntries = variableType.properties.map((p) => {
      const merged = mergeTagSets(p.value.tags, p.tags);
      const childType: VariableType = { ...p.value, tags: merged };
      const childDesc = descriptor(childType, typeAliases, typeAliasesFull, seen);
      return `${JSON.stringify(p.key)}: ${childDesc}`;
    });
    return `{ kind: "object", schema: ${schema}, validators: ${validatorsLit}, properties: { ${propEntries.join(", ")} } }`;
  }

  if (isNullableType(variableType)) {
    // treat as nullable wrapper around the first non-null/undefined branch
    const u = variableType as Extract<VariableType, { type: "unionType" }>;
    const innerMembers = u.types.filter(
      (m) =>
        !(
          m.type === "primitiveType" &&
          (m.value === "null" || m.value === "undefined")
        ),
    );
    if (innerMembers.length === 1) {
      const inner = descriptor(
        innerMembers[0],
        typeAliases,
        typeAliasesFull,
        seen,
      );
      return `{ kind: "nullable", schema: ${schema}, validators: ${validatorsLit}, inner: ${inner} }`;
    }
    // multi-member nullable union: fall through to general union handling
  }

  if (variableType.type === "unionType") {
    const branches = variableType.types.map((m) => {
      const branchSchema = mapTypeToValidationSchema(m, typeAliases);
      const branchDesc = descriptor(m, typeAliases, typeAliasesFull, seen);
      const test = `(v) => (${branchSchema}).safeParse(v).success`;
      return `{ test: ${test}, descriptor: ${branchDesc} }`;
    });
    return `{ kind: "union", schema: ${schema}, validators: ${validatorsLit}, branches: [${branches.join(", ")}] }`;
  }

  if (variableType.type === "resultType") {
    // Recurse into the success type; the Result wrapper is checked by Zod.
    const inner = descriptor(
      variableType.successType,
      typeAliases,
      typeAliasesFull,
      seen,
    );
    return `{ kind: "nullable", schema: ${schema}, validators: ${validatorsLit}, inner: ${inner} }`;
  }

  return `{ kind: "leaf", schema: ${schema}, validators: ${validatorsLit} }`;
}
