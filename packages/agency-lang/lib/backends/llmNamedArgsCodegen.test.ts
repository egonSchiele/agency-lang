import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function gen(src: string): string {
  const r = parseAgency(src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

describe("llm named-arg option folding", () => {
  it("folds named options into the clientConfig object", () => {
    const out = gen(
      `node main() {\n const r = llm("hi", model: "gpt-4o-mini", maxTokens: 5)\n print(r)\n}`,
    );
    // Named args must fold into a clientConfig OBJECT.
    expect(out).toMatch(/clientConfig:\s*\{/);
    expect(out).toContain('"model":');
    expect(out).toContain('"maxTokens":');
    // Regression: the first named arg's value must not become the whole
    // clientConfig (the pre-fix miscompile produced `clientConfig: `gpt-4o-mini``).
    expect(out).not.toMatch(/clientConfig:\s*`gpt-4o-mini`/);
  });

  it("preserves the positional options-object form", () => {
    const out = gen(
      `node main() {\n const r = llm("hi", { model: "gpt-4o-mini" })\n print(r)\n}`,
    );
    expect(out).toMatch(/clientConfig:\s*\{/);
    expect(out).toContain('"model":');
  });
});
