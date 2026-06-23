import type { Tag, VariableType, TypeAliasEntry } from "../../types.js";
import type { TsNode, TsObjectEntry } from "@/ir/tsIR.js";
import { ts } from "@/ir/builders.js";
import { mapTypeToValidationSchema } from "./typeToZodSchema.js";
import { tagArgToTs } from "./tagArgToTs.js";
import { mergeTagSets } from "@/typeChecker/mergeTags.js";
import {
  applyValueArgs,
  isValueParamInstantiation,
} from "@/typeChecker/valueParamSubstitution.js";

/**
 * Build a TS IR node that evaluates to a runtime `TypeValidationDescriptor`.
 *
 * Mirrors `mapTypeToValidationSchema`'s structural recursion but threads
 * validator lists collected from `@validate(...)` tags at each level.
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
export function buildValidationDescriptor(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): TsNode {
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
      // The PRESENCE of a `@validate(...)` tag is substitution-invariant:
      // value-arg substitution only rewrites a tag's argument expressions,
      // never adds or removes the tag itself. So we check the raw entry
      // directly rather than calling `applyValueArgs`. This also matters
      // for forwarding aliases (`type AdultAge(high) = NumberInRange(18,
      // high)`): substituting here would pass the still-symbolic `high`
      // into the inner alias and trip `applyValueArgs`'s
      // unsubstituted-value-param guard when the forwarded name collides
      // with the inner param name.
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
export function hasAliasValidate(
  entry: TypeAliasEntry,
  typeAliasesFull: Record<string, TypeAliasEntry>,
): boolean {
  if (tagsHaveValidate(entry.tags)) return true;
  return hasAnyValidateTag(entry.body, typeAliasesFull);
}

/**
 * Each validator referenced inside `@validate(...)` is itself an Agency
 * expression. We don't have a TS IR builder for arbitrary Agency
 * expressions, so we delegate to `tagArgToTs` (which returns a TS
 * source string) and wrap with `ts.raw(...)`.
 *
 * Tag arguments may be bare identifiers (`@validate(isEmail)`) or PFA
 * expressions (`@validate(min.partial(n: 0))`). PFA results are
 * `AgencyFunction` instances — the runtime validation chain handles
 * both that case and plain JS callable validators (see
 * `callValidator` in `validateChain.ts`).
 */
