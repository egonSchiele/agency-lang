import { describe, expect, it } from "vitest";
import { parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo } from "@/programInfo.js";
import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import {
  parsePromptToSegments,
  findGoalTag,
  findOptimizeTargets,
  updatePrompt,
  writeBack,
} from "./optimize.js";

function preprocess(code: string) {
  const parsed = parseAgency(code);
  if (!parsed.success) throw new Error(`Parse failed: ${parsed.message}`);
  const info = collectProgramInfo(parsed.result);
  const preprocessor = new TypescriptPreprocessor(parsed.result, {}, info);
  return preprocessor.preprocess();
}

describe("parsePromptToSegments", () => {
  it("handles plain text with no interpolations", () => {
    const segments = parsePromptToSegments("hello world");
    expect(segments).toEqual([{ type: "text", value: "hello world" }]);
  });

  it("handles a single interpolation", () => {
    const segments = parsePromptToSegments("classify: ${msg}");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: "text", value: "classify: " });
    expect(segments[1]).toMatchObject({
      type: "interpolation",
      expression: { type: "variableName", value: "msg" },
    });
  });

  it("handles multiple interpolations", () => {
    const segments = parsePromptToSegments("${a} and ${b}");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      type: "interpolation",
      expression: { type: "variableName", value: "a" },
    });
    expect(segments[1]).toEqual({ type: "text", value: " and " });
    expect(segments[2]).toMatchObject({
      type: "interpolation",
      expression: { type: "variableName", value: "b" },
    });
  });

  it("handles interpolation at the start", () => {
    const segments = parsePromptToSegments("${x} is the answer");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      type: "interpolation",
      expression: { type: "variableName", value: "x" },
    });
    expect(segments[1]).toEqual({ type: "text", value: " is the answer" });
  });

  it("handles interpolation at the end", () => {
    const segments = parsePromptToSegments("the answer is ${x}");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: "text", value: "the answer is " });
    expect(segments[1]).toMatchObject({
      type: "interpolation",
      expression: { type: "variableName", value: "x" },
    });
  });
});

describe("findGoalTag", () => {
  it("finds @goal tag on a node after preprocessing", () => {
    const code = `
@goal("Classify messages accurately")
node main(msg: string): string {
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const tag = findGoalTag(program, "main");
    expect(tag).not.toBeNull();
    expect(tag).toMatchObject({
      type: "tag",
      name: "goal",
      arguments: ["Classify messages accurately"],
    });
  });

  it("returns null when no @goal tag exists on the node", () => {
    const code = `
node main(msg: string): string {
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const tag = findGoalTag(program, "main");
    expect(tag).toBeNull();
  });
});

describe("findOptimizeTargets", () => {
  it("finds @optimize on an assignment with llm()", () => {
    const code = `
node main(msg: string): string {
  @optimize
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");
    expect(targets).toHaveLength(1);
    expect(targets[0].llmCall).not.toBeNull();
    expect(targets[0].llmCall?.type).toBe("functionCall");
    expect((targets[0].llmCall as any).functionName).toBe("llm");
  });

  it("respects @optimize(temperature) scoping — sets configKeys from tag arguments", () => {
    const code = `
node main(msg: string): string {
  @optimize(temperature)
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");
    expect(targets).toHaveLength(1);
    expect(targets[0].configKeys).toEqual(["temperature"]);
  });

  it("defaults configKeys to [\"prompt\"] when @optimize has no arguments", () => {
    const code = `
node main(msg: string): string {
  @optimize
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");
    expect(targets).toHaveLength(1);
    expect(targets[0].configKeys).toEqual(["prompt"]);
  });

  it("stores a direct llmCall reference on the target", () => {
    const code = `
node main(msg: string): string {
  @optimize
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");
    expect(targets).toHaveLength(1);
    const llmCall = targets[0].llmCall as any;
    expect(llmCall).not.toBeNull();
    expect(llmCall.type).toBe("functionCall");
    expect(llmCall.functionName).toBe("llm");
  });
});

describe("promptValue extraction (regression: [object Object] bug)", () => {
  it("extracts promptValue correctly with simple variable interpolation", () => {
    const code = `
node main(msg: string): string {
  @optimize
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");
    expect(targets[0].promptValue).toBe("classify: ${msg}");
  });

  it("extracts promptValue correctly with value access interpolation", () => {
    const code = `
node main(response: {message: string}): string {
  @optimize
  const result: string = llm("Categorize this: \${response.message}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");
    expect(targets[0].promptValue).toBe("Categorize this: ${response.message}");
  });

  it("extracts promptValue correctly with multiple interpolations", () => {
    const code = `
node main(user: string, topic: string): string {
  @optimize
  const result: string = llm("Hello \${user}, tell me about \${topic}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");
    expect(targets[0].promptValue).toBe("Hello ${user}, tell me about ${topic}");
  });
});

describe("updatePrompt + formatter round-trip (regression: crash on writeBack)", () => {
  it("updatePrompt creates segments the formatter can handle", () => {
    const code = `
node main(msg: string): string {
  @optimize
  const result: string = llm("old prompt: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");

    // Mutate the AST
    updatePrompt(targets[0], "new prompt: ${msg}");

    // Format it — should not crash
    const generator = new AgencyGenerator();
    const output = generator.generate(program);
    expect(output.output).toContain("new prompt: ${msg}");
    expect(output.output).not.toContain("old prompt");
  });

  it("updatePrompt preserves multiple interpolations through format", () => {
    const code = `
node main(a: string, b: string): string {
  @optimize
  const result: string = llm("\${a} and \${b}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");

    updatePrompt(targets[0], "${a} or ${b} or ${a}");

    const generator = new AgencyGenerator();
    const output = generator.generate(program);
    expect(output.output).toContain("${a} or ${b} or ${a}");
  });

  it("updatePrompt result parses back correctly", () => {
    const code = `
@goal("Classify messages")
node main(msg: string): string {
  @optimize
  const result: string = llm("old: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");

    updatePrompt(targets[0], "new and improved: ${msg}");

    // Format the modified AST
    const generator = new AgencyGenerator();
    const output = generator.generate(program);

    // Re-parse the formatted output
    const reparsed = parseAgency(output.output);
    expect(reparsed.success).toBe(true);
    if (!reparsed.success) return;

    // Re-preprocess and verify the prompt changed
    const info2 = collectProgramInfo(reparsed.result);
    const preprocessor2 = new TypescriptPreprocessor(reparsed.result, {}, info2);
    const program2 = preprocessor2.preprocess();
    const targets2 = findOptimizeTargets(program2, "main");

    expect(targets2[0].promptValue).toBe("new and improved: ${msg}");
  });
});
