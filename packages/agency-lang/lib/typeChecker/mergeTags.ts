import type { Tag, Expression, AgencyObject, AgencyObjectKV, SplatExpression } from "../types.js";

/**
 * Merge two tag lists per the spec rules in
 * docs/superpowers/specs/2026-05-19-type-validation-and-json-schema-annotations-design.md.
 *
 * - `@validate(...)`: concatenated across both inputs (alias's validators
 *   first, then use-site's), producing a single combined `@validate` tag.
 * - `@jsonSchema(...)`: object-literal arguments merged left-to-right with
 *   use-site keys overriding alias keys, producing a single combined
 *   `@jsonSchema` tag. Spreads are preserved verbatim (their evaluation
 *   happens at module load time).
 *
 * Tag names other than `validate` / `jsonSchema` are deliberately not
 * merged here — they have no alias-vs-use-site semantics defined and may
 * belong to a different feature entirely (e.g. `@goal` / `@optimize`).
 * They flow through `resolveType` untouched on whichever side they
 * appeared, but never combined across the two sides.
 *
 * `aliasTags` come first in the chain, `useSiteTags` apply on top.
 */
export function mergeTagSets(
  aliasTags: Tag[] | undefined,
  useSiteTags: Tag[] | undefined,
): Tag[] | undefined {
  const alias = aliasTags ?? [];
  const useSite = useSiteTags ?? [];
  if (alias.length === 0 && useSite.length === 0) return undefined;

  const combined: Tag[] = [];

  const aliasValidate = alias.filter((t) => t.name === "validate");
  const useSiteValidate = useSite.filter((t) => t.name === "validate");
  if (aliasValidate.length + useSiteValidate.length > 0) {
    const allArgs: Expression[] = [];
    for (const t of [...aliasValidate, ...useSiteValidate]) {
      allArgs.push(...t.arguments);
    }
    combined.push({
      type: "tag",
      name: "validate",
      arguments: allArgs,
      loc: (aliasValidate[0] ?? useSiteValidate[0]).loc,
    });
  }

  const aliasJson = alias.filter((t) => t.name === "jsonSchema");
  const useSiteJson = useSite.filter((t) => t.name === "jsonSchema");
  if (aliasJson.length + useSiteJson.length > 0) {
    const merged = mergeJsonSchemaArgs([...aliasJson, ...useSiteJson]);
    combined.push({
      type: "tag",
      name: "jsonSchema",
      arguments: merged,
      loc: (aliasJson[0] ?? useSiteJson[0]).loc,
    });
  }

  // Pass through any other tags from each side verbatim. We never combine
  // across the two sides because we don't know what their semantics are.
  for (const t of alias) {
    if (t.name !== "validate" && t.name !== "jsonSchema") combined.push(t);
  }
  for (const t of useSite) {
    if (t.name !== "validate" && t.name !== "jsonSchema") combined.push(t);
  }

  return combined;
}

function mergeJsonSchemaArgs(tags: Tag[]): Expression[] {
  // Collect every entry / splat from every tag's first object-literal
  // argument, preserving the order: alias entries first, use-site entries
  // last. For literal keys present in both, the later (use-site) wins.
  // Splats are kept verbatim and stay in source order (their runtime
  // evaluation is what produces the final merged object).
  type Entry = AgencyObjectKV | SplatExpression;
  const entries: Entry[] = [];
  for (const t of tags) {
    const arg = t.arguments[0];
    if (!arg || arg.type !== "agencyObject") {
      const loc = (arg ?? t).loc;
      const where = loc ? ` (line ${loc.line}, col ${loc.col})` : "";
      throw new Error(
        `@jsonSchema(...) requires a single object-literal argument${where}; got ${arg ? arg.type : "no argument"}.`,
      );
    }
    for (const e of (arg as AgencyObject).entries) {
      entries.push(e);
    }
  }

  // Dedupe literal-key KVs (last write wins). Splats are preserved.
  const seenKeys = new Set<string>();
  const reversed: Entry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if ("key" in e) {
      if (seenKeys.has(e.key)) continue;
      seenKeys.add(e.key);
      reversed.push(e);
    } else {
      reversed.push(e);
    }
  }
  reversed.reverse();

  // First tag becomes the carrier of the merged object.
  const carrierLoc = (tags[0].arguments[0] as AgencyObject | undefined)?.loc;
  const mergedObject: AgencyObject = {
    type: "agencyObject",
    entries: reversed,
    ...(carrierLoc ? { loc: carrierLoc } : {}),
  } as AgencyObject;
  return [mergedObject as Expression];
}
