import type { Tag } from "../types/tag.js";
import type { Expression } from "../types.js";
import type { ScopedField } from "../runtime/alwaysScope.js";

/** `@always(f1, f2)` and `@alwaysUnder(d1, d2)` on an effect declaration
 *  name the payload fields an "approve always here" policy rule pins.
 *  `@always` pins the exact value; `@alwaysUnder` pins the value and every
 *  subpath under it. See docs/dev/language/effect-always-tag.md. */
export const ALWAYS_TAG = "always";
export const ALWAYS_UNDER_TAG = "alwaysUnder";

export type AlwaysProblemKind = "badArgument" | "repeatedTag" | "namedTwice";
export type AlwaysTagProblem = { kind: AlwaysProblemKind; tag: string; loc: Tag["loc"] };
export type AlwaysScope = { fields: ScopedField[]; problems: AlwaysTagProblem[] };

export function isAlwaysTag(tag: Tag): boolean {
  return tag.name === ALWAYS_TAG || tag.name === ALWAYS_UNDER_TAG;
}

export function hasAlwaysScope(tags: Tag[] = []): boolean {
  return tags.some(isAlwaysTag);
}

function isIdentifier(argument: Expression): boolean {
  return argument.type === "variableName";
}

/** The field names a tag's arguments name. Non-identifier arguments are
 *  dropped here and reported by `readAlwaysScope`. */
function fieldNames(tag: Tag): string[] {
  return tag.arguments
    .filter(isIdentifier)
    .map((argument) => (argument as { value: string }).value);
}

function problem(kind: AlwaysProblemKind, tag: Tag): AlwaysTagProblem {
  return { kind, tag: tag.name, loc: tag.loc };
}

function hasNonIdentifierArgument(tag: Tag): boolean {
  return !tag.arguments.every(isIdentifier);
}

function countOf(name: string, names: string[]): number {
  return names.filter((other) => other === name).length;
}

export function readAlwaysScope(tags: Tag[] = []): AlwaysScope {
  const exactTags = tags.filter((tag) => tag.name === ALWAYS_TAG);
  const underTags = tags.filter((tag) => tag.name === ALWAYS_UNDER_TAG);
  const alwaysTags = [...exactTags, ...underTags];
  const exactNames = exactTags.flatMap(fieldNames);
  const underNames = underTags.flatMap(fieldNames);
  const allNames = [...exactNames, ...underNames];

  const fields: ScopedField[] = [
    ...exactNames.map((field) => ({ field, matchSubpaths: false })),
    ...underNames.map((field) => ({ field, matchSubpaths: true })),
  ];

  const badArgument = alwaysTags
    .filter(hasNonIdentifierArgument)
    .map((tag) => problem("badArgument", tag));
  const repeatedTag = [exactTags, underTags]
    .filter((group) => group.length > 1)
    .map((group) => problem("repeatedTag", group[1]));
  const namedTwice = alwaysTags
    .filter((tag) => fieldNames(tag).some((name) => countOf(name, allNames) > 1))
    .map((tag) => problem("namedTwice", tag));

  return { fields, problems: [...badArgument, ...repeatedTag, ...namedTwice] };
}
