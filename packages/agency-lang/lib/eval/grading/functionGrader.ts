import { z } from "zod";

import { BaseGrader } from "./baseGrader.js";
import { asJudgeText, goalJudgeFile, ScalarVerdict } from "./goalJudgeFile.js";
import type { EvalRecord } from "@/eval/types.js";

import type { Grade, GraderInput, GraderOptions, Test, JSON } from "./types.js";

/** What a metric function receives. `test` is the typed Test: what the agent
 *  was given is `test.input`, the gold answer is `test.expected`, and any extra
 *  per-test data lives under `test.metadata`. */
export type GraderContext = {
  output: JSON;
  test: Test;
  /** The isolated directory the agent ran in. Read files the agent wrote. */
  workdir: string;
  /** The parsed eval record: events, metrics, tool counts, interrupts, cost. */
  record: EvalRecord;
  /** Run the bundled LLM goal judge and get back its 0..1 score + reasoning.
   *  Defaults: `output` falls back to `run.output`, `expected` falls back to
   *  `input.expected` (so the bundled judge grades against the gold answer when
   *  one is present, matching `LlmJudge`). */
  judge: (args: {
    goal: string;
    output?: JSON;
    expected?: JSON;
  }) => Promise<{ score: number; reasoning: string }>;
};

/** A metric: return a 0..1 number, a pass/fail boolean, or a full Grade. */
export type GraderFn = (
  ctx: GraderContext,
) => number | boolean | Grade | Promise<number | boolean | Grade>;

/** Public "grader" union: a metric function or a configured grader instance. */
export type Grader = GraderFn | BaseGrader;

/** Adapts a metric function into a single-shot BaseGrader so the whole grading
 *  pipeline (sampling, gating, weighting, scoring) treats it like any grader. */
export class FunctionGrader extends BaseGrader {
  protected readonly defaultName = "fn";
  constructor(
    private readonly fn: GraderFn,
    options: GraderOptions = {},
  ) {
    super(options);
  }

  protected async _run({ test, run, runAgency }: GraderInput): Promise<Grade> {
    // The bundled judge takes (goal, output, expected); default expected to the
    // test's gold answer so a metric that calls ctx.judge({ goal }) grades the
    // same way LlmJudge does when test.expected is present.
    const inputExpected = (test as { expected?: JSON }).expected;
    const judge = ({
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
      return runAgency.runStructured(
        goalJudgeFile(),
        "main",
        [goal, asJudgeText(output ?? run.output), expectedText],
        ScalarVerdict,
      );
    };
    const result = await this.fn({
      output: run.output,
      test,
      judge,
      workdir: run.workdir,
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
