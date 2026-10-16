// How a decision-model call reads on every screen: a one-line summary of
// the answers for row labels, and the state, questions and answers for the
// previews. A decision model never saw a chat, so none of this goes
// through the message payloads.
import type { DecisionAnswer, DecisionQuestion } from "smoltalk";
import type { DecisionLog } from "../statelog/wireTypes.js";
import type { PayloadLine } from "./payload.js";
import { valuePayload } from "./payload.js";

/** How many of an answer's probabilities the output preview draws as bars. */
export const PROBABILITY_BARS = 5;
const BAR_WIDTH = 20;

/** `curious 86%`, or `department: billing 80% · churn: yes 97%` for several
 *  questions. The percentage is the chosen answer's probability. */
export function decisionSummary(decision: DecisionLog): string {
  const entries = Object.entries(decision.answers);
  const parts = entries.map(([name, answer]) =>
    entries.length === 1 ? answerSummary(answer) : `${name}: ${answerSummary(answer)}`,
  );
  return parts.join(" · ") || "no answer";
}

/** `decisionOf` checks a record's shape before it reaches here, but a log
 *  can come from a later smoltalk with an answer type this code does not
 *  know, so every read tolerates a missing field and an unknown type
 *  prints as its name. The viewer degrades; it never throws on a log. */
function answerSummary(answer: DecisionAnswer): string {
  switch (answer.type) {
    case "choice": {
      const probability = (answer.probabilities ?? {})[answer.choice] ?? answer.confidence ?? 0;
      return `${answer.choice} ${percent(probability)}`;
    }
    case "noul":
      return answer.noul >= 0.5 ? `yes ${percent(answer.noul)}` : `no ${percent(1 - answer.noul)}`;
    case "score":
      return `score ${(answer.score ?? 0).toFixed(1)} ${percent(answer.confidence ?? 0)}`;
    default:
      return String((answer as { type?: unknown }).type ?? "answer");
  }
}

/** The input preview: what the model read, then what it was asked. */
export function decisionInputPayload(decision: DecisionLog): PayloadLine[] {
  const questions = Object.entries(decision.questions);
  return [
    { kind: "heading", text: "STATE", tone: "user" },
    ...valuePayload(decision.state),
    { kind: "blank" },
    { kind: "heading", text: "QUESTIONS", tone: "chrome" },
    ...questions.flatMap(([name, question]) => [
      { kind: "meta" as const, text: `${name} · ${question.type}${choicesOf(question)}` },
      ...valuePayload(question.instructions),
    ]),
  ];
}

function choicesOf(question: DecisionQuestion): string {
  if (question.type === "choice") {
    return ` · ${Object.keys(question.criteria ?? {}).join(", ")}`;
  }
  if (question.type === "score") {
    return ` · ${(question.criteria ?? []).length} levels`;
  }
  return "";
}

/** The output preview: each answer with its confidence, and the highest
 *  probabilities as bars. */
export function decisionOutputPayload(decision: DecisionLog): PayloadLine[] {
  return Object.entries(decision.answers).flatMap(([name, answer]) => [
    { kind: "heading" as const, text: `ANSWER · ${name}`, tone: "assistant" as const },
    { kind: "meta" as const, text: answerSummary(answer) },
    ...probabilityBars(answer).map((text) => ({
      kind: "text" as const,
      text,
      indent: 1,
      role: "plain" as const,
    })),
  ]);
}

function probabilityBars(answer: DecisionAnswer): string[] {
  const probabilities: [string, number][] =
    answer.type === "noul"
      ? [
          ["yes", answer.noul],
          ["no", 1 - answer.noul],
        ]
      : Object.entries(answer.probabilities ?? {}).map(([key, value]) => [
          answer.type === "score" ? ((answer.legend ?? {})[key] ?? key) : key,
          value,
        ]);
  const width = Math.max(...probabilities.map(([label]) => label.length), 1);
  return probabilities
    .sort((first, second) => second[1] - first[1])
    .slice(0, PROBABILITY_BARS)
    .map(([label, value]) => {
      const filled = Math.round(Math.max(0, Math.min(1, value)) * BAR_WIDTH);
      return `${label.padEnd(width)} ${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)} ${percent(value)}`;
    });
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}
