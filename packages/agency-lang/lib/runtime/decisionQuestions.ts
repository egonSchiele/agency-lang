/**
 * The pure half of a decision call: how a structured-output schema becomes
 * decision questions, and how the answers become the value the schema
 * describes. No I/O. See docs/dev/llm/decision-models.md.
 *
 * The rules:
 *   a union of string literals, or an enum, is a choice
 *   a boolean is a noul (a yes/no question answered with a probability)
 *   an object is one question per top-level field
 * Everything else is refused with a failure naming the field.
 */
import type { Message } from "smoltalk";
import { failure, success, type Result } from "smoltalk";
import type { DecisionAnswer, DecisionQuestion } from "./llmClient.js";

/** The question name used when the annotation is a single value. */
export const BARE_QUESTION_NAME = "answer";

export type AnswerType = "choice" | "noul";

export type DecisionPlan = {
  /** Question name to the question sent. */
  questions: Record<string, DecisionQuestion>;
  /** How the answers turn back into the value the schema describes. */
  shape:
    | { kind: "bare"; answerType: AnswerType }
    | { kind: "object"; fields: Record<string, AnswerType> };
};

/** The parts of a zod 4 schema definition this module reads. */
type ZodDef = {
  type: string;
  entries?: Record<string, unknown>;
  options?: unknown[];
  values?: unknown[];
  shape?: Record<string, unknown>;
};

function defOf(schema: unknown): ZodDef | undefined {
  const def = (schema as { def?: ZodDef } | undefined)?.def;
  return def && typeof def.type === "string" ? def : undefined;
}

function descriptionOf(schema: unknown): string | undefined {
  const d = (schema as { description?: unknown }).description;
  return typeof d === "string" && d.length > 0 ? d : undefined;
}

const NOT_ALL_LITERALS = "a union whose members are not all string literals";
const ONE_LITERAL = "a union with only one literal, and a choice needs at least two options";

/** The option keys when `schema` is a choice, else why it is not. */
function choiceKeys(schema: unknown, def: ZodDef): { keys: string[] } | { reason: string } {
  if (def.type === "enum" && def.entries) {
    const keys = Object.keys(def.entries);
    return keys.length < 2 ? { reason: ONE_LITERAL } : { keys };
  }
  if (def.type === "union" && def.options) {
    const keys: string[] = [];
    for (const option of def.options) {
      const od = defOf(option);
      // `T | null` compiles to a union with a null member, not to `.nullable()`.
      if (od?.type === "null") {
        return { reason: "nullable" };
      }
      const value = od?.type === "literal" && od.values?.length === 1 ? od.values[0] : undefined;
      if (typeof value !== "string") {
        return { reason: NOT_ALL_LITERALS };
      }
      keys.push(value);
    }
    if (keys.length < 2) {
      return { reason: ONE_LITERAL };
    }
    return { keys };
  }
  return { reason: describeShape(def.type) };
}

function describeShape(zodType: string): string {
  const names: Record<string, string> = {
    number: "a number",
    string: "a string",
    object: "a nested object",
    optional: "optional",
    nullable: "nullable",
    array: "an array",
    union: NOT_ALL_LITERALS,
  };
  return names[zodType] ?? `a ${zodType}`;
}

function questionFor(
  schema: unknown,
  instructions: string,
): { question: DecisionQuestion; answerType: AnswerType } | { reason: string } {
  const def = defOf(schema);
  if (def === undefined) return { reason: "not a schema" };
  if (def.type === "boolean") {
    return { question: { type: "noul", instructions }, answerType: "noul" };
  }
  const choice = choiceKeys(schema, def);
  if ("keys" in choice) {
    const criteria: Record<string, string> = {};
    for (const key of choice.keys) criteria[key] = key;
    return { question: { type: "choice", instructions, criteria }, answerType: "choice" };
  }
  return { reason: choice.reason };
}

/** Strip the `{ response: T }` envelope the codegen wraps every schema in. */
function unwrapEnvelope(schema: unknown): unknown {
  const def = defOf(schema);
  if (
    def?.type === "object" &&
    def.shape &&
    Object.keys(def.shape).length === 1 &&
    "response" in def.shape
  ) {
    return def.shape.response;
  }
  return schema;
}

const SHAPES_ACCEPTED = "a union of string literals, a boolean, or an object of those";

export function planDecision(responseFormat: unknown, prompt: string): Result<DecisionPlan> {
  if (defOf(responseFormat) === undefined) {
    return failure(
      `A decision model cannot produce text. Add a type annotation to the call: ${SHAPES_ACCEPTED}.`,
    );
  }
  const schema = unwrapEnvelope(responseFormat);
  const def = defOf(schema)!;

  if (def.type === "object" && def.shape) {
    const names = Object.keys(def.shape);
    if (names.length === 0) {
      return failure(
        "A decision model needs at least one question, but the object type has no fields.",
      );
    }
    const questions: Record<string, DecisionQuestion> = {};
    const fields: Record<string, AnswerType> = {};
    for (const name of names) {
      const field = def.shape[name];
      const q = questionFor(field, descriptionOf(field) ?? name);
      if ("reason" in q) {
        return failure(
          `A decision model cannot answer field "${name}": it is ${q.reason}. Use a union of string literals or a boolean.`,
        );
      }
      questions[name] = q.question;
      fields[name] = q.answerType;
    }
    return success({ questions, shape: { kind: "object", fields } });
  }

  const q = questionFor(schema, prompt);
  if ("reason" in q) {
    return failure(`A decision model cannot answer ${q.reason}. Use ${SHAPES_ACCEPTED}.`);
  }
  return success({
    questions: { [BARE_QUESTION_NAME]: q.question },
    shape: { kind: "bare", answerType: q.answerType },
  });
}

function valueFor(
  answer: DecisionAnswer | undefined,
  expected: AnswerType,
  name: string,
): Result<unknown> {
  if (answer === undefined) {
    return failure(`The decision model gave no answer for "${name}".`);
  }
  if (answer.type !== expected) {
    return failure(
      `The decision model answered "${name}" as a ${answer.type}, but a ${expected} was asked.`,
    );
  }
  if (answer.type === "noul") {
    // The one lossy step: a probability becomes a boolean at 0.5.
    return success(answer.noul >= 0.5);
  }
  return success(answer.choice);
}

export function answersToValue(
  plan: DecisionPlan,
  answers: Record<string, DecisionAnswer>,
): Result<unknown> {
  if (plan.shape.kind === "bare") {
    return valueFor(answers[BARE_QUESTION_NAME], plan.shape.answerType, BARE_QUESTION_NAME);
  }
  const value: Record<string, unknown> = {};
  for (const name of Object.keys(plan.shape.fields)) {
    const r = valueFor(answers[name], plan.shape.fields[name], name);
    if (!r.success) return r;
    value[name] = r.value;
  }
  return success(value);
}

/** The thread as a decision model's state: role and text only. Tool calls,
 *  tool results, and attachments are not part of what it reads. */
export function messagesToState(messages: Message[]): Array<{ role: string; content: string }> {
  const state: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    const content = m.content;
    if (typeof content !== "string" || content === "") continue;
    state.push({ role: m.role, content });
  }
  return state;
}
