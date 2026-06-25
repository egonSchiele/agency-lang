import * as fs from "fs";
import * as path from "path";

import renderTemplate from "@/templates/cli/optimizeReport.js";
import { asJudgeText } from "./goalJudgeFile.js";
import type { GradeRow, InputBreakdown } from "./gradeBreakdown.js";
import type { OptimizeResult } from "./types.js";

export type ReportMeta = {
  optimizer: string;
  graders: string[];
  trainObjective?: number;        // populated in Phase 3
  validationObjective?: number;   // populated in Phase 3
  validationConfiguredButUnused?: boolean;   // Phase 3, gepa/example honesty note
};

/** Escape a Markdown table cell: no pipes (column breaks) or newlines (row breaks). */
function cell(value: unknown): string {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render a human-readable Markdown report for an optimize run. Pure.
 *  The document skeleton lives in `templates/cli/optimizeReport.mustache`;
 *  here we build the (escaped) dynamic blocks it interpolates. */
export function renderReport(result: OptimizeResult, meta: ReportMeta): string {
  return renderTemplate({
    runId: result.runId,
    metaLines: metaLines(result, meta).join("\n"),
    iterationRows: result.iterations
      .map((it) => `| ${it.iter} | ${it.decision} | ${cell(it.detail ?? "")} |`)
      .join("\n"),
    championSection: championSection(result.championBreakdown),
  });
}

function metaLines(result: OptimizeResult, meta: ReportMeta): string[] {
  const lines = [
    `- Optimizer: ${meta.optimizer}`,
    `- Graders: ${meta.graders.join(", ") || "(none)"}`,
    `- Champion: iteration ${result.championIter}`,
  ];
  if (meta.trainObjective !== undefined) lines.push(`- Train objective: ${meta.trainObjective.toFixed(3)}`);
  if (meta.validationObjective !== undefined) lines.push(`- Validation objective: ${meta.validationObjective.toFixed(3)}`);
  if (meta.validationConfiguredButUnused) lines.push(`- Validation: provided, but **${meta.optimizer}** selects the champion on the training objective (validation not used for selection).`);
  lines.push(`- Decisions — accepted: ${result.acceptedCount}, rejected: ${result.rejectedCount}, invalid: ${result.validationFailedCount}`);
  return lines;
}

/** The "## Champion grades" table, or "" when there is no breakdown. Returned
 *  with a leading blank line so it slots after the iterations table. */
function championSection(breakdown?: InputBreakdown[]): string {
  if (!breakdown || breakdown.length === 0) return "";
  const rows = breakdown.flatMap((b) =>
    b.grades.map((g) => `| ${cell(b.inputId)} | ${cell(g.grader)} | ${scoreText(g)} | ${cell(g.feedback ?? "")} | ${cell(asJudgeText(b.output)).slice(0, 80)} |`),
  );
  // Leading "" twice → a blank line before the heading (it follows the iterations table directly).
  return ["", "", "## Champion grades", "", "| input | grader | score | feedback | output |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function scoreText(g: GradeRow): string {
  return g.kind === "scalar" ? g.value.toFixed(3) : g.pass ? "pass" : "fail";
}

/** Write report.md and champion/grades.json into the run directory. */
export function writeReport(runDir: string, result: OptimizeResult, meta: ReportMeta): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "report.md"), renderReport(result, meta));
  if (result.championBreakdown) {
    const championDir = path.join(runDir, "champion");
    fs.mkdirSync(championDir, { recursive: true });
    fs.writeFileSync(path.join(championDir, "grades.json"), JSON.stringify(result.championBreakdown, null, 2));
  }
}
