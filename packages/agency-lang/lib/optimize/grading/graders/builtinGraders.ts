import { BaseGrader } from "../baseGrader.js";
import { getPath } from "../getPath.js";
import type { Grade, GraderInput, GraderOptions, Input, JSONPath } from "../types.js";

/** Graders that compare the agent output against a value read from the input. */
type MatchOptions = GraderOptions & { matchOn: JSONPath };

/** Shared base for graders that compare the output against a value read from the
 *  input via a `matchOn` JSONPath. Centralizes the constructor, the human
 *  description, and the pre-flight matchOn check. */
abstract class MatchGrader extends BaseGrader {
  constructor(protected readonly options: MatchOptions) {
    super(options);
  }

  describe(): string {
    return `${this.name()} (matchOn ${stringify(this.options.matchOn)})`;
  }

  validateInput(input: Input): void {
    resolveMatch(input, this.options.matchOn, this.name());   // throws if unresolved
  }
}

/** Binary: the agent output deep-equals the referenced value. */
export class ExactMatchGrader extends MatchGrader {
  protected readonly defaultName = "exact-match";

  protected async _run({ input, run }: GraderInput): Promise<Grade> {
    const expected = this.reference(input);
    if (deepEqual(expected, run.output)) {
      return { score: { kind: "binary", pass: true } };
    }
    return {
      score: { kind: "binary", pass: false },
      feedback: `expected ${stringify(expected)}, got ${stringify(run.output)}`,
    };
  }

  private reference(input: Input): unknown {
    return resolveMatch(input, this.options.matchOn, this.name());
  }
}

/** Binary: the stringified agent output contains the referenced needle. */
export class ContainsGrader extends MatchGrader {
  protected readonly defaultName = "contains";

  protected async _run({ input, run }: GraderInput): Promise<Grade> {
    const needle = String(resolveMatch(input, this.options.matchOn, this.name()));
    if (String(run.output ?? "").includes(needle)) {
      return { score: { kind: "binary", pass: true } };
    }
    return { score: { kind: "binary", pass: false }, feedback: `output did not contain ${stringify(needle)}` };
  }
}

/** Scalar: normalized Levenshtein similarity between output and the referenced value. */
export class SimilarityGrader extends MatchGrader {
  protected readonly defaultName = "similarity";

  protected async _run({ input, run }: GraderInput): Promise<Grade> {
    const expected = String(resolveMatch(input, this.options.matchOn, this.name()));
    const actual = String(run.output ?? "");
    const longest = Math.max(expected.length, actual.length);
    const value = longest === 0 ? 1 : 1 - levenshtein(expected, actual) / longest;
    return { score: { kind: "scalar", value } };
  }
}

/** Read a grader's reference value; a `matchOn` that does not resolve is a misconfiguration. */
function resolveMatch(input: Input, matchOn: JSONPath, graderName: string): unknown {
  const value = getPath(input, matchOn);
  if (value === undefined) {
    throw new Error(`${graderName}: matchOn ${stringify(matchOn)} did not resolve on input ${input.id ?? "(no id)"}`);
  }
  return value;
}

function stringify(value: unknown): string {
  return globalThis.JSON.stringify(value);
}

/** Order-insensitive deep equality for JSON-shaped values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.hasOwn(bObj, k) && deepEqual(aObj[k], bObj[k]));
}

/** Classic Levenshtein edit distance (deterministic, dependency-free). */
function levenshtein(a: string, b: string): number {
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_unused, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[cols - 1];
}
