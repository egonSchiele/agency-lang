import { describe, it, expect } from "vitest";
import { z } from "zod";
import * as smoltalk from "smoltalk";
import {
  planDecision,
  answersToValue,
  messagesToState,
  BARE_QUESTION_NAME,
  type DecisionPlan,
} from "./decisionQuestions.js";

const envelope = (inner: z.ZodType) => z.object({ response: inner });
const dept = z.union([z.literal("billing"), z.literal("support")]);

describe("planDecision", () => {
  it("turns a bare union of literals into one choice named answer with the prompt as instructions", () => {
    const r = planDecision(envelope(dept), "Which department?");
    if (!r.success) throw new Error(r.error);
    expect(r.value.questions).toEqual({
      [BARE_QUESTION_NAME]: {
        type: "choice",
        instructions: "Which department?",
        criteria: { billing: "billing", support: "support" },
      },
    });
    expect(r.value.shape).toEqual({ kind: "bare", answerType: "choice" });
  });

  it("turns a bare enum into a choice too", () => {
    const r = planDecision(envelope(z.enum(["a", "b"])), "?");
    if (!r.success) throw new Error(r.error);
    expect(r.value.questions[BARE_QUESTION_NAME]).toEqual({
      type: "choice",
      instructions: "?",
      criteria: { a: "a", b: "b" },
    });
  });

  it("turns a bare boolean into one noul", () => {
    const r = planDecision(envelope(z.boolean()), "Likely to cancel?");
    if (!r.success) throw new Error(r.error);
    expect(r.value.questions).toEqual({
      [BARE_QUESTION_NAME]: { type: "noul", instructions: "Likely to cancel?" },
    });
    expect(r.value.shape).toEqual({ kind: "bare", answerType: "noul" });
  });

  it("turns an object into one question per field, in field order, with descriptions as instructions", () => {
    const schema = envelope(
      z.object({
        department: dept.describe("Which team should handle this?"),
        churn: z.boolean(),
      }),
    );
    const r = planDecision(schema, "Triage this ticket");
    if (!r.success) throw new Error(r.error);
    expect(Object.keys(r.value.questions)).toEqual(["department", "churn"]);
    expect(r.value.questions.department).toEqual({
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: { billing: "billing", support: "support" },
    });
    // No description: the field name is the instruction. The prompt is never
    // the instruction for an object field; it is part of the state.
    expect(r.value.questions.churn).toEqual({ type: "noul", instructions: "churn" });
    expect(r.value.shape).toEqual({
      kind: "object",
      fields: { department: "choice", churn: "noul" },
    });
  });

  it("accepts a schema without the response envelope", () => {
    const r = planDecision(dept, "?");
    expect(r.success).toBe(true);
  });

  it("refuses a missing schema and asks for a type annotation", () => {
    const r = planDecision(undefined, "?");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/type annotation/);
  });

  const refused: Array<[string, z.ZodType, RegExp]> = [
    ["a bare number", z.number(), /a number/],
    ["a bare string", z.string(), /a string/],
    ["a number field", z.object({ n: z.number() }), /"n".*a number/],
    ["a nested object", z.object({ triage: z.object({ d: dept }) }), /"triage".*nested object/],
    ["an optional field", z.object({ d: dept.optional() }), /"d".*optional/],
    ["a nullable field", z.object({ d: dept.nullable() }), /"d".*nullable/],
    ["an array field", z.object({ d: z.array(dept) }), /"d".*an array/],
    [
      "a union with a non-literal member",
      z.object({ d: z.union([z.literal("a"), z.string()]) }),
      /"d".*union whose members are not all string literals/,
    ],
    [
      "a union with a number literal",
      z.object({ d: z.union([z.literal("a"), z.literal(1)]) }),
      /"d".*union whose members are not all string literals/,
    ],
    ["an object with no fields", z.object({}), /no fields/],
  ];
  for (const [name, schema, message] of refused) {
    it(`refuses ${name}`, () => {
      const r = planDecision(envelope(schema), "?");
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error).toMatch(message);
    });
  }
});

describe("answersToValue", () => {
  const bareChoice: DecisionPlan = { questions: {}, shape: { kind: "bare", answerType: "choice" } };
  const bareNoul: DecisionPlan = { questions: {}, shape: { kind: "bare", answerType: "noul" } };

  it("returns the chosen key for a bare choice", () => {
    const r = answersToValue(bareChoice, {
      answer: {
        type: "choice",
        choice: "billing",
        confidence: 0.9,
        probabilities: { billing: 0.9, support: 0.1 },
      },
    });
    expect(r).toEqual(smoltalk.success("billing"));
  });

  it("returns noul >= 0.5 for a bare boolean, with 0.5 itself true", () => {
    expect(answersToValue(bareNoul, { answer: { type: "noul", noul: 0.5 } })).toEqual(
      smoltalk.success(true),
    );
    expect(answersToValue(bareNoul, { answer: { type: "noul", noul: 0.49 } })).toEqual(
      smoltalk.success(false),
    );
  });

  it("builds an object with one value per field", () => {
    const plan: DecisionPlan = {
      questions: {},
      shape: { kind: "object", fields: { department: "choice", churn: "noul" } },
    };
    const r = answersToValue(plan, {
      department: {
        type: "choice",
        choice: "support",
        confidence: 0.6,
        probabilities: { billing: 0.4, support: 0.6 },
      },
      churn: { type: "noul", noul: 0.2 },
    });
    expect(r).toEqual(smoltalk.success({ department: "support", churn: false }));
  });

  it("fails when an answer is missing or of the wrong type", () => {
    const plan: DecisionPlan = {
      questions: {},
      shape: { kind: "object", fields: { churn: "noul" } },
    };
    const missing = answersToValue(plan, {});
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error).toMatch(/"churn"/);
    const wrong = answersToValue(plan, {
      churn: { type: "choice", choice: "x", confidence: 1, probabilities: { x: 1 } },
    });
    expect(wrong.success).toBe(false);
    if (!wrong.success) expect(wrong.error).toMatch(/"churn".*choice.*noul/);
  });
});

describe("messagesToState", () => {
  it("keeps role and text, joins text parts, and drops tool traffic", () => {
    const messages: smoltalk.Message[] = [
      smoltalk.systemMessage("You triage tickets."),
      smoltalk.userMessage([
        { type: "text", text: "Refund not received. " },
        { type: "text", text: "I am leaving." },
      ]),
      smoltalk.assistantMessage(null, {
        toolCalls: [{ id: "1", name: "lookup", arguments: {} }],
      }),
      smoltalk.toolMessage("found it", { tool_call_id: "1", name: "lookup" }),
      smoltalk.assistantMessage("Noted."),
      smoltalk.userMessage("Which department?"),
    ];
    expect(messagesToState(messages)).toEqual([
      { role: "system", content: "You triage tickets." },
      // smoltalk joins a user message's text parts with a newline.
      { role: "user", content: "Refund not received. \nI am leaving." },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Which department?" },
    ]);
  });
});
