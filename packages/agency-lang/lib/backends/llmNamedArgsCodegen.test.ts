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

  it("spreads a positional options object first, with named args winning", () => {
    const out = gen(
      `node main() {\n const o = { model: "a" }\n const r = llm("hi", o, temperature: 0.5)\n print(r)\n}`,
    );
    expect(out).toMatch(/clientConfig:\s*\{/);
    expect(out).toContain("...__stack.locals.o");
    expect(out).toContain('"temperature":');
    // Spread must come before the named key so named args override.
    expect(out.indexOf("...__stack.locals.o")).toBeLessThan(
      out.indexOf('"temperature":'),
    );
  });

  it("spreads a splat option argument without double-spreading", () => {
    const out = gen(
      `node main() {\n const o = { model: "a" }\n const r = llm("hi", ...o, temperature: 0.5)\n print(r)\n}`,
    );
    expect(out).toContain("...__stack.locals.o");
    // The pre-fix bug wrapped an already-spread node, emitting invalid `......`.
    expect(out).not.toContain("......");
  });
});
