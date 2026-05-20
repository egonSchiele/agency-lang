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
  enforceSingleJsonSchema(aliasJson, "alias");
  enforceSingleJsonSchema(useSiteJson, "use site");
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

/**
 * Reject having more than one `@jsonSchema(...)` annotation on the same
 * side (alias-level or use-site). Multiple annotations on a single
 * target are ambiguous — callers should combine them into a single
 * object literal instead. Throws a location-aware error listing every
 * offending occurrence.
 */
function enforceSingleJsonSchema(tags: Tag[], side: string): void {
  if (tags.length <= 1) return;
  const locs = tags
    .map((t) =>
      t.loc ? `line ${t.loc.line}, col ${t.loc.col}` : "<unknown>",
    )
    .join(" and ");
  throw new Error(
    `Multiple @jsonSchema(...) annotations on the same target (${side}) are not allowed (found at ${locs}). Combine them into a single object literal.`,
  );
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

  // Special case: collapse repeated string-literal `description` entries
  // into a single newline-joined description, instead of last-write-wins.
  // The intent is that a reusable alias can attach a description and a
  // use-site can extend it (e.g. add usage context) without losing the
  // original. Only literal-string descriptions participate — non-literal
  // values (variable refs, function calls) and descriptions arriving via
  // `...spread` are left to the normal dedupe path, because we cannot
  // statically combine values we cannot read at type-check time.
  collapseLiteralDescriptions(entries);

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

type StringSegment = {
  type: "text" | "interpolation";
  value?: string;
  expression?: Expression;
};

type StringLikeLiteral = Expression & { segments: StringSegment[] };

/**
 * If `expr` is a plain string literal (no interpolation), return its raw
 * text. Otherwise return undefined so the caller can fall back to the
 * default merge behavior.
 */
function readLiteralString(expr: Expression): string | undefined {
  if (expr.type !== "string" && expr.type !== "multiLineString") {
    return undefined;
  }
  const segments = (expr as StringLikeLiteral).segments ?? [];
  let out = "";
  for (const seg of segments) {
    if (seg.type !== "text") return undefined;
    out += seg.value ?? "";
  }
  return out;
}

/**
 * In-place: if `entries` contains 2+ `description` KVs whose values are
 * all plain string literals, replace them with a single description
 * whose text is the originals joined by `\n`. The merged description
 * takes the position of the first one so non-description neighbours
 * keep their relative order; subsequent duplicates are removed so the
 * normal dedupe pass becomes a no-op for `description`. Locations and
 * the carrier literal's `type` (`string` vs `multiLineString`) follow
 * the first description's node.
 */
function collapseLiteralDescriptions(
  entries: Array<AgencyObjectKV | SplatExpression>,
): void {
  const indices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if ("key" in e && e.key === "description") indices.push(i);
  }
  if (indices.length < 2) return;

  const texts: string[] = [];
  for (const i of indices) {
    const kv = entries[i] as AgencyObjectKV;
    const text = readLiteralString(kv.value);
    // If any description is not a plain literal, bail and let the
    // default dedupe (last-write-wins) handle it.
    if (text === undefined) return;
    texts.push(text);
  }

  const joined = texts.join("\n");
  const firstKv = entries[indices[0]] as AgencyObjectKV;
  const carrier = firstKv.value as StringLikeLiteral;
  const newLiteral: StringLikeLiteral = {
    ...carrier,
    segments: [{ type: "text", value: joined }],
  };
  entries[indices[0]] = { ...firstKv, value: newLiteral as Expression };

  // Remove the trailing duplicate descriptions (back-to-front so the
  // earlier indices stay valid).
  for (let k = indices.length - 1; k >= 1; k--) {
    entries.splice(indices[k], 1);
  }
}
