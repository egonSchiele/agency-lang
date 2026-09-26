import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// A client with only a decide() method. It records every request so the
// test can check what the runtime sent: the state built from the thread,
// the questions built from the type annotation, and the config.
const calls = [];
const answers = [
  // Call 1: bare Dept annotation → one choice named "answer".
  {
    answer: {
      type: "choice",
      choice: "billing",
      confidence: 0.9,
      probabilities: { billing: 0.9, support: 0.05, sales: 0.05 },
    },
  },
  // Call 2: Triage object → one question per field.
  {
    department: {
      type: "choice",
      choice: "billing",
      confidence: 0.8,
      probabilities: { billing: 0.8, support: 0.1, sales: 0.1 },
    },
    churn: { type: "noul", noul: 0.97 },
  },
  // Call 3: inside the guard.
  {
    answer: {
      type: "choice",
      choice: "support",
      confidence: 0.6,
      probabilities: { billing: 0.3, support: 0.6, sales: 0.1 },
    },
  },
];

const client = {
  async text() {
    throw new Error("text() must not be called: every llm() here is a decision call");
  },
  async *textStream() {
    throw new Error("textStream() must not be called");
  },
  async embed() {
    return { success: false, error: "not implemented" };
  },
  async decide(state, questions, config, signal) {
    if (signal.aborted) throw signal.reason;
    calls.push({ state, questions, config });
    const value = {
      answers: answers[calls.length - 1],
      usage: { inputTokens: 10, outputTokens: 0 },
      cost: { inputCost: 0.000001, outputCost: 0, totalCost: 0.000001, currency: "USD" },
      model: config.model,
    };
    return { success: true, value };
  },
};

__setLLMClient(client);

const result = await main();
if (calls.length !== 3) throw new Error(`expected 3 decision calls, got ${calls.length}`);

const [first, second] = calls;

// Call 1: the prompt is the last user message in the state, and it is the
// bare question's instructions.
const firstLast = first.state[first.state.length - 1];
const out = {
  data: result.data,
  firstCall: {
    stateRoles: first.state.map((m) => m.role),
    lastStateIsPrompt: firstLast.role === "user" && firstLast.content.endsWith("Which department?"),
    questions: first.questions,
    config: { model: first.config.model, provider: first.config.provider },
  },
  secondCall: {
    // The first call's reply is on the thread, so the second call's state
    // carries it as an assistant message with the JSON value.
    assistantInState: second.state.some(
      (m) => m.role === "assistant" && m.content === JSON.stringify({ response: "billing" }),
    ),
    questions: second.questions,
    config: { model: second.config.model, provider: second.config.provider },
  },
};

writeFileSync("__result.json", JSON.stringify(out, null, 2));
