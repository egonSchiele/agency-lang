/**
 * Spec 2026-06-03 Part 5.3: schema generator (paramSchemaContribution).
 *
 * Snapshot-style tests are paired with explicit field-level assertions so a
 * regression that silently drops a schema field or emits the wrong zod
 * expression fails on the assertion — not just the snapshot. The spec's
 * coverage matrix requires every drop / scalar / array case be exercised.
 */
import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

/**
 * Compile a small Agency program and return the slice of generated TS
 * that defines `tool`'s schema object. We extract the substring between
 * `schema: z.object({` and the closing `})` so individual key-value
 * assertions are stable across formatting changes.
 */
function toolSchemaSlice(source: string, toolName: string): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) {
    throw new Error(`parse failed: ${parseResult.message}`);
  }
  const ts = generateTypeScript(
    parseResult.result,
    undefined,
    undefined,
    "test.agency",
  );
  // Look for the toolDefinition with this function's name.
  const idx = ts.indexOf(`name: "${toolName}"`);
  if (idx < 0) {
    throw new Error(`tool ${toolName} not found in generated TS`);
  }
  const slice = ts.slice(idx);
  // Capture the `schema: z.object({ ... })` segment for this tool.
  const m = slice.match(/schema:\s*z\.object\(\s*\{([^}]*)\}/);
  if (!m) {
    throw new Error("schema object not found");
  }
  return m[1];
}

describe("paramSchemaContribution — schema field generation", () => {
  // #27 — Variadic emits array field.
  it("emits z.array(<element>) for a variadic param", () => {
    const slice = toolSchemaSlice(
      `def foo(...nums: number[]): number { return 0 }`,
      "foo",
    );
    expect(slice).toContain(`"nums"`);
    expect(slice).toContain("z.array(z.number())");
  });

  // #28 — Function-typed param dropped (single).
  it("drops a function-typed param from the schema", () => {
    const slice = toolSchemaSlice(
      `def foo(a: number, block: () => void): void {}`,
      "foo",
    );
    expect(slice).toContain(`"a"`);
    expect(slice).not.toContain(`"block"`);
  });

  // #29 — Function union dropped.
  it("drops a union-with-function param from the schema", () => {
    const slice = toolSchemaSlice(
      `def foo(a: number, cb: ((number) => number) | string): void {}`,
      "foo",
    );
    expect(slice).toContain(`"a"`);
    expect(slice).not.toContain(`"cb"`);
  });

  // #30 — Variadic-of-function dropped.
  it("drops a variadic-of-function param from the schema", () => {
    const slice = toolSchemaSlice(
      `def foo(a: number, ...handlers: ((number) => number)[]): void {}`,
      "foo",
    );
    expect(slice).toContain(`"a"`);
    expect(slice).not.toContain(`"handlers"`);
  });

  // #31 — Mixed signature ordering preserved (declaration order).
  it("preserves declaration order of remaining fields", () => {
    const slice = toolSchemaSlice(
      `def foo(a: number, block: () => void, b: string, ...rest: number[]): void {}`,
      "foo",
    );
    // No "block" field — dropped. Order should be a, b, rest.
    expect(slice).not.toContain(`"block"`);
    const idxA = slice.indexOf(`"a"`);
    const idxB = slice.indexOf(`"b"`);
    const idxRest = slice.indexOf(`"rest"`);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxRest).toBeGreaterThan(idxB);
  });

  // #32 — No params → empty {} schema. Compile-only check: the function
  // compiles without throwing and emits `schema: z.object({})`.
  it("emits an empty z.object({}) for a zero-param tool", () => {
    const parseResult = parseAgency(`def foo(): void {}`, {}, false);
    if (!parseResult.success) throw new Error(parseResult.message);
    const ts = generateTypeScript(parseResult.result, undefined, undefined, "test.agency");
    expect(ts).toContain("schema: z.object({})");
  });

  // #33 — All function-typed params dropped → empty schema (no fields).
  it("emits an empty z.object({}) when every param is function-typed", () => {
    const parseResult = parseAgency(
      `def foo(req: () => void, other: () => void = null): void {}`,
      {},
      false,
    );
    if (!parseResult.success) throw new Error(parseResult.message);
    const ts = generateTypeScript(parseResult.result, undefined, undefined, "test.agency");
    const idx = ts.indexOf(`name: "foo"`);
    const slice = ts.slice(idx);
    expect(slice).toMatch(/schema:\s*z\.object\(\s*\{\s*\}\s*\)/);
  });

  // #34/#35 — @param docstring preservation/strip behaviour. The current
  // codegen embeds the entire docstring (including @param lines) in the
  // tool `description` field — and `stripBoundParams` removes lines for
  // params bound via `.partial()` at runtime. The schema-generator change
  // does NOT add per-field zod descriptions in this PR — that would be a
  // separate behavior shift. We pin the current behavior so any
  // accidental change is loud.
  it("includes @param lines in the tool description for kept params", () => {
    const parseResult = parseAgency(
      `def foo(...nums: number[]): number {\n  """\n  Do the thing.\n\n  @param nums - the values to sum\n  """\n  return 0\n}`,
      {},
      false,
    );
    if (!parseResult.success) throw new Error(parseResult.message);
    const ts = generateTypeScript(parseResult.result, undefined, undefined, "test.agency");
    expect(ts).toContain("the values to sum");
  });
});
