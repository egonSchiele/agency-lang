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
 * - Any other tag name: concatenated.
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

  // Collect tag groups by name in the order they're first seen.
  const seenNames = new Set<string>();
  for (const t of [...alias, ...useSite]) {
    if (!seenNames.has(t.name)) seenNames.add(t.name);
  }

  for (const name of seenNames) {
    const aliasOfName = alias.filter((t) => t.name === name);
    const useSiteOfName = useSite.filter((t) => t.name === name);
    const all = [...aliasOfName, ...useSiteOfName];

    if (name === "validate") {
      // Concat all argument lists into one @validate tag.
      const allArgs: Expression[] = [];
      for (const t of all) allArgs.push(...t.arguments);
      combined.push({
        type: "tag",
        name: "validate",
        arguments: allArgs,
        loc: all[0].loc,
      });
    } else if (name === "jsonSchema") {
      // Merge all argument objects left-to-right. Each argument is
      // expected to be a single object literal (per spec — multiple
      // @jsonSchema on the same target is an error, but the merge
      // across alias-then-use-site is allowed).
      const merged = mergeJsonSchemaArgs(all);
      combined.push({
        type: "tag",
        name: "jsonSchema",
        arguments: merged,
        loc: all[0].loc,
      });
    } else {
      // Other tags: concat verbatim.
      for (const t of all) combined.push(t);
    }
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
      // Not a well-formed @jsonSchema(...) — leave the tag's args alone.
      return arg ? [arg] : [];
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
