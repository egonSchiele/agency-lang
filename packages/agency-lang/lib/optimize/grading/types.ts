import type { AgencyRunner } from "./agencyRunner.js";

/** A JSON-compatible value. */
export type JSON = string | number | boolean | null | JSON[] | { [key: string]: JSON };

/** A path of object keys / array indices into a JSON value. */
export type JSONPath = (string | number)[];

/** One invocation of the agent under optimization. */
export type Input = {
  id?: string;                       // optional; callers auto-derive when omitted
  node?: string;                     // defaults to "main" at run time
  args: Record<string, JSON>;
  metadata?: Record<string, JSON>;   // freeform, grader-agnostic (title, expectedOutput, tags, …)
};

/** The result of running the agent on one input. */
export type AgentRun = {
  output: JSON;        // the agent's return value
  recordPath: string;  // path to the full execution trace (eval record)
};

/** A grader's score: pass/fail or a continuous value. */
export type Score =
  | { kind: "binary"; pass: boolean }
  | { kind: "scalar"; value: number };

/** A grader's output: a score plus optional natural-language feedback. */
export type Grade = { score: Score; feedback?: string };

/** Restricts a grader to a subset of inputs. */
export type GraderScope = { tag: string } | { ids: string[] };

/** Options common to every grader; subclasses extend this with their own fields. */
export type GraderOptions = {
  mustPass?: boolean;            // gate: failure fails the whole iteration for this input
  threshold?: number;            // scalar passing bar (binary reads `pass`)
  weight?: number;               // contribution to the scalarized objective (default 1)
  samples?: number;              // k repetitions (default 1; must be a positive integer)
  aggregate?: "any" | "all";     // binary only; scalar always averages
  inputScope?: GraderScope;      // restrict to a subset of inputs (default: all)
  name?: string;                 // overrides the grader's defaultName
};

/** What a grader's `_run` receives. */
export type GraderInput = {
  input: Input;
  run: AgentRun;
  runAgency: AgencyRunner;   // capability to invoke a judge .agency file
};
