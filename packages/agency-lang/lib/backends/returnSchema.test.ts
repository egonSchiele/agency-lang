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
// later step the fields of its result. The compiler emits a thunk for it
// beside the parameter schema, from the declared return type.
describe("returnSchema on a registered function", () => {
  it("is a thunk for the declared return type's schema", () => {
    const out = gen(
      'export def f(): { title: string; count: number } {\n  return { title: "t", count: 1 }\n}\n',
    );
    expect(returnSchemaLine(out, "f")).toMatch(/^\(\) => z\.object\(\{/);
    expect(returnSchemaLine(out, "f")).toContain('"title": z.string()');
  });

  it("is the success type's schema for a Result, written directly or through an alias", () => {
    const direct = gen("export def f(): Result<number> {\n  return success(1)\n}\n");
    expect(returnSchemaLine(direct, "f")).toBe("() => z.number()");
    const aliased = gen(
      'type Note = { id: string }\ntype NoteResult = Result<Note>\nexport def f(): NoteResult {\n  return success({ id: "n" })\n}\n',
    );
    expect(returnSchemaLine(aliased, "f")).toBe("() => Note");
  });

  it("names an alias wherever it is declared, since the thunk runs after every const exists", () => {
    const before = gen(
      "type Note = { id: string }\nexport def f(): Result<Note[]> {\n  return success([])\n}\n",
    );
    expect(returnSchemaLine(before, "f")).toBe("() => z.array(Note)");
    const after = gen(
      "export def f(): Result<Note[]> {\n  return success([])\n}\ntype Note = { id: string }\n",
    );
    expect(returnSchemaLine(after, "f")).toBe("() => z.array(Note)");
  });

  it("inlines a value-parameterized alias", () => {
    const out = gen(
      "type Percent(low: number, high: number) = number\nexport def f(): Percent(0, 100) {\n  return 50\n}\n",
    );
    expect(returnSchemaLine(out, "f")).toMatch(/^\(\) => z\.number\(\)/);
  });

  it("is left out for a def that is not exported, no return type, a function-typed return, or a regex", () => {
    expect(returnSchemaLine(gen("def f(): number {\n  return 1\n}\n"), "f")).toBeNull();
    expect(returnSchemaLine(gen("export def f() {\n  return 1\n}\n"), "f")).toBeNull();
    const functionReturn = gen(
      "def same(x: number): number {\n  return x\n}\ntype Mapper = (number) => number\nexport def f(): Mapper {\n  return same\n}\n",
    );
    expect(returnSchemaLine(functionReturn, "f")).toBeNull();
    const regexReturn = gen("export def f(): { name: string; match: regex }[] {\n  return []\n}\n");
    expect(returnSchemaLine(regexReturn, "f")).toBeNull();
  });

  it("defers an alias declared after a parameter whose type holds it inside a Result", () => {
    const out = gen(
      "export def f(x: { r: Result<Note> }): number {\n  return 1\n}\ntype Note = { id: string }\n",
    );
    expect(out).toContain("z.lazy(() => Note)");
  });
  it("is left out for a function type nested in an object, which the zod mapper would print as a string", () => {
    const nestedFunction = gen(
      "def same(x: number): number {\n  return x\n}\nexport def f(): { cb: (number) => number; n: number } {\n  return { cb: same, n: 1 }\n}\n",
    );
    expect(returnSchemaLine(nestedFunction, "f")).toBeNull();
  });
});
