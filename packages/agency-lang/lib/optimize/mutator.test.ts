import { describe, expect, it } from "vitest";

import { buildMutatorMessage, proposeMutation } from "./mutator.js";

describe("buildMutatorMessage", () => {
  it("includes goal, current prompt, and task instructions", () => {
    const message = buildMutatorMessage({
      goal: "be accurate",
      currentPrompt: "Classify ${text}",
      history: "",
    });

    expect(message).toContain("GOAL:\nbe accurate");
    expect(message).toContain("CURRENT PROMPT:\nClassify ${text}");
    expect(message).toContain("YOUR TASK:");
    expect(message).not.toContain("HISTORY:");
  });

  it("includes history and validation failure on retry", () => {
    const message = buildMutatorMessage({
      goal: "be accurate",
      currentPrompt: "Classify ${text}",
      history: "HISTORY (most recent first):\n- iter 1",
      validationFailure: "you removed ${text}",
    });

    expect(message).toContain("HISTORY (most recent first):");
    expect(message).toContain("Your previous attempt failed validation: you removed ${text}");
  });
});

describe("proposeMutation", () => {
  it("returns structured prompt and rationale from the injected caller", async () => {
    const proposal = await proposeMutation({
      config: {},
      goal: "be accurate",
      currentPrompt: "Classify ${text}",
      history: "",
      callModel: async () => ({ prompt: "Classify carefully ${text}", rationale: "Added care." }),
    });

    expect(proposal).toEqual({ prompt: "Classify carefully ${text}", rationale: "Added care." });
  });

  it("parses JSON string structured output from the model", async () => {
    const proposal = await proposeMutation({
      config: {},
      goal: "be accurate",
      currentPrompt: "Classify ${text}",
      history: "",
      callModel: async () => JSON.stringify({
        prompt: "Classify carefully ${text}",
        rationale: "Added care.",
      }),
    });

    expect(proposal).toEqual({ prompt: "Classify carefully ${text}", rationale: "Added care." });
  });

  it("throws a validation-friendly error for malformed structured output", async () => {
    await expect(proposeMutation({
      config: {},
      goal: "be accurate",
      currentPrompt: "Classify ${text}",
      history: "",
      callModel: async () => ({ prompt: "", rationale: "" }),
    })).rejects.toThrow(/missing prompt/i);
  });

  it("runs the bundled mutator agent independently of caller distDir", async () => {
    const previousMocks = process.env.AGENCY_LLM_MOCKS;
    process.env.AGENCY_LLM_MOCKS = JSON.stringify([{
      return: { prompt: "Classify carefully ${text}", rationale: "Added care." },
    }]);
    try {
      const proposal = await proposeMutation({
        config: { distDir: "/does/not/exist" },
        goal: "be accurate",
        currentPrompt: "Classify ${text}",
        history: "",
      });

      expect(proposal).toEqual({ prompt: "Classify carefully ${text}", rationale: "Added care." });
    } finally {
      if (previousMocks === undefined) {
        delete process.env.AGENCY_LLM_MOCKS;
      } else {
        process.env.AGENCY_LLM_MOCKS = previousMocks;
      }
    }
  });
});
