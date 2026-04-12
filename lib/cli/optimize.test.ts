import { describe, expect, it } from "vitest";
import { parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo } from "@/programInfo.js";
import {
  parsePromptToSegments,
  findGoalTag,
  findOptimizeTargets,
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
