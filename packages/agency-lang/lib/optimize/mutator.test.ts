import { describe, expect, it } from "vitest";

import type { Input } from "@/eval/runTypes.js";

import type { OptimizeTarget } from "./targets.js";
import { buildMutatorSections, proposeMutation } from "./mutator.js";

const targets: OptimizeTarget[] = [
  {
    id: "foo.agency:global:systemPrompt",
    kind: "variable",
    file: "foo.agency",
    absoluteFile: "/abs/foo.agency",
    scope: "global",
    name: "systemPrompt",
    valueKind: "string",
    declaredType: null,
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
    declaredType: null,
    value: "Classify ${text}",
  },
];

const inputs: Input[] = [
  { id: "task-2", goal: "Mention the city", args: {} },
  { id: "task-1", goal: "Return Paris", args: {} },
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

describe("buildMutatorSections", () => {
  it("lists targets sorted by id with kind and current value", () => {
    const sections = buildMutatorSections({ targets, inputs, history: "" });

    expect(sections.targets.indexOf("foo.agency:bar:prompt")).toBeLessThan(
      sections.targets.indexOf("foo.agency:global:systemPrompt"),
    );
    expect(sections.targets).toContain("kind: variable");
    expect(sections.targets).toContain("Classify ${text}");
    expect(sections.targets).toContain("be brief");
  });

  it("lists suite goals in task id order", () => {
    const sections = buildMutatorSections({ targets, inputs, history: "" });

    expect(sections.goals.indexOf("[task-1] Return Paris")).toBeLessThan(
      sections.goals.indexOf("[task-2] Mention the city"),
    );
  });

  it("includes a feedback section when feedback is provided", () => {
    const sections = buildMutatorSections({
      targets,
      inputs,
      history: "",
      feedback: "### Input india\nExpected: New Delhi",
    });
    expect(sections.feedback).toContain("Expected: New Delhi");
  });

  it("defaults the feedback section to empty when omitted", () => {
    const sections = buildMutatorSections({ targets, inputs, history: "" });
    expect(sections.feedback).toBe("");
  });

  it("passes history through verbatim", () => {
    const sections = buildMutatorSections({
      targets,
      inputs,
      history: "HISTORY (most recent first):\n- iter 1",
    });

    expect(sections.history).toBe("HISTORY (most recent first):\n- iter 1");
  });

  it("renders validation diagnostics from a prior rejected preview", () => {
    const sections = buildMutatorSections({
      targets,
      inputs,
      history: "",
      diagnostics: [
        { target: "foo.agency:bar:prompt", code: "interpolation-mismatch", message: "you removed an interpolation" },
      ],
    });

    expect(sections.diagnostics).toContain("failed validation");
    expect(sections.diagnostics).toContain("[interpolation-mismatch] you removed an interpolation");
  });

  it("renders no diagnostics section when there are none", () => {
    const sections = buildMutatorSections({ targets, inputs, history: "" });

    expect(sections.diagnostics).toBe("");
  });
});

describe("proposeMutation", () => {
  it("returns operations and rationale from the injected caller", async () => {
    const proposal = await proposeMutation({
      config: {},
      targets,
      inputs,
      history: "",
      callModel: async () => proposalJson,
    });

    expect(proposal).toEqual(proposalJson);
  });

  it("parses JSON string structured output from the model", async () => {
    const proposal = await proposeMutation({
      config: {},
      targets,
      inputs,
      history: "",
      callModel: async () => JSON.stringify(proposalJson),
    });

    expect(proposal).toEqual(proposalJson);
  });

  it("throws a validation-friendly error for malformed structured output", async () => {
    await expect(proposeMutation({
      config: {},
      targets,
      inputs,
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
        inputs,
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

describe("renderTargetsSection type descriptions", () => {
  it("describes a union target's allowed values and a boolean target", () => {
    const typed: OptimizeTarget[] = [
      {
        id: "a.agency:global:status",
        kind: "variable",
        file: "a.agency",
        absoluteFile: "/abs/a.agency",
        scope: "global",
        name: "status",
        valueKind: "string",
        value: "pass",
        declaredType: `"pass" | "fail"`,
      },
      {
        id: "a.agency:global:enabled",
        kind: "variable",
        file: "a.agency",
        absoluteFile: "/abs/a.agency",
        scope: "global",
        name: "enabled",
        valueKind: "literal",
        value: "false",
        declaredType: "boolean",
      },
    ];

    const sections = buildMutatorSections({ targets: typed, inputs: [], history: "" });

    expect(sections.targets).toContain(`type: "pass" | "fail"`);
    expect(sections.targets).toContain("type: boolean");
  });

  it("labels freeform and unconstrained targets", () => {
    const sections = buildMutatorSections({ targets, inputs: [], history: "" });
    expect(sections.targets.toLowerCase()).toContain("free text");
  });
});
