import { describe, expect, it } from "vitest";
import type { DecisionLog } from "../statelog/wireTypes.js";
import {
  decisionInputPayload,
  decisionOutputPayload,
  decisionSummary,
  PROBABILITY_BARS,
} from "./decision.js";

const expression: DecisionLog = {
  state: [{ role: "user", content: "Are you able to set up a recurring job?" }],
  questions: {
    response: {
      type: "choice",
      instructions: "Which facial expression should BMO show?",
      criteria: { idle: "idle", curious: "curious", focused: "focused" },
    },
  },
  answers: {
    response: {
      type: "choice",
      choice: "curious",
      confidence: 0.73,
      probabilities: { curious: 0.86, focused: 0.1, idle: 0.04 },
    },
  },
};

const triage: DecisionLog = {
  state: "ticket text",
  questions: {
    department: {
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: "b", support: "s" },
    },
    churn: { type: "noul", instructions: "Does the customer threaten to leave?" },
  },
  answers: {
    department: {
      type: "choice",
      choice: "billing",
      confidence: 0.8,
      probabilities: { billing: 0.8, support: 0.2 },
    },
    churn: { type: "noul", noul: 0.97 },
  },
};

describe("decisionSummary", () => {
  it("names the chosen answer with its probability", () => {
    expect(decisionSummary(expression)).toBe("curious 86%");
  });

  it("names each question when there are several, reading a noul as yes or no", () => {
    expect(decisionSummary(triage)).toBe("department: billing 80% · churn: yes 97%");
    expect(decisionSummary({ ...triage, answers: { churn: { type: "noul", noul: 0.2 } } })).toBe(
      "no 80%",
    );
  });
});

describe("decisionInputPayload", () => {
  it("shows the state, then each question with its type, choices and instructions", () => {
    const text = decisionInputPayload(expression).map((line) => ("text" in line ? line.text : ""));
    expect(text).toContain("STATE");
    expect(text.join("\n")).toContain("Are you able to set up a recurring job?");
    expect(text).toContain("QUESTIONS");
    expect(text).toContain("response · choice · idle, curious, focused");
    expect(text).toContain("Which facial expression should BMO show?");
  });
});

describe("decisionOutputPayload", () => {
  it("shows each answer with bars for its highest probabilities, most likely first", () => {
    const text = decisionOutputPayload(expression).map((line) => ("text" in line ? line.text : ""));
    expect(text[0]).toBe("ANSWER · response");
    expect(text[1]).toBe("curious 86%");
    expect(text[2]).toMatch(/^curious █+░* 86%$/);
    expect(text[3]).toMatch(/^focused █+░+ 10%$/);
  });

  it("caps the bars at the named count", () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`c${n}`, (n + 1) / 45]));
    const log: DecisionLog = {
      ...expression,
      answers: {
        response: { type: "choice", choice: "c8", confidence: 0.2, probabilities: many },
      },
    };
    const bars = decisionOutputPayload(log).filter((line) => line.kind === "text");
    expect(bars).toHaveLength(PROBABILITY_BARS);
  });

  it("draws yes and no for a noul answer", () => {
    const text = decisionOutputPayload(triage).map((line) => ("text" in line ? line.text : ""));
    expect(text).toContain("ANSWER · churn");
    expect(text.some((line) => /^yes █+/.test(line))).toBe(true);
  });
});
