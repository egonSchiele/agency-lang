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

describe("draftSchema threading — guard annotations (#580)", () => {
  it("an annotated assignment beats the enclosing def's type", () => {
    const out = gen(
      'type Report = { title: string }\ndef f(): Report {\n  const notes: Result<string> = guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n  if (isSuccess(notes)) { return { title: notes.value } }\n  return { title: "x" }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
    // The fallback would render the def's Report as an object schema
    // (or its hoisted alias const).
    expect(out).not.toMatch(/draftSchema: z\.object\(/);
    expect(out).not.toContain("draftSchema: Report");
  });

  it("a return-position guard unwraps the declared Result return", () => {
    // Pre-change this call site threads the WHOLE Result-shaped zod;
    // z.string() can only appear if the unwrap works.
    const out = gen(
      'def f(): Result<string> {\n  return guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
  });

  it("nested: an unannotated inner guard defers to the outer stamp", () => {
    const out = gen(
      'type Report = { title: string }\ndef f(): Report {\n  const outer: Result<string> = guard(cost: $1) {\n    const inner = guard(cost: $0.1) {\n      return llm("hi", tools: [print])\n    }\n    if (isSuccess(inner)) { return inner.value }\n    return "x"\n  }\n  return { title: "x" }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
    expect(out).not.toMatch(/draftSchema: z\.object\(/);
  });

  it("a structured annotation threads an OBJECT draftSchema (the assertion no fixture can make)", () => {
    // The llm result binds through an annotated local so the checker
    // accepts the block yield (a bare `return llm()` infers string
    // and errors against Result<{title}> — see #582).
    const out = gen(
      'def f(): string {\n  const r: Result<{ title: string }> = guard(cost: $1) {\n    const report: { title: string } = llm("hi", tools: [print])\n    return report\n  }\n  return "y"\n}\nnode main() { return f() }\n',
    );
    expect(out).toMatch(/draftSchema: z\.object\(/);
  });

  it("an unannotated guard keeps the #578 fallbacks (byte-stability spot check)", () => {
    const out = gen(
      'def f(): string {\n  const r = guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n  if (isSuccess(r)) { return r.value }\n  return "x"\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
  });
});
