import type { Test, TestInput } from "@/eval/runTypes.js";
import type { EvalRecord } from "@/eval/types.js";

import type { AgencyRunner } from "./agencyRunner.js";

/** The unified run-spec type lives in the eval layer; re-export it so the many
 *  `import { Test } from "./types.js"` sites in the optimizer keep working. */
export type { Test };

/** A JSON-compatible value. */
export type JSON = string | number | boolean | null | JSON[] | { [key: string]: JSON };

/** A path of object keys / array indices into a JSON value. */
export type JSONPath = (string | number)[];

/** One trace's evidence as grading sees it — as opposed to `AgentRun`
 *  (lib/eval/run/runAgent.ts), which is the outcome of EXECUTING. */
export type LoadedRun = {
  output: JSON; // the agent's return value (last recorded eval output), or null
  traceId: string; // which trace in the run directory this is
  workdir: string; // the agent's workdir snapshot ("" when none was captured)
  record: EvalRecord; // the trace's eval record, computed from the statelog
};

/** A grader's score: pass/fail or a continuous value. */
export type Score = { kind: "binary"; pass: boolean } | { kind: "scalar"; value: number };

/** A grader's output: a score plus optional natural-language feedback. */
export type Grade = { score: Score; feedback?: string };

/** Options common to every grader; subclasses extend this with their own fields. */
export type GraderOptions = {
  mustPass?: boolean; // gate: failure fails the whole iteration for this input
  threshold?: number; // scalar passing bar (binary reads `pass`)
  weight?: number; // contribution to the scalarized objective (default 1)
  samples?: number; // k repetitions (default 1; must be a positive integer)
  aggregate?: "any" | "all"; // binary only; scalar always averages
  name?: string; // overrides the grader's defaultName
};

/** What a grader's `_run` receives. */
export type GraderInput<T = TestInput> = {
  test: Test<T>;
  run: LoadedRun;
  runAgency: AgencyRunner; // capability to invoke a judge .agency file
  /** The test's grader-only files, as a directory; absent when it has none. */
  graderFiles?: string;
};
