import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function gen(src: string): string {
  const r = parseAgency(src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

/** The `returnSchema:` line of `name`'s registration, or null when it has none. */
function returnSchemaLine(out: string, name: string): string | null {
  const start = out.indexOf(`name: "${name}"`);
  if (start < 0) throw new Error(`${name} not registered`);
  const registration = out.slice(start, out.indexOf("__toolRegistry", start));
  const match = registration.match(/returnSchema: (.*)/);
  return match === null ? null : match[1].trim().replace(/,$/, "");
}

// A workflow editor reads a tool's return schema from the catalog to offer a
// later step the fields of its result. The compiler emits it beside the
// parameter schema, from the declared return type.
describe("returnSchema on a registered function", () => {
  it("is the declared return type's schema", () => {
    const out = gen(
      'def f(): { title: string; count: number } {\n  return { title: "t", count: 1 }\n}\n',
    );
    expect(returnSchemaLine(out, "f")).toMatch(/^z\.object\(\{/);
    expect(returnSchemaLine(out, "f")).toContain('"title": z.string()');
  });

  it("is the success type's schema for a Result", () => {
    const out = gen("def f(): Result<number> {\n  return success(1)\n}\n");
    expect(returnSchemaLine(out, "f")).toBe("z.number()");
  });

  it("names an alias declared before the def and defers one declared after it", () => {
    const before = gen(
      "type Note = { id: string }\ndef f(): Result<Note[]> {\n  return success([])\n}\n",
    );
    expect(returnSchemaLine(before, "f")).toBe("z.array(Note)");
    const after = gen(
      "def f(): Result<Note[]> {\n  return success([])\n}\ntype Note = { id: string }\n",
    );
    expect(returnSchemaLine(after, "f")).toContain("z.lazy(() => Note)");
  });

  it("is left out for no return type and for a function-typed return", () => {
    expect(returnSchemaLine(gen("def f() {\n  return 1\n}\n"), "f")).toBeNull();
    const functionReturn = gen(
      "def same(x: number): number {\n  return x\n}\ndef f(): (number) => number {\n  return same\n}\n",
    );
    expect(returnSchemaLine(functionReturn, "f")).toBeNull();
  });
});
