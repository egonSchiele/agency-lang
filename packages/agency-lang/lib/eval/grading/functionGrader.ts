import { z } from "zod";

import { BaseGrader } from "./baseGrader.js";
import { asJudgeText, goalJudgeFile, scalarGrade, ScalarVerdict } from "./goalJudgeFile.js";
import { rubricJudgeFile } from "./rubricJudgeFile.js";
import type { EvalRecord } from "@/eval/types.js";

import type { Grade, GraderInput, GraderOptions, Test, JSON } from "./types.js";
import type { TestInput } from "../runTypes.js";

/** What a metric function receives. `test` is the typed Test: what the agent
 *  was given is `test.input`, the gold answer is `test.expected`, and any extra
 *  per-test data lives under `test.metadata`. */
export type GraderContext<T = TestInput> = {
  output: JSON;
  test: Test<T>;
  /** The isolated directory the agent ran in. Read files the agent wrote. */
  workdir: string;
  /** The test's `graderFiles/` directory: answers and notes the agent never
   *  saw. "" when the test has none. */
  graderFiles: string;
  /** The parsed eval record: events, metrics, tool counts, interrupts, cost. */
  record: EvalRecord;
  /** The bundled LLM judges, one per question a grader can ask. Each
   *  returns a full Grade (the 0..1 score, the reasoning as `feedback`), so
   *  a metric can return it directly and the rationale is stored with the
   *  score. `output` falls back to `run.output` for every judge. */
  judges: Judges;
};

export type Judges = {
  /** Was the output the right answer to the goal? `expected` falls back to
   *  `test.expected`, so the judge grades against the gold answer when one
   *  is present, matching `LlmJudge`. Extra content is penalized and any
   *  expected text is authoritative: right for "name the capital", wrong for
   *  grading work against a standard. */
  goal: (args: { goal: string; output?: JSON; expected?: JSON }) => Promise<Grade>;
  /** How well does the output meet the standard? `context` is material the
   *  standard refers to (the source text, an editor's notes, a reference
   *  version), read as background and never as an answer to match. Use it
   *  when the question is "does this meet the bar", such as review findings. */
  rubric: (args: { standard: string; output?: JSON; context?: string }) => Promise<Grade>;
};

/** A metric: return a 0..1 number, a pass/fail boolean, or a full Grade. */
export type GraderFn<T = TestInput> = (
  ctx: GraderContext<T>,
) => number | boolean | Grade | Promise<number | boolean | Grade>;

/** Public "grader" union: a metric function or a configured grader instance. */
export type Grader<T = TestInput> = GraderFn<T> | BaseGrader;

/** Adapts a metric function into a single-shot BaseGrader so the whole grading
 *  pipeline (sampling, gating, weighting, scoring) treats it like any grader. */
export class FunctionGrader<T = TestInput> extends BaseGrader {
  protected readonly defaultName = "fn";
  constructor(
    private readonly fn: GraderFn<T>,
    options: GraderOptions = {},
  ) {
    super(options);
  }

  protected async _run({ test, run, runAgency, graderFiles }: GraderInput): Promise<Grade> {
    // The bundled judge takes (goal, output, expected); default expected to the
    // test's gold answer so a metric that calls ctx.judges.goal({ goal }) grades the
    // same way LlmJudge does when test.expected is present.
    const inputExpected = (test as { expected?: JSON }).expected;
    const goalJudge = async ({
      goal,
      output,
      expected,
    }: {
      goal: string;
      output?: JSON;
      expected?: JSON;
    }) => {
      const exp = expected ?? inputExpected;
      const expectedText = exp === undefined || exp === null ? "" : asJudgeText(exp);
      const verdict = await runAgency.runStructured(
        goalJudgeFile(),
        "main",
        [goal, asJudgeText(output ?? run.output), expectedText],
        ScalarVerdict,
      );
      return scalarGrade(verdict);
    };
    const rubricJudge = async ({
      standard,
      output,
      context,
    }: {
      standard: string;
      output?: JSON;
      context?: string;
    }) => {
      const verdict = await runAgency.runStructured(
        rubricJudgeFile(),
        "main",
        [standard, asJudgeText(output ?? run.output), context ?? ""],
        ScalarVerdict,
      );
      return scalarGrade(verdict);
    };
    // The harness knows nothing about the input's shape; the module that
    // declared T is promising it, and nothing here checks that promise.
    const result = await this.fn({
      output: run.output,
      test: test as Test<T>,
      judges: { goal: goalJudge, rubric: rubricJudge },
      workdir: run.workdir,
      graderFiles: graderFiles ?? "",
      record: run.record,
    });
    return coerce(result);
  }
}

/** A well-formed Grade: a scalar/binary score plus optional feedback. */
const GradeSchema = z.object({
  score: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("scalar"), value: z.number() }),
    z.object({ kind: z.literal("binary"), pass: z.boolean() }),
  ]),
  feedback: z.string().optional(),
});

function coerce(result: number | boolean | Grade): Grade {
  if (typeof result === "number") return { score: { kind: "scalar", value: result } };
  if (typeof result === "boolean") return { score: { kind: "binary", pass: result } };
  const parsed = GradeSchema.safeParse(result);
  if (parsed.success) return parsed.data;
  throw new Error(
    `grader function must return a number, a boolean, or a Grade ({ score, feedback? }); got ${JSON.stringify(result)}`,
  );
}

/** Wrap a metric function so it carries policy (mustPass/weight/threshold/samples/name). */
export function grader<T = TestInput>(fn: GraderFn<T>, options: GraderOptions = {}): BaseGrader {
  return new FunctionGrader(fn, options);
}

/** Normalize a user-supplied grader (function or instance) into a BaseGrader. */
export function toGrader<T = TestInput>(spec: Grader<T>): BaseGrader {
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

/** The BaseGrader public surface we rely on — enough to accept a grader instance
 *  that came from a different realm (its own resolved copy of agency-lang). */
const GraderLikeSchema = z.object({
  run: z.function(),
  name: z.function(),
  mustPass: z.function(),
});

function isGraderLike(spec: unknown): spec is BaseGrader {
  return GraderLikeSchema.safeParse(spec).success;
}
