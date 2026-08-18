import { describe, it, expect } from "vitest";
import { parseAgency } from "../../parser.js";
import { generateTypeScript } from "../typescriptGenerator.js";

// Compile a node whose parameters are literally named `config` and `traceId`,
// proving the hidden invocation options never collide with user parameters.
function compile(source: string): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) {
    throw new Error(`parse failed: ${parseResult.message}`);
  }
  return generateTypeScript(parseResult.result, {}, undefined, "test-module.agency");
}

describe("node wrapper per-invocation options", () => {
  const ts = compile(`node main(config: string, traceId: string) {
  return config + traceId
}`);

  it("destructures the options into hidden aliases", () => {
    expect(ts).toContain(
      "{ messages: __invocationMessages, callbacks: __invocationCallbacks, config: __invocationConfig, traceId: __invocationTraceId, invocationInput: __invocationInput }",
    );
  });

  it("types the options object with InvocationOptions", () => {
    expect(ts).toContain("& InvocationOptions");
  });

  it("forwards the aliases as the runNode invocation", () => {
    expect(ts).toContain("config: __invocationConfig");
    expect(ts).toContain("traceId: __invocationTraceId");
    expect(ts).toContain("input: __invocationInput");
  });

  it("does not name the carrier `input`, which nodes commonly use as a parameter", () => {
    const withInput = compile(`node main(input: string) {
  return input
}`);
    expect(withInput).toContain("main(input: string, {");
    expect(withInput).not.toMatch(/traceId: __invocationTraceId, input: __invocationInput/);
  });
});