function validatorNodes(tags: Tag[] | undefined): TsNode[] {
  if (!tags) return [];
  const out: TsNode[] = [];
  for (const t of tags) {
    if (t.name !== "validate") continue;
    for (const arg of t.arguments) {
      out.push(ts.raw(tagArgToTs(arg)));
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

/**
 * Build the (string-built) Zod schema for `t` as a `ts.raw` node.
 * `mapTypeToValidationSchema` predates the TS IR; rather than rewriting
 * it, we keep it returning strings and wrap here.
 */
function schemaNode(
  t: VariableType,
  typeAliases: Record<string, VariableType>,
  typeAliasesFull?: Record<string, TypeAliasEntry>,
): TsNode {
  return ts.raw(mapTypeToValidationSchema(t, typeAliases, typeAliasesFull));
}

/**
 * Concatenate use-site `@validate(...)` validators on top of a base
 * descriptor expression: `{ ...base, validators: [...(base?.validators ??
 * []), ...useSite] }`. Returns `base` unchanged when there are none.
 * Shared by the `__agency_descriptor` and value-param factory-call paths.
 */
function withUseSiteValidators(
  base: TsNode,
  useSiteValidators: TsNode[],
): TsNode {
  if (useSiteValidators.length === 0) return base;
  const existingValidators = ts.binOp(
    ts.prop(base, "validators", { optional: true }),
    "??",
    ts.arr([]),
    { parenLeft: true },
  );
  return ts.obj([
    ts.setSpread(base),
    ts.set(
      '"validators"',
      ts.arr([ts.spread(existingValidators), ...useSiteValidators]),
    ),
  ]);
}

/**
 * Build the descriptor for a value-parameterized alias instantiation.
 * A VALIDATED value-param alias compiles to a descriptor factory in its
 * defining module (see `processTypeAlias`), so we reference it by CALL —
 * its validators resolve in that module's scope, never injected into the
 * consumer and impossible to shadow with a same-named local. A
 * NON-validated one has no validators to leak, so we inline its
 * substituted schema as before.
 */
function valueParamDescriptor(
  variableType: Extract<VariableType, { type: "typeAliasVariable" }>,
  entry: TypeAliasEntry | undefined,
  useSiteValidators: TsNode[],
  typeAliases: Record<string, VariableType>,
  typeAliasesFull: Record<string, TypeAliasEntry>,
  seen: Set<string>,
): TsNode {
  if (entry && hasAliasValidate(entry, typeAliasesFull)) {
    const argList = (variableType.valueArgs ?? [])
      .map((a) => tagArgToTs(a))
      .join(", ");
    const call = ts.raw(`${variableType.aliasName}(${argList})`);
    return withUseSiteValidators(call, useSiteValidators);
  }
  const substituted = applyValueArgs(
    entry!,
    variableType.valueArgs,
    variableType.aliasName,
  );
  const merged = mergeTagSets(substituted.tags, variableType.tags);
  const bodyWithTags: VariableType = {
    ...substituted.body,
    tags: mergeTagSets(substituted.body.tags, merged),
  };
  return descriptor(bodyWithTags, typeAliases, typeAliasesFull, seen);
}

function descriptor(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  typeAliasesFull: Record<string, TypeAliasEntry>,
  seen: Set<string> = new Set(),
): TsNode {
  // For an alias reference whose alias body has any `@validate(...)` tag,
  // reference the alias's runtime descriptor (attached as
  // `(Alias as any).__agency_descriptor` by `processTypeAlias`) rather than
  // inlining the alias body. Inlining would leak identifiers (validators,
  // schema-helper consts) that live in the alias-defining module's scope but
  // not the consumer's. Use-site validators are concatenated on top of the
  // alias's via a runtime helper.
  if (variableType.type === "typeAliasVariable") {
    const entry = typeAliasesFull[variableType.aliasName];
    const useSiteValidators = validatorNodes(variableType.tags);
    // Value-parameterized alias instantiation. See `isValueParamInstantiation`
    // — the canonical predicate, also used in `typeToZodSchema` and
    // `hasAnyValidateTag`.
    if (isValueParamInstantiation(variableType, entry)) {
      return valueParamDescriptor(
        variableType,
        entry,
        useSiteValidators,
        typeAliases,
        typeAliasesFull,
        seen,
      );
    }
    if (entry && hasAliasValidate(entry, typeAliasesFull)) {
      // `(Alias as any).__agency_descriptor`
      const aliasRef = ts.prop(
        ts.raw(`(${variableType.aliasName} as any)`),
        "__agency_descriptor",
      );
      return withUseSiteValidators(aliasRef, useSiteValidators);
    }
    // No alias-level validators — emit a leaf using only the alias schema and
    // any use-site validators.
    return objEntries([
      ["kind", ts.str("leaf")],
      ["schema", schemaNode(variableType, typeAliases, typeAliasesFull)],
      ["validators", ts.arr(useSiteValidators)],
    ]);
  }

  const schema = schemaNode(variableType, typeAliases, typeAliasesFull);
  const validatorsArr = ts.arr(validatorNodes(variableType.tags));

  if (variableType.type === "arrayType") {
    const el = descriptor(
      variableType.elementType,
      typeAliases,
      typeAliasesFull,
      seen,
    );
    return objEntries([
      ["kind", ts.str("array")],
      ["schema", schema],
      ["validators", validatorsArr],
      ["element", el],
    ]);
  }

  if (variableType.type === "objectType") {
    const propEntries: TsObjectEntry[] = variableType.properties.map((p) => {
      const merged = mergeTagSets(p.value.tags, p.tags);
      const childType: VariableType = { ...p.value, tags: merged };
      const childDesc = descriptor(
        childType,
        typeAliases,
        typeAliasesFull,
        seen,
      );
      return ts.set(JSON.stringify(p.key), childDesc);
    });
    return objEntries([
      ["kind", ts.str("object")],
      ["schema", schema],
      ["validators", validatorsArr],
      ["properties", ts.obj(propEntries)],
    ]);
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
      return objEntries([
        ["kind", ts.str("nullable")],
        ["schema", schema],
        ["validators", validatorsArr],
        ["inner", inner],
      ]);
    }
    // multi-member nullable union: fall through to general union handling
  }

  if (variableType.type === "unionType") {
    const branches = variableType.types.map((m) => {
      const branchSchema = schemaNode(m, typeAliases, typeAliasesFull);
      const branchDesc = descriptor(m, typeAliases, typeAliasesFull, seen);
      // `(v) => (<branchSchema>).safeParse(v).success`
      const test = ts.arrowFn(
        [{ name: "v" }],
        ts.prop(
          ts.methodCall(branchSchema, "safeParse", [ts.id("v")]),
          "success",
        ),
      );
      return ts.obj([
        ts.set("test", test),
        ts.set("descriptor", branchDesc),
      ]);
    });
    return objEntries([
      ["kind", ts.str("union")],
      ["schema", schema],
      ["validators", validatorsArr],
      ["branches", ts.arr(branches)],
    ]);
  }

  if (variableType.type === "resultType") {
    // Recurse into the success type; the Result wrapper is checked by Zod.
    const inner = descriptor(
      variableType.successType,
      typeAliases,
      typeAliasesFull,
      seen,
    );
    return objEntries([
      ["kind", ts.str("nullable")],
      ["schema", schema],
      ["validators", validatorsArr],
      ["inner", inner],
    ]);
  }

  return objEntries([
    ["kind", ts.str("leaf")],
    ["schema", schema],
    ["validators", validatorsArr],
  ]);
}

/**
 * Tiny helper: `objEntries([["a", x], ["b", y]])` builds `{ "a": x, "b": y }`.
 * We always quote the keys so the printer renders predictable output for
 * snapshots and matches the previous string-built form.
 */
function objEntries(entries: Array<[string, TsNode]>): TsNode {
  return ts.obj(entries.map(([k, v]) => ts.set(JSON.stringify(k), v)));
}
