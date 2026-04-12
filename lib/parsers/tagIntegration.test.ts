import { describe, expect, it } from "vitest";
import { parseAgency } from "@/parser.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { collectProgramInfo } from "@/programInfo.js";

describe("tag parsing", () => {
  it("parses @goal as a standalone node before a graph node", () => {
    const code = `
@goal("Classify messages")
node main(msg: string): string {
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const result = parseAgency(code);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const tagNode = result.result.nodes.find((n: any) => n.type === "tag");
    expect(tagNode).toBeDefined();
    expect(tagNode).toMatchObject({
      type: "tag",
      name: "goal",
      arguments: ["Classify messages"],
    });
  });

  it("parses @optimize inside a node body", () => {
    const code = `
node main(msg: string): string {
  @optimize
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const result = parseAgency(code);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const graphNode = result.result.nodes.find((n: any) => n.type === "graphNode") as any;
    const tagNode = graphNode.body.find((n: any) => n.type === "tag");
    expect(tagNode).toBeDefined();
    expect(tagNode.name).toBe("optimize");
  });
});

describe("tag preprocessing", () => {
  it("attaches @goal to the following graph node", () => {
    const code = `
@goal("Classify messages")
node main(msg: string): string {
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const parsed = parseAgency(code);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const info = collectProgramInfo(parsed.result);
    const preprocessor = new TypescriptPreprocessor(parsed.result, {}, info);
    const processed = preprocessor.preprocess();

    const tagNodes = processed.nodes.filter((n: any) => n.type === "tag");
    expect(tagNodes).toHaveLength(0);

    const graphNode = processed.nodes.find((n: any) => n.type === "graphNode") as any;
    expect(graphNode.tags).toHaveLength(1);
    expect(graphNode.tags[0]).toMatchObject({
      type: "tag",
      name: "goal",
      arguments: ["Classify messages"],
    });
  });

  it("attaches @optimize to the following assignment inside a body", () => {
    const code = `
node main(msg: string): string {
  @optimize
  const result: string = llm("classify: \${msg}")
  return result
}`;
    const parsed = parseAgency(code);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const info = collectProgramInfo(parsed.result);
    const preprocessor = new TypescriptPreprocessor(parsed.result, {}, info);
    const processed = preprocessor.preprocess();

    const graphNode = processed.nodes.find((n: any) => n.type === "graphNode") as any;
    const tagNodes = graphNode.body.filter((n: any) => n.type === "tag");
    expect(tagNodes).toHaveLength(0);

    const assignment = graphNode.body.find((n: any) => n.type === "assignment");
    expect(assignment.tags).toHaveLength(1);
    expect(assignment.tags[0].name).toBe("optimize");
  });
});
