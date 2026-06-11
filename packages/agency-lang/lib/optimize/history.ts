import type { OptimizeDecision } from "./types.js";

export type MutationHistoryEntry = {
  iter: number;
  decision: Exclude<OptimizeDecision, "baseline">;
  wins: number;
  losses: number;
  rationale: string;
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
    `- iter ${entry.iter} (${entry.decision}, ${entry.wins} wins / ${entry.losses} losses):`,
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
