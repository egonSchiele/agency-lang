import type { OptimizeDecision } from "./types.js";

export type MutationHistoryEntry = {
  iter: number;
  decision: Exclude<OptimizeDecision, "baseline">;
  /** Suite wins for the champion (side A). */
  winsA: number;
  /** Suite wins for the candidate (side B). */
  winsB: number;
  rationale: string;
  operations: { target: string; op: string }[];
  lossReasons: string[];
};

export function buildMutationHistory(entries: MutationHistoryEntry[]): string {
  if (entries.length === 0) return "";
  const recent = [...entries]
    .sort((left, right) => right.iter - left.iter)
    .slice(0, 5);
  return [
    "HISTORY (most recent first):",
    ...recent.map(renderEntry),
  ].join("\n");
}

function renderEntry(entry: MutationHistoryEntry): string {
  const lines = [
    `- iter ${entry.iter} (${entry.decision}, ${entry.winsB} wins / ${entry.winsA} losses):`,
    `    targets: ${entry.operations.map((operation) => operation.target).join(", ")}`,
    `    mutation: ${oneLine(entry.rationale)}`,
  ];
  if (entry.decision === "rejected" && entry.lossReasons.length > 0) {
    lines.push(`    judge reasons candidate lost: ${entry.lossReasons.slice(0, 3).map(quote).join(", ")}`);
  }
  return lines.join("\n");
}

function oneLine(text: string): string {
  const [firstSentence] = text.split(/(?<=\.)\s+/);
  return firstSentence.trim();
}

function quote(text: string): string {
  return `"${text.replaceAll("\"", "\\\"")}"`;
}
