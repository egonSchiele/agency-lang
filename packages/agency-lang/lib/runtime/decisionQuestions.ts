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

/** A noul answer at or above this probability becomes `true`. */
const NOUL_TRUE_THRESHOLD = 0.5;

export type AnswerType = "choice" | "noul";

export type DecisionPlan = {
  /** Question name to the question sent. */
  questions: Record<string, DecisionQuestion>;
  /** How the answers turn back into the value the schema describes. */
  shape:
    | { kind: "bare"; answerType: AnswerType }
    | { kind: "object"; fields: Record<string, AnswerType> };
};

/** One question plus how its answer is read back. */
type PlannedQuestion = {
  question: DecisionQuestion;
  answerType: AnswerType;
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
  const description = (schema as { description?: unknown }).description;
  return typeof description === "string" && description.length > 0 ? description : undefined;
}

const NOT_ALL_LITERALS = "a union whose members are not all string literals";
const ONE_LITERAL = "a union with only one literal, and a choice needs at least two options";
const SHAPES_ACCEPTED = "a union of string literals, a boolean, or an object of those";

/** What a refused shape is called in the failure message. */
const SHAPE_NAMES: Record<string, string> = {
  number: "a number",
  string: "a string",
  object: "a nested object",
  optional: "optional",
  nullable: "nullable",
  array: "an array",
  union: NOT_ALL_LITERALS,
};

function describeShape(zodType: string): string {
  return SHAPE_NAMES[zodType] ?? `a ${zodType}`;
}

/** The string literal a union member holds, or undefined when it is not one. */
function literalOf(member: unknown): string | undefined {
  const def = defOf(member);
  const value = def?.type === "literal" && def.values?.length === 1 ? def.values[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** The option keys when `def` is a choice, else why it is not. */
function choiceKeys(def: ZodDef): Result<string[]> {
  let keys: string[];
  if (def.type === "enum" && def.entries) {
    keys = Object.keys(def.entries);
  } else if (def.type === "union" && def.options) {
    // `T | null` compiles to a union with a null member, not to `.nullable()`.
    if (def.options.some((member) => defOf(member)?.type === "null")) {
      return failure("nullable");
    }
    const literals = def.options.map(literalOf);
    if (literals.some((literal) => literal === undefined)) {
      return failure(NOT_ALL_LITERALS);
    }
    keys = literals as string[];
  } else {
    return failure(describeShape(def.type));
  }
  if (keys.length < 2) {
    return failure(ONE_LITERAL);
  }
  return success(keys);
}

function questionFor(schema: unknown, instructions: string): Result<PlannedQuestion> {
  const def = defOf(schema);
  if (def === undefined) {
    return failure("not a schema");
  }
  if (def.type === "boolean") {
    return success({ question: { type: "noul", instructions }, answerType: "noul" });
  }
  const keys = choiceKeys(def);
  if (!keys.success) {
    return keys;
  }
  // Each option is described by its own name until per-member descriptions exist.
  const criteria = Object.fromEntries(keys.value.map((key) => [key, key]));
  return success({ question: { type: "choice", instructions, criteria }, answerType: "choice" });
}

/** Strip the `{ response: T }` envelope the codegen wraps every schema in. */
function unwrapEnvelope(schema: unknown): unknown {
  const def = defOf(schema);
  const isEnvelope =
    def?.type === "object" &&
    def.shape !== undefined &&
    Object.keys(def.shape).length === 1 &&
    "response" in def.shape;
  return isEnvelope ? def.shape!.response : schema;
}

function planObject(shape: Record<string, unknown>): Result<DecisionPlan> {
  const names = Object.keys(shape);
  if (names.length === 0) {
    return failure(
      "A decision model needs at least one question, but the object type has no fields.",
    );
  }
  const questions: Record<string, DecisionQuestion> = {};
  const fields: Record<string, AnswerType> = {};
  for (const name of names) {
    const field = shape[name];
    const planned = questionFor(field, descriptionOf(field) ?? name);
    if (!planned.success) {
      return failure(
        `A decision model cannot answer field "${name}": it is ${planned.error}. Use a union of string literals or a boolean.`,
      );
    }
    questions[name] = planned.value.question;
    fields[name] = planned.value.answerType;
  }
  return success({ questions, shape: { kind: "object", fields } });
}

function planBare(schema: unknown, prompt: string): Result<DecisionPlan> {
  const planned = questionFor(schema, prompt);
  if (!planned.success) {
    return failure(`A decision model cannot answer ${planned.error}. Use ${SHAPES_ACCEPTED}.`);
  }
  return success({
    questions: { [BARE_QUESTION_NAME]: planned.value.question },
    shape: { kind: "bare", answerType: planned.value.answerType },
  });
}

export function planDecision(responseFormat: unknown, prompt: string): Result<DecisionPlan> {
  if (defOf(responseFormat) === undefined) {
    return failure(
      `A decision model cannot produce text. Add a type annotation to the call: ${SHAPES_ACCEPTED}.`,
    );
  }
  const schema = unwrapEnvelope(responseFormat);
  const def = defOf(schema)!;
  if (def.type === "object" && def.shape) {
    return planObject(def.shape);
  }
  return planBare(schema, prompt);
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
    // The one lossy step: a probability becomes a boolean.
    return success(answer.noul >= NOUL_TRUE_THRESHOLD);
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
    const field = valueFor(answers[name], plan.shape.fields[name], name);
    if (!field.success) {
      return field;
    }
    value[name] = field.value;
  }
  return success(value);
}

/** The thread as a decision model's state: role and text only. Tool calls,
 *  tool results, and attachments are not part of what it reads. */
export function messagesToState(messages: Message[]): Array<{ role: string; content: string }> {
  return messages
    .filter((message) => message.role !== "tool")
    .filter((message) => typeof message.content === "string" && message.content !== "")
    .map((message) => ({ role: message.role, content: message.content as string }));
}
