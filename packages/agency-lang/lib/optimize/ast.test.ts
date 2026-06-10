import { describe, expect, it } from "vitest";
import { parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import {
  parsePromptToSegments,
  findOptimizeTargets,
  updatePrompt,
} from "./ast.js";

function preprocess(code: string) {
  const parsed = parseAgency(code);
  if (!parsed.success) throw new Error(`Parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result);
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

  it("handles value access expressions like ${response.message}", () => {
    const segments = parsePromptToSegments("Categorize: ${response.message}");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ type: "text", value: "Categorize: " });
    expect(segments[1].type).toBe("interpolation");
    if (segments[1].type === "interpolation") {
      expect(segments[1].expression.type).toBe("valueAccess");
    }
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

  it("records non-prompt optimize arguments for later validation", () => {
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

  it("extracts promptValue correctly with multiple interpolations", () => {
    const code = `
node main(user: string, topic: string): string {
  @optimize(prompt)
  const result: string = llm("Hello \${user}, tell me about \${topic}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");
    expect(targets[0].promptValue).toBe("Hello ${user}, tell me about ${topic}");
  });
});

describe("updatePrompt + formatter round-trip", () => {
  it("updatePrompt creates segments the formatter can handle", () => {
    const code = `
node main(msg: string): string {
  @optimize
  const result: string = llm("old prompt: \${msg}")
  return result
}`;
    const program = preprocess(code);
    const targets = findOptimizeTargets(program, "main");

    updatePrompt(targets[0], "new prompt: ${msg}");

    const generator = new AgencyGenerator();
    const output = generator.generate(program);
    expect(output.output).toContain("new prompt: ${msg}");
    expect(output.output).not.toContain("old prompt");
  });
});
