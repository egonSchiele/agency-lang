import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function gen(src: string): string {
  const r = parseAgency(src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

describe("draftSchema threading (saveDraft tool, spec Part 2)", () => {
  it("threads the declared string return type when the call has options", () => {
    const out = gen(
      'def f(): string {\n  const r = llm("hi", tools: [print])\n  return r\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
  });

  it("omits draftSchema on a bare llm(prompt) call", () => {
    const out = gen(
      'def f(): string {\n  const r = llm("hi")\n  return r\n}\nnode main() { return f() }\n',
    );
    expect(out).not.toContain("draftSchema");
  });

  it("walks past a guard block to the enclosing def's declared type", () => {
    const out = gen(
      'def f(): string {\n  const r = guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n  if (isSuccess(r)) { return r.value }\n  return "x"\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
  });

  it("omits draftSchema when the enclosing def has no declared return type", () => {
    const out = gen(
      'def f() {\n  const r = llm("hi", tools: [print])\n  return r\n}\nnode main() { return f() }\n',
    );
    expect(out).not.toContain("draftSchema");
  });

  it("threads an object schema for a structured declared return type", () => {
    // An aliased type renders as its hoisted zod-schema const, not an
    // inline z.object literal — assert the reference AND the const.
    const out = gen(
      'type Report = { title: string }\ndef f(): Report {\n  const r: Report = llm("hi", tools: [print])\n  return r\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toContain("draftSchema: Report");
    expect(out).toMatch(/const Report = z\.object\(/);
  });

  it("threads an inline object schema for an anonymous structured return type", () => {
    const out = gen(
      'def f(): { title: string } {\n  const r = llm("hi", tools: [print])\n  return { title: "t" }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toMatch(/draftSchema: z\.object\(/);
  });
});
