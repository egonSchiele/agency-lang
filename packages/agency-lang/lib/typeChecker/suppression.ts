import type { TypeCheckError } from "./types.js";

export type Suppressions = {
  /** True when `// @tc-nocheck` appears in the file's leading directive
   * region — silences all typecheck errors for the file. */
  nocheck: boolean;
  /** 0-indexed line numbers where typecheck errors should be suppressed —
   * matches the parser's `SourceLocation.line` convention. Populated for
   * every line *following* a `// @tc-ignore` comment. */
  ignoreLines: Set<number>;
};

const NOCHECK = "@tc-nocheck";
const IGNORE = "@tc-ignore";

/**
 * Scan source text for typecheck-suppression directives:
 *
 *   // @tc-nocheck   — must appear in the file's leading directive region
 *                     (only blank lines and other `//` comments before it);
 *                     suppresses every typecheck error in the file.
 *
 *   // @tc-ignore    — suppresses typecheck errors on the next line.
 *
 * Only `//`-style comments are recognized. Trailing comments on a line of
 * code do *not* count, matching TypeScript's `@ts-ignore` semantics.
 */
export function parseSuppressions(source: string): Suppressions {
  const ignoreLines = new Set<number>();
  let nocheck = false;
  let leadingDirectiveRegion = true;

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed === "") continue; // blanks don't end the leading region

    if (!trimmed.startsWith("//")) {
      leadingDirectiveRegion = false;
      continue;
    }

    const body = trimmed.slice(2).trim();
    if (leadingDirectiveRegion && body.includes(NOCHECK)) {
      nocheck = true;
    }
    if (body.includes(IGNORE)) {
      ignoreLines.add(i + 1);
    }
  }

  return { nocheck, ignoreLines };
}

/**
 * Drop errors covered by `suppressions`. `lineOffset` is subtracted from
 * each ignoreLine before comparing against `error.loc.line` — needed when
 * the parser produced loc.line values in a different convention than the
 * raw-source 0-indexed lines `parseSuppressions` emits (e.g. LSP path,
 * where `applyTemplate=false` shifts loc.line by -AGENCY_TEMPLATE_OFFSET).
 */
export function applySuppressions(
  errors: TypeCheckError[],
  suppressions: Suppressions,
  lineOffset: number = 0,
): TypeCheckError[] {
  if (suppressions.nocheck) return [];
  if (suppressions.ignoreLines.size === 0) return errors;
  return errors.filter(
    (e) => !e.loc || !suppressions.ignoreLines.has(e.loc.line + lineOffset),
  );
}
