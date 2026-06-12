import { describe, expect, it } from "vitest";

import type { EvalTask } from "@/eval/runTypes.js";

import type { OptimizeTarget } from "./targets.js";
import { buildMutatorMessage, buildMutatorSections, proposeMutation } from "./mutator.js";

const targets: OptimizeTarget[] = [
  {
    id: "foo.agency:global:systemPrompt",
    kind: "variable",
    file: "foo.agency",
    absoluteFile: "/abs/foo.agency",
    scope: "global",
    name: "systemPrompt",
    valueKind: "string",
    value: "be brief",
  },
  {
    id: "foo.agency:bar:prompt",
    kind: "variable",
    file: "foo.agency",
    absoluteFile: "/abs/foo.agency",
    scope: "bar",
    name: "prompt",
    valueKind: "string",
    value: "Classify ${text}",
  },
];

const tasks: EvalTask[] = [
  { task_id: "task-2", goal: "Mention the city", args: {} },
  { task_id: "task-1", goal: "Return Paris", args: {} },
];

const proposalJson = {
  operations: [
    {
      target: "foo.agency:bar:prompt",
      kind: "variable",
      op: "replaceInitializer",
      value: "\"Classify carefully ${text}\"",
      rationale: "Asks for care.",
    },
  ],
  rationale: "Updated the main prompt.",
};

describe("buildMutatorMessage", () => {
  it("lists targets sorted by id with kind and current value", () => {
    const message = buildMutatorMessage(buildMutatorSections({ targets, tasks, history: "" }));

    expect(message).toContain("OPTIMIZE TARGETS:");
    expect(message.indexOf("foo.agency:bar:prompt")).toBeLessThan(
      message.indexOf("foo.agency:global:systemPrompt"),
    );
    expect(message).toContain("kind: variable");
    expect(message).toContain("Classify ${text}");
    expect(message).toContain("be brief");
  });

  it("lists suite goals in task id order", () => {
    const message = buildMutatorMessage(buildMutatorSections({ targets, tasks, history: "" }));

    expect(message).toContain("GOALS:");
    expect(message.indexOf("[task-1] Return Paris")).toBeLessThan(
      message.indexOf("[task-2] Mention the city"),
    );
  });

  it("includes recent history when present", () => {
    const message = buildMutatorMessage(buildMutatorSections({
      targets,
      tasks,
      history: "HISTORY (most recent first):\n- iter 1",
    }));

    expect(message).toContain("HISTORY (most recent first):");
    expect(message).toContain("- iter 1");
  });

  it("includes validation diagnostics from a prior rejected preview", () => {
    const message = buildMutatorMessage(buildMutatorSections({
      targets,
      tasks,
      history: "",
      diagnostics: [
        { target: "foo.agency:bar:prompt", code: "interpolation-mismatch", message: "you removed an interpolation" },
      ],
    }));

    expect(message).toContain("failed validation");
    expect(message).toContain("[interpolation-mismatch] you removed an interpolation");
  });

  it("asks for declarative operation records", () => {
    const message = buildMutatorMessage(buildMutatorSections({ targets, tasks, history: "" }));

    expect(message).toContain("\"operations\"");
    expect(message).toContain("replaceInitializer");
  });
});

describe("proposeMutation", () => {
  it("returns operations and rationale from the injected caller", async () => {
    const proposal = await proposeMutation({
      config: {},
      targets,
      tasks,
      history: "",
      callModel: async () => proposalJson,
    });

    expect(proposal).toEqual(proposalJson);
  });

  it("parses JSON string structured output from the model", async () => {
    const proposal = await proposeMutation({
      config: {},
      targets,
      tasks,
      history: "",
      callModel: async () => JSON.stringify(proposalJson),
    });

    expect(proposal).toEqual(proposalJson);
  });

  it("throws a validation-friendly error for malformed structured output", async () => {
    await expect(proposeMutation({
      config: {},
      targets,
      tasks,
      history: "",
      callModel: async () => ({ prompt: "legacy shape", rationale: "nope" }),
    })).rejects.toThrow(/malformed/i);
  });

  it("runs the bundled mutator agent independently of caller distDir", async () => {
    const previousMocks = process.env.AGENCY_LLM_MOCKS;
    process.env.AGENCY_LLM_MOCKS = JSON.stringify([{ return: proposalJson }]);
    try {
      const proposal = await proposeMutation({
        config: { distDir: "/does/not/exist" },
        targets,
        tasks,
        history: "",
      });

      expect(proposal).toEqual(proposalJson);
    } finally {
      if (previousMocks === undefined) {
        delete process.env.AGENCY_LLM_MOCKS;
      } else {
        process.env.AGENCY_LLM_MOCKS = previousMocks;
      }
    }
  });
});
