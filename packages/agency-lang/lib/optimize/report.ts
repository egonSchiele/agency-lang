import * as fs from "fs";
import * as path from "path";

import type { InputBreakdown } from "./gradeBreakdown.js";
import type { OptimizeResult } from "./types.js";

export type ReportMeta = {
  optimizer: string;
  graders: string[];
  trainObjective?: number;        // populated in Phase 3
  validationObjective?: number;   // populated in Phase 3
  validationConfiguredButUnused?: boolean;   // Phase 3, gepa/example honesty note
};

/** Render a human-readable Markdown report for an optimize run. Pure. */
export function renderReport(result: OptimizeResult, meta: ReportMeta): string {
  return [
    metaBlock(result, meta),
    iterationTable(result),
    championGrades(result.championBreakdown),
  ].filter((s) => s.length > 0).join("\n\n") + "\n";
}

function metaBlock(result: OptimizeResult, meta: ReportMeta): string {
  const lines = [
    `# Optimize run ${result.runId}`,
    "",
    `- Optimizer: ${meta.optimizer}`,
    `- Graders: ${meta.graders.join(", ") || "(none)"}`,
    `- Champion: iteration ${result.championIter}`,
  ];
  if (meta.trainObjective !== undefined) lines.push(`- Train objective: ${meta.trainObjective.toFixed(3)}`);
  if (meta.validationObjective !== undefined) lines.push(`- Validation objective: ${meta.validationObjective.toFixed(3)}`);
  if (meta.validationConfiguredButUnused) lines.push(`- Validation: provided, but **${meta.optimizer}** selects the champion on the training objective (validation not used for selection).`);
  lines.push(`- Decisions — accepted: ${result.acceptedCount}, rejected: ${result.rejectedCount}, invalid: ${result.validationFailedCount}`);
  return lines.join("\n");
}

function iterationTable(result: OptimizeResult): string {
  const rows = result.iterations.map(
    (it) => `| ${it.iter} | ${it.decision} | ${(it.detail ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
  );
  return ["## Iterations", "", "| iter | decision | detail |", "| --- | --- | --- |", ...rows].join("\n");
}

function championGrades(breakdown?: InputBreakdown[]): string {
  if (!breakdown || breakdown.length === 0) return "";
  const rows = breakdown.flatMap((b) =>
    b.grades.map((g) => {
      const score = g.kind === "scalar" ? g.value.toFixed(3) : g.pass ? "pass" : "fail";
      const out = String(b.output).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 80);
      return `| ${b.inputId} | ${g.grader} | ${score} | ${(g.feedback ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${out} |`;
    }),
  );
  return ["## Champion grades", "", "| input | grader | score | feedback | output |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

/** Write report.md and champion/grades.json into the run directory. */
export function writeReport(runDir: string, result: OptimizeResult, meta: ReportMeta): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "report.md"), renderReport(result, meta));
  if (result.championBreakdown) {
    const championDir = path.join(runDir, "champion");
    fs.mkdirSync(championDir, { recursive: true });
    fs.writeFileSync(path.join(championDir, "grades.json"), globalThis.JSON.stringify(result.championBreakdown, null, 2));
  }
}
