/**
 * The one exact-match verdict shared by the `agency test` CLI runner and
 * std::agency's test()/testFile(): structural equality on canonicalized
 * values, so JSON key order and whitespace never decide a test.
 */
import { canonicalize } from "../utils/canonicalize.js";
import { formatDiff } from "../utils/diff.js";

export type PassingVerdict = { pass: true };
export type FailingVerdict = { pass: false; feedback: string };
export type Verdict = PassingVerdict | FailingVerdict;

export type ExactVerdictOptions = {
  rawStringFallback: boolean;
  /** Colorize the failing diff (terminal output). Default off. */
  colorize?: boolean;
};

/** Wire form: `expectedOutput` is the raw string from a `.test.json`.
 *
 *  rawStringFallback=true (the FULL profile / CLI): an expectedOutput that
 *  does not parse as JSON falls back to the legacy raw-string comparison
 *  against `JSON.stringify(actual)` — existing fixtures depend on it.
 *  false (sandbox): unparseable expectedOutput throws with quoting
 *  guidance; sandbox callers pre-parse at the schema layer anyway. */
export function exactVerdict(
  actual: unknown,
  expectedOutput: string,
  options: ExactVerdictOptions,
): Verdict {
  let expected: unknown;
  try {
    expected = JSON.parse(expectedOutput);
  } catch {
    if (!options.rawStringFallback) {
      throw new Error(
        `expectedOutput ${JSON.stringify(expectedOutput)} is not valid JSON. ` +
          `A plain string must be quoted: "\\"ok\\"" means the string ok.`,
      );
    }
    // JSON.stringify(undefined) is undefined, not a string; render it the
    // way canonicalText does so the diff never receives a non-string.
    const actualText = JSON.stringify(actual) ?? "undefined";
    if (actualText === expectedOutput) return { pass: true };
    return {
      pass: false,
      feedback: formatDiff(expectedOutput, actualText, { colorize: options.colorize ?? false }),
    };
  }
  return exactVerdictValue(actual, expected, options.colorize ?? false);
}

/** Value form: both sides already parsed. Canonical structural equality —
 *  object key order is irrelevant, everything else must match. */
export function exactVerdictValue(
  actual: unknown,
  expected: unknown,
  colorize: boolean = false,
): Verdict {
  const expectedCanonical = canonicalText(expected);
  const actualCanonical = canonicalText(actual);
  if (expectedCanonical === actualCanonical) return { pass: true };
  return {
    pass: false,
    feedback: formatDiff(expectedCanonical, actualCanonical, { colorize }),
  };
}

/** utils/canonicalize plus one rule: a top-level `undefined`
 *  (JSON.stringify yields no string at all) renders as the literal text
 *  "undefined" so a missing value diffs legibly instead of crashing. */
function canonicalText(value: unknown): string {
  if (value === undefined) return "undefined";
  return canonicalize(value);
}
