import { describe, it, expect } from "vitest";
import { curlExamples } from "./curlExamples.js";

const BASE = "https://statelog.example/serve/u/proj/greeter";

describe("curlExamples", () => {
  it("emits a GET for the manifest, a templated POST per node, and a templated POST per function", () => {
    const examples = curlExamples(BASE, {
      nodes: [{ name: "main", parameters: ["message"], interruptEffects: [] }],
      functions: [{ name: "add", parameters: ["a", "b"], interruptEffects: [] }],
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
    // Function bodies template from their parameters, just like nodes.
    expect(examples[2].command).toContain(`-d '{"a":"…","b":"…"}'`);
  });

  it("uses an empty body for a node or function with no parameters", () => {
    const examples = curlExamples(BASE, {
      nodes: [{ name: "run", parameters: [], interruptEffects: [] }],
      functions: [{ name: "ping", parameters: [], interruptEffects: [] }],
    });
    expect(examples[1].command).toContain(`-d '{}'`);
    expect(examples[2].command).toContain(`-d '{}'`);
  });
});
