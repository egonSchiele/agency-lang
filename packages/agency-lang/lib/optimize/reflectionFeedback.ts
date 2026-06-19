import * as fs from "fs";

import type { EvalRecord, NormalizedEvent } from "@/eval/types.js";

import { inputObjective, type InputGrades } from "./grading/scorecard.js";
import type { Score } from "./grading/types.js";

export type ReflectionRenderOptions = { maxChars?: number };

const DEFAULT_MAX_CHARS = 2000;

/** One graded input rendered as a GEPA feedback block: input, output, errors, a compact
 *  tool-call trace, and graders' natural-language feedback. Bounded. */
export function renderInputFeedback(entry: InputGrades, opts: ReflectionRenderOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const record = loadRecord(entry.run.recordPath);
  const lines: string[] = [];
  const objective = inputObjective(entry.grades).toFixed(3);
  lines.push(`### Input ${entry.input.id ?? "(no id)"} — objective ${objective}${entry.gatesPassed ? "" : " (GATE FAILED)"}`);
  lines.push(`Args: ${preview(JSON.stringify(entry.input.args), 400)}`);
  lines.push(`Output: ${preview(stringifyOutput(entry.run.output), 600)}`);
  if (entry.input.expected !== undefined) {
    lines.push(`Expected: ${preview(stringifyOutput(entry.input.expected), 400)}`);
  }

  const errors = record?.errors ?? [];
  if (errors.length > 0) {
    lines.push("Errors:");
    for (const e of errors) lines.push(`  - [${e.errorType}] ${preview(e.message, 300)}`);
  }
  const toolLines = renderTools(record?.events ?? []);
  if (toolLines.length > 0) {
    lines.push("Tool calls:");
    lines.push(...toolLines.map((l) => `  ${l}`));
  }
  lines.push("Feedback:");
  for (const g of entry.grades) {
    lines.push(`  - ${g.grader.name()} = ${formatScore(g.grade.score)}${g.grade.feedback ? `: ${preview(g.grade.feedback, 400)}` : ""}`);
  }
  return clamp(lines.join("\n"), maxChars);
}

/** Render an already-sorted (weakest-first) set of focus inputs as one feedback section. */
export function renderReflectionFeedback(focus: InputGrades[], opts: ReflectionRenderOptions = {}): string {
  return focus.map((entry) => renderInputFeedback(entry, opts)).join("\n\n");
}

function formatScore(score: Score): string {
  if (score.kind === "scalar") return score.value.toFixed(3);
  return score.pass ? "pass" : "fail";
}

function renderTools(events: NormalizedEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind === "tool_start") out.push(`→ ${e.tool}(${preview(e.argsPreview, 200)})`);
    else if (e.kind === "tool_end") out.push(`← ${e.tool}: ${preview(e.outputPreview, 200)}`);
  }
  return out;
}

/** A missing/corrupt trace degrades to grades-only feedback — log and continue, never crash. */
function loadRecord(recordPath: string): EvalRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath, "utf8")) as EvalRecord;
  } catch (e) {
    console.warn(`gepa: could not read trace ${recordPath}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function stringifyOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function preview(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function clamp(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[trace truncated]`;
}
