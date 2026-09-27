import { z } from "zod";
import type { DecisionQuestion, DecisionState } from "smoltalk";

const instructions = z.string().min(1);
const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions,
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
  }),
  z.object({ type: z.literal("choice"), instructions, criteria: z.record(z.string(), z.string()) }),
  z.object({
    type: z.literal("score"),
    instructions,
    criteria: z.array(z.string()).min(2).max(10),
  }),
]);
const goldSchema = z.object({
  label: z.union([z.string(), z.boolean(), z.number()]).optional(),
  score: z.number().finite().optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
});
const rowSchema = z.object({
  id: z.string().min(1),
  workflow: z.string().optional(),
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  questions: z.record(z.string(), questionSchema),
  gold: z.record(z.string(), goldSchema),
});

export type Gold = { label: string; score?: number; probabilities?: Record<string, number> };
export type Case = {
  id: string;
  workflow?: string;
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  gold: Record<string, Gold>;
};

export function labelsFor(question: DecisionQuestion): string[] {
  if (question.type === "noul") {
    return ["false", "true"];
  }
  if (question.type === "score") {
    return question.criteria.map((_, index) => String(index));
  }
  return Object.keys(question.criteria);
}

export function checkDistribution(probabilities: Record<string, number>, labels: string[]): void {
  const keys = Object.keys(probabilities);
  const values = labels.map((label) => probabilities[label]);
  const sum = values.reduce((a, b) => a + b, 0);
  if (
    keys.length !== labels.length ||
    keys.some((key) => !labels.includes(key)) ||
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
    Math.abs(sum - 1) > 0.001
  ) {
    throw new Error("Probabilities must cover exactly the labels and sum to one.");
  }
}

export function highestLabel(probabilities: Record<string, number>, labels: string[]): string {
  return labels.reduce((best, label) =>
    probabilities[label] > probabilities[best] ? label : best,
  );
}

function normalizeRow(input: unknown): Case {
  const raw = z.record(z.string(), z.unknown()).parse(input);
  for (const field of ["questions", "gold"]) {
    if (typeof raw[field] === "string") {
      raw[field] = JSON.parse(raw[field]);
    }
  }
  if (typeof raw.state === "string" && /^[\[{]/.test(raw.state.trim())) {
    try {
      raw.state = JSON.parse(raw.state);
    } catch {
      // State also accepts ordinary text, including messages beginning with brackets.
    }
  }
  const row = rowSchema.parse(raw);
  const names = Object.keys(row.questions);
  if (names.length === 0) {
    throw new Error("A case needs at least one question.");
  }
  const entries = names.map((name): [string, Gold] => {
    const question = row.questions[name];
    const labels = labelsFor(question);
    if (labels.length < 2 || labels.length > 255) {
      throw new Error(`Question ${name} needs 2–255 options.`);
    }
    const gold = Object.hasOwn(row.gold, name) ? row.gold[name] : undefined;
    if (!gold) {
      throw new Error(`Missing gold for question ${name}.`);
    }
    if (gold.probabilities) {
      checkDistribution(gold.probabilities, labels);
    }
    if (
      question.type === "score" &&
      (gold.score === undefined || gold.score < 0 || gold.score > labels.length - 1)
    ) {
      throw new Error(`Gold score for ${name} must be in [0, ${labels.length - 1}].`);
    }
    let label = gold.label === undefined ? undefined : String(gold.label);
    if (label === undefined && gold.probabilities) {
      label = highestLabel(gold.probabilities, labels);
    }
    if (label === undefined || !labels.includes(label)) {
      throw new Error(`Gold label for ${name} must be one of ${labels.join(", ")}.`);
    }
    return [name, { ...gold, label }];
  });
  return { ...row, gold: Object.fromEntries(entries) };
}

export function parseCases(text: string): Case[] {
  const cases: Case[] = [];
  const tasks: Record<string, string> = Object.create(null);
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    try {
      const row = normalizeRow(JSON.parse(line));
      if (cases.some((other) => other.id === row.id)) {
        throw new Error(`Duplicate case ID: ${row.id}`);
      }
      for (const [name, question] of Object.entries(row.questions)) {
        const task = row.workflow ? `${row.workflow}/${name}` : name;
        const signature = JSON.stringify({ type: question.type, labels: labelsFor(question) });
        if (tasks[task] !== undefined && tasks[task] !== signature) {
          throw new Error(`Task ${task} has inconsistent types or label order.`);
        }
        tasks[task] = signature;
      }
      cases.push(row);
    } catch (error) {
      throw new Error(`Line ${index + 1}: ${error instanceof Error ? error.message : error}`);
    }
  });
  if (cases.length === 0) {
    throw new Error("Dataset is empty.");
  }
  return cases;
}

export function selectCases(cases: Case[], limit: number, seed: number): Case[] {
  const shuffled = [...cases];
  let state = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const pick = Math.floor((state / 4294967296) * (index + 1));
    [shuffled[index], shuffled[pick]] = [shuffled[pick], shuffled[index]];
  }
  return shuffled.slice(0, limit);
}
