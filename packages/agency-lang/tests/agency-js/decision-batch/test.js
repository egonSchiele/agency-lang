import { main, __setLLMClient } from "./agent.js";
import { writeFileSync } from "fs";

// Answers keyed by the question's instructions, so the fixture does not
// depend on the order in which arms reach the collector. These are bare
// annotations (Dept, boolean), so each call is one question named "answer"
// whose instructions are the raw prompt; the object-field prompt prefix from
// Task 2 does not apply here.
const byInstructions = {
  "Which department?": {
    type: "choice",
    choice: "billing",
    confidence: 0.9,
    probabilities: { billing: 0.9, support: 0.05, sales: 0.05 },
  },
  "Will the customer leave?": { type: "noul", noul: 0.8 },
  "Is it urgent?": { type: "noul", noul: 0.7 },
  "Escalate? Urgent was true": { type: "noul", noul: 0.2 },
};

const calls = [];
const client = {
  async text() {
    throw new Error("text() must not be called");
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
    const answers = {};
    for (const [name, question] of Object.entries(questions)) {
      const answer = byInstructions[question.instructions];
      if (answer === undefined) throw new Error(`no answer for question: ${question.instructions}`);
      answers[name] = answer;
    }
    return {
      success: true,
      value: {
        answers,
        usage: { inputTokens: 30, outputTokens: 0 },
        cost: { inputCost: 0.000003, outputCost: 0, totalCost: 0.000003, currency: "USD" },
        model: config.model,
      },
    };
  },
};

__setLLMClient(client);
const result = await main();

const round = (call) => ({
  // The merged names carry a per-call prefix; strip it so the fixture is
  // stable across submission order.
  questionNames: Object.keys(call.questions)
    .map((k) => k.replace(/^c\d+_/, ""))
    .sort(),
  instructions: Object.values(call.questions)
    .map((q) => q.instructions)
    .sort(),
  stateRoles: call.state.map((m) => m.role),
  stateEndsWithTicket: call.state[call.state.length - 1].content.startsWith("Ticket:"),
});

const out = {
  data: result.data,
  requests: calls.length,
  first: round(calls[0]),
  second: calls[1] ? round(calls[1]) : null,
};
writeFileSync("__result.json", JSON.stringify(out, null, 2));
