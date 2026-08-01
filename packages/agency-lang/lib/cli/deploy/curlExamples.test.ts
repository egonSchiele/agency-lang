import { describe, it, expect } from "vitest";
import { curlExamples } from "./curlExamples.js";

const BASE = "https://statelog.example/serve/u/proj/greeter";

describe("curlExamples", () => {
  it("emits a GET for the manifest, a templated POST per node, and a POST per function", () => {
    const examples = curlExamples(BASE, {
      nodes: [{ name: "main", parameters: ["message"] }],
      functions: [{ name: "add" }],
    });

    expect(examples.map((example) => example.label)).toEqual([
      "manifest",
      "node main",
      "function add",
    ]);
    expect(examples[0].command).toBe(`curl -s -H "Authorization: Bearer $KEY" "${BASE}/list"`);
    expect(examples[1].command).toContain(`-X POST "${BASE}/node/main"`);
    expect(examples[1].command).toContain(`-d '{"message":"…"}'`);
    expect(examples[2].command).toContain(`-X POST "${BASE}/function/add"`);
    expect(examples[2].command).toContain(`-d '{}'`);
  });

  it("uses an empty body for a node with no parameters", () => {
    const examples = curlExamples(BASE, {
      nodes: [{ name: "run", parameters: [] }],
      functions: [],
    });
    expect(examples[1].command).toContain(`-d '{}'`);
  });
});
