import { BaseGrader } from "./baseGrader.js";
import { getPath } from "./getPath.js";
import type { Grade, GraderInput, GraderOptions, JsonPath } from "./types.js";

/** Graders that compare the agent output against a value read from the input. */
type MatchOptions = GraderOptions & { matchOn: JsonPath };

/** Binary: the agent output deep-equals the referenced value. */
export class ExactMatchGrader extends BaseGrader {
  protected readonly defaultName = "exact-match";
  constructor(protected readonly options: MatchOptions) {
    super(options);
  }
  protected _run({ input, run }: GraderInput): Promise<Grade> {
    const expected = getPath(input, this.options.matchOn);
    const pass = JSON.stringify(expected) === JSON.stringify(run.output);
    return Promise.resolve({
      score: { kind: "binary", pass },
      ...(pass ? {} : { feedback: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(run.output)}` }),
    });
  }
}

/** Binary: the stringified agent output contains the referenced needle. */
export class ContainsGrader extends BaseGrader {
  protected readonly defaultName = "contains";
  constructor(protected readonly options: MatchOptions) {
    super(options);
  }
  protected _run({ input, run }: GraderInput): Promise<Grade> {
    const needle = String(getPath(input, this.options.matchOn) ?? "");
    const pass = String(run.output ?? "").includes(needle);
    return Promise.resolve({
      score: { kind: "binary", pass },
      ...(pass ? {} : { feedback: `output did not contain ${JSON.stringify(needle)}` }),
    });
  }
}

/** Scalar: normalized Levenshtein similarity between output and the referenced value. */
export class SimilarityGrader extends BaseGrader {
  protected readonly defaultName = "similarity";
  constructor(protected readonly options: MatchOptions) {
    super(options);
  }
  protected _run({ input, run }: GraderInput): Promise<Grade> {
    const expected = String(getPath(input, this.options.matchOn) ?? "");
    const actual = String(run.output ?? "");
    const longest = Math.max(expected.length, actual.length);
    const value = longest === 0 ? 1 : 1 - levenshtein(expected, actual) / longest;
    return Promise.resolve({ score: { kind: "scalar", value } });
  }
}

/** Classic Levenshtein edit distance (deterministic, dependency-free). */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_unused, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const curr = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[cols - 1];
}
