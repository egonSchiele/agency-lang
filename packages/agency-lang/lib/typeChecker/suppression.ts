import type { TypeCheckError } from "./types.js";

export type Suppressions = {
  /** True when `// @tc-nocheck` appears in the file's leading directive
   * region — silences all typecheck errors for the file. */
  nocheck: boolean;
  /** 0-indexed line numbers (the parser's `SourceLocation.line` convention)
   * mapped to what a `// @tc-ignore` directive on the PREVIOUS line
   * suppresses there: `"all"` for a bare directive (or one followed only by
   * prose), or the specific `AG####` codes it names. An empty code list
   * means a malformed code attempt — suppress nothing (fail closed). */
  ignoreLines: Record<number, "all" | string[]>;
};

const NOCHECK = "@tc-nocheck";
const IGNORE = "@tc-ignore";

/** A valid diagnostic code token, e.g. `AG2001`. */
const CODE_PATTERN = /^AG\d{4}$/;
/** A token that LOOKS like a code attempt but is malformed (`AG201`,
 *  `ag2001`). Distinguished from prose so a typo fails closed instead of
 *  silently widening the directive to suppress-everything. */
const CODE_ATTEMPT_PATTERN = /^ag\d+$/i;

/**
 * What a single `@tc-ignore` directive suppresses, from the text after the
 * marker. Bare directive or trailing prose → "all" (back-compat). Valid
 * codes → exactly those codes. Any malformed code attempt → an empty list
 * (the user clearly meant to name codes; a typo must not suppress more
 * than intended).
 */
function parseIgnoreRule(directiveTail: string): "all" | string[] {
  const tokens = directiveTail
    .split(/[\s,]+/)
    .filter((token) => token.length > 0);
  const codes = tokens.filter((token) => CODE_PATTERN.test(token));
  const malformedAttempt = tokens.some(
    (token) => !CODE_PATTERN.test(token) && CODE_ATTEMPT_PATTERN.test(token),
  );
  if (malformedAttempt) {
    return [];
  }
  if (codes.length > 0) {
    return codes;
  }
  return "all";
}

/**
 * Scan source text for typecheck-suppression directives:
 *
 *   // @tc-nocheck           — must appear in the file's leading directive
 *                              region (only blank lines and other `//`
 *                              comments before it); suppresses every
 *                              typecheck error in the file.
 *
 *   // @tc-ignore            — suppresses every typecheck error on the next
 *                              line.
 *
 *   // @tc-ignore AG2001     — suppresses only the named diagnostic codes on
 *                              the next line (comma- or space-separated).
 *
 * Only `//`-style comments are recognized. Trailing comments on a line of
 * code do *not* count, matching TypeScript's `@ts-ignore` semantics.
 */
export function parseSuppressions(source: string): Suppressions {
  // Null-prototype: keys are line numbers, but keep the codebase's dict
  // discipline anyway.
  const ignoreLines: Record<number, "all" | string[]> = Object.create(null);
  let nocheck = false;
  let leadingDirectiveRegion = true;

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === "") {
      continue; // blanks don't end the leading region
    }

    if (!trimmed.startsWith("//")) {
      leadingDirectiveRegion = false;
      continue;
    }

    const body = trimmed.slice(2).trim();
    if (leadingDirectiveRegion && body.includes(NOCHECK)) {
      nocheck = true;
    }
    const ignoreIdx = body.indexOf(IGNORE);
    if (ignoreIdx >= 0) {
      const tail = body.slice(ignoreIdx + IGNORE.length);
      ignoreLines[i + 1] = parseIgnoreRule(tail);
    }
  }

  return { nocheck, ignoreLines };
}

/**
 * Drop errors covered by `suppressions`. Both `error.loc.line` and the keys
 * in `ignoreLines` are 0-indexed in the user's source. File-level
 * diagnostics (`loc: null`) are never line-suppressible — only
 * `@tc-nocheck` reaches them.
 */
export function applySuppressions(
  errors: TypeCheckError[],
  suppressions: Suppressions,
): TypeCheckError[] {
  if (suppressions.nocheck) {
    return [];
  }
  return errors.filter((err) => {
    if (err.loc === null) {
      return true;
    }
    const rule = suppressions.ignoreLines[err.loc.line];
    if (rule === undefined) {
      return true;
    }
    if (rule === "all") {
      return false;
    }
    return !rule.includes(err.code);
  });
}
