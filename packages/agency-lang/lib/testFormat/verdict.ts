/**
 * The one exact-match verdict shared by the `agency test` CLI runner and
 * std::agency's test()/testFile(): structural equality on canonicalized
 * values, so JSON key order and whitespace never decide a test.
 */
import { formatDiff } from "../utils/diff.js";

export type PassingVerdict = { pass: true };
export type FailingVerdict = { pass: false; feedback: string };
export type Verdict = PassingVerdict | FailingVerdict;

export type ExactVerdictOptions = { rawStringFallback: boolean };

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
    const actualText = JSON.stringify(actual);
    if (actualText === expectedOutput) return { pass: true };
    return { pass: false, feedback: formatDiff(expectedOutput, actualText, { colorize: false }) };
  }
  return exactVerdictValue(actual, expected);
}

/** Value form: both sides already parsed. Canonical structural equality —
 *  object key order is irrelevant, everything else must match. */
export function exactVerdictValue(actual: unknown, expected: unknown): Verdict {
  const expectedCanonical = canonicalize(expected);
  const actualCanonical = canonicalize(actual);
  if (expectedCanonical === actualCanonical) return { pass: true };
  return {
    pass: false,
    feedback: formatDiff(expectedCanonical, actualCanonical, { colorize: false }),
  };
}

/** Deterministic JSON text: object keys sorted at every depth. `undefined`
 *  (JSON.stringify yields no string at all) renders as the literal text
 *  "undefined" so a missing value diffs legibly instead of crashing. */
function canonicalize(value: unknown): string {
  const text = JSON.stringify(sortKeys(value));
  return text === undefined ? "undefined" : text;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
