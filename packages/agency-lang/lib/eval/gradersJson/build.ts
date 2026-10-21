import { spawnSync } from "child_process";

import type { EvalRecord } from "@/eval/types.js";

import type { BaseGrader } from "../grading/baseGrader.js";
import { grader } from "../grading/functionGrader.js";
import { binary, scalar } from "../grading/grade.js";
import { formatUsd } from "../grading/gradeBreakdown.js";
import { ChecklistJudge } from "../grading/graders/checklistJudge.js";
import { LlmJudge } from "../grading/graders/llmJudge.js";
import type { Grade, GraderOptions } from "../grading/types.js";
import type {
  ChecklistSpec,
  CommandSpec,
  CountSpec,
  GoalSpec,
  GraderSpec,
  GradersJson,
  NumberSpec,
} from "./schema.js";

/** Turn the graders of a `graders.json` into `BaseGrader`s, in file order. */
export function buildGraders(specs: GradersJson): BaseGrader[] {
  return specs.map((spec) => BUILDERS[spec.kind](spec as never));
}

const BUILDERS: {
  [K in GraderSpec["kind"]]: (spec: Extract<GraderSpec, { kind: K }>) => BaseGrader;
} = {
  goal: goalGrader,
  checklist: checklistGrader,
  number: numberGrader,
  count: countGrader,
  command: commandGrader,
};

/** The three fields every kind shares, read in one place. */
function optionsOf(spec: GraderSpec): GraderOptions {
  const options: GraderOptions = { name: spec.name };
  if (spec.weight !== undefined) {
    options.weight = spec.weight;
  }
  if (spec.mustPass !== undefined) {
    options.mustPass = spec.mustPass;
  }
  return options;
}

// --- goal and checklist -----------------------------------------------------

/** The bundled goal judge over the test's output. `passingScore` is the
 *  threshold; the parser requires it on a must-pass goal grader. */
function goalGrader(spec: GoalSpec): BaseGrader {
  const options = optionsOf(spec);
  if (spec.passingScore !== undefined) {
    options.threshold = spec.passingScore;
  }
  return new LlmJudge({ ...options, goal: spec.goal });
}

function checklistGrader(spec: ChecklistSpec): BaseGrader {
  const options = optionsOf(spec);
  return new ChecklistJudge({ ...options, points: spec.points, context: spec.context });
}

// --- number -----------------------------------------------------------------

const MS_PER_SECOND = 1000;
const TOKENS_PER_THOUSAND = 1000;

type Measure = { read: (record: EvalRecord) => number; describe: (value: number) => string };

/** What each measure reads from the record and how its value is shown. */
const MEASURES: Record<NumberSpec["measure"], Measure> = {
  llmCalls: {
    read: (record) => record.metrics.llmCalls,
    describe: (value) => `${value} LLM calls`,
  },
  costUsd: {
    read: (record) => record.metrics.costUsdTotal,
    describe: formatUsd,
  },
  agentSeconds: {
    read: (record) => record.durationMs / MS_PER_SECOND,
    describe: (value) => `${Math.round(value)}s`,
  },
  tokensIn: {
    read: (record) => record.metrics.tokensInTotal,
    describe: (value) => `${thousands(value)} tokens in`,
  },
  tokensOut: {
    read: (record) => record.metrics.tokensOutTotal,
    describe: (value) => `${thousands(value)} tokens out`,
  },
};

function thousands(value: number): string {
  return `${Math.round(value / TOKENS_PER_THOUSAND)}k`;
}

/** With `max`, pass or fail. With `full` and `zero`, 1 at `full`, 0 at
 *  `zero`, a straight line between, clamped outside. */
function numberGrader(spec: NumberSpec): BaseGrader {
  const measure = MEASURES[spec.measure];
  return grader(({ record }) => {
    const value = measure.read(record);
    const description = measure.describe(value);
    if (spec.max !== undefined) {
      return binary(value <= spec.max, description);
    }
    const full = spec.full ?? 0;
    const zero = spec.zero ?? 0;
    return scalar(clamp((zero - value) / (zero - full)), description);
  }, optionsOf(spec));
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// --- count ------------------------------------------------------------------

/** The fields a narrowing can read, built from whichever record row it was. */
type CountRow = { tool?: string; args?: string; message?: string };

/** Which record rows each count selects. */
const COUNTS: Record<CountSpec["count"], (record: EvalRecord) => CountRow[]> = {
  toolCalls: (record) =>
    record.events.flatMap((event) =>
      event.kind === "tool_start" ? [{ tool: event.tool, args: event.argsPreview }] : [],
    ),
  errors: (record) => record.errors.map((error) => ({ message: error.message })),
  llmCalls: (record) => record.events.flatMap((event) => (event.kind === "llm" ? [{}] : [])),
};

/** Select the rows, keep the ones the narrowings allow, and compare the
 *  count with `max`. `repeated` keeps a row only when an earlier kept row
 *  had the same tool and arguments. */
function countGrader(spec: CountSpec): BaseGrader {
  const select = COUNTS[spec.count];
  return grader(({ record }) => {
    const kept = select(record).filter(
      (row) =>
        (spec.tool === undefined || row.tool === spec.tool) &&
        (spec.messageStartsWith === undefined ||
          (row.message ?? "").startsWith(spec.messageStartsWith)),
    );
    const rows = spec.repeated === true ? repeats(kept) : kept;
    const n = rows.length;
    return binary(n <= spec.max, `${n} matching row${n === 1 ? "" : "s"}, max ${spec.max}`);
  }, optionsOf(spec));
}

function repeats(rows: CountRow[]): CountRow[] {
  return rows.filter((row, index) =>
    rows.slice(0, index).some((earlier) => earlier.tool === row.tool && earlier.args === row.args),
  );
}

// --- command ----------------------------------------------------------------

const DEFAULT_COMMAND_TIMEOUT_SEC = 600;
const COMMAND_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const FEEDBACK_MAX_CHARS = 2000;

/** The environment variable a command reads the test's grader-only files
 *  through. Those files are stored apart from the agent's workdir. */
const GRADER_FILES_ENV = "AGENCY_GRADER_FILES";

/** Run a shell command in the agent's working directory. Exit 0 passes.
 *  stdin is closed so a command that reads it sees end of file. At the
 *  timeout the shell is killed outright, since a command may ignore a
 *  polite signal. */
function commandGrader(spec: CommandSpec): BaseGrader {
  const timeoutSec = spec.timeoutSec ?? DEFAULT_COMMAND_TIMEOUT_SEC;
  return grader(
    ({ workdir, graderFiles }) => runCommand(spec.command, workdir, graderFiles, timeoutSec),
    optionsOf(spec),
  );
}

function runCommand(
  command: string,
  workdir: string,
  graderFiles: string,
  timeoutSec: number,
): Grade {
  if (workdir === "") {
    return binary(false, "no working directory was captured");
  }
  const result = spawnSync("sh", ["-c", command], {
    cwd: workdir,
    env: { ...process.env, [GRADER_FILES_ENV]: graderFiles },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutSec * MS_PER_SECOND,
    killSignal: "SIGKILL",
    maxBuffer: COMMAND_OUTPUT_MAX_BYTES,
  });
  if ((result.error as { code?: string } | undefined)?.code === "ETIMEDOUT") {
    return binary(false, `timed out after ${timeoutSec}s`);
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return binary(result.status === 0, cut(output));
}

function cut(text: string): string {
  return text.length > FEEDBACK_MAX_CHARS ? `${text.slice(0, FEEDBACK_MAX_CHARS)}…` : text;
}
