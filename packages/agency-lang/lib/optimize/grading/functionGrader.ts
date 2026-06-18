import { BaseGrader } from "./baseGrader.js";
import { asJudgeText, goalJudgeFile, ScalarVerdict } from "../goalJudgeFile.js";
import type { Grade, GraderInput, GraderOptions, Input, JSON } from "./types.js";

/** What a metric function receives. `input` is the typed Input; per-input grading
 *  data (an expected answer, tags) lives under `input.metadata`. */
export type GraderContext = {
  output: JSON;
  input: Input;
  /** Run the bundled LLM goal judge and get back its 0..1 score + reasoning. */
  judge: (args: { goal: string; output?: JSON }) => Promise<{ score: number; reasoning: string }>;
};

/** A metric: return a 0..1 number, a pass/fail boolean, or a full Grade. */
export type GraderFn = (ctx: GraderContext) => number | boolean | Grade | Promise<number | boolean | Grade>;

/** Public "grader" union: a metric function or a configured grader instance. */
export type Grader = GraderFn | BaseGrader;

/** Adapts a metric function into a single-shot BaseGrader so the whole grading
 *  pipeline (sampling, gating, weighting, scoring) treats it like any grader. */
export class FunctionGrader extends BaseGrader {
  protected readonly defaultName = "fn";
  constructor(private readonly fn: GraderFn, options: GraderOptions = {}) {
    super(options);
  }

  protected async _run({ input, run, runAgency }: GraderInput): Promise<Grade> {
    const judge = ({ goal, output }: { goal: string; output?: JSON }) =>
      runAgency.runStructured(goalJudgeFile(), "main", [goal, asJudgeText(output ?? run.output)], ScalarVerdict);
    const result = await this.fn({ output: run.output, input, judge });
    return coerce(result);
  }
}

function coerce(result: number | boolean | Grade): Grade {
  if (typeof result === "number") return { score: { kind: "scalar", value: result } };
  if (typeof result === "boolean") return { score: { kind: "binary", pass: result } };
  if (result && typeof result === "object" && "score" in result) return result;
  throw new Error(`grader function must return a number, boolean, or {score} object; got ${typeof result}`);
}

/** Wrap a metric function so it carries policy (mustPass/weight/threshold/inputScope/samples/name). */
export function grader(fn: GraderFn, options: GraderOptions = {}): BaseGrader {
  return new FunctionGrader(fn, options);
}

/** Normalize a user-supplied grader (function or instance) into a BaseGrader. */
export function toGrader(spec: Grader): BaseGrader {
  if (spec instanceof BaseGrader) return spec;
  // A grader loaded from a user module may be a BaseGrader from a *different*
  // realm (its own resolved copy of agency-lang), so `instanceof` can miss it.
  // Duck-type the BaseGrader public surface to accept it across the boundary.
  if (isGraderLike(spec)) return spec as BaseGrader;
  if (typeof spec === "function") return new FunctionGrader(spec);
  throw new Error(
    `Invalid grader: expected a grader function or grader instance, got ${spec === null ? "null" : typeof spec}.`,
  );
}

function isGraderLike(spec: unknown): spec is BaseGrader {
  return (
    !!spec &&
    typeof spec === "object" &&
    typeof (spec as { run?: unknown }).run === "function" &&
    typeof (spec as { name?: unknown }).name === "function" &&
    typeof (spec as { mustPass?: unknown }).mustPass === "function"
  );
}
