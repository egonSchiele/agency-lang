/**
 * Names that start with two underscores belong to the compiler and runtime:
 * `__matchval_1`, `__ctx`, `__self`. A user program may neither declare nor
 * read one. See `docs/dev/language/reserved-names.md`.
 */

/** The prefix template hygiene gives a renamed variable: `__hyg3_tmp`. */
export const HYGIENE_PREFIX = "__hyg";

// Filled template code is printed and may be saved to a file that is compiled
// later, so the parser has to accept a hygienic rename in any file.
const HYGIENE_NAME = new RegExp(`^${HYGIENE_PREFIX}\\d+_`);

/** Internal names a user program is meant to read. */
const READABLE_INTERNAL_NAMES: readonly string[] = ["__dirname"];

/** Whether a user program is forbidden from using `name`. */
export function isReservedInternalName(name: string): boolean {
  if (!name.startsWith("__")) {
    return false;
  }
  return !READABLE_INTERNAL_NAMES.includes(name) && !HYGIENE_NAME.test(name);
}

export function reservedInternalNameMessage(name: string): string {
  return `\`${name}\` is not a legal name: names starting with two underscores are reserved for the compiler.`;
}
