/**
 * Names that start with two underscores belong to the compiler and runtime:
 * `__matchval_1`, `__ctx`, `__self`. A user program may neither declare nor
 * read one. See `docs/dev/language/reserved-names.md`.
 */

/** The prefix template hygiene gives a renamed variable: `__hyg3_tmp`. */
export const HYGIENE_PREFIX = "__hyg";

// A hygienic rename is printed to source and parsed again when generated code
// runs, so the parser has to accept it.
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
