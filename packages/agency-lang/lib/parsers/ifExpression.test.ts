import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { AgencyGenerator } from "../backends/agencyGenerator.js";

// `false` = skip pattern lowering, so we see the raw `ifElse` value node the
// parser produced (parseAgency lowers by default, rewriting it to a temp ref).
function parseRaw(src: string) {
  const parsed = parseAgency(src, {}, true, false);
  if (!parsed.success) throw new Error(parsed.message);
  return parsed.result;
}
function parseErr(src: string, re: RegExp) {
  const parsed = parseAgency(src, {}, true, false);
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.message).toMatch(re);
}
const WRAP = (rhs: string) => `node main(c: boolean, d: boolean) {\n  const x = ${rhs}\n  return x\n}`;

describe("if-expression parsing", () => {
  it("parses `if c then a else b` as an ifElse with single-expression branches", () => {
    const nodes = parseRaw(WRAP(`if c then "yes" else "no"`)).nodes as any[];
    const main = nodes.find((n) => n.type === "graphNode");
    const value = main.body.find((n: any) => n.type === "assignment").value;
    expect(value.type).toBe("ifElse");
    expect(value.thenBody).toHaveLength(1);
    expect(value.elseBody).toHaveLength(1);
    expect(value.thenBody[0].segments[0].value).toBe("yes");
    expect(value.elseBody[0].segments[0].value).toBe("no");
  });

  it("is valid in `return` position", () => {
    parseRaw(`def f(c: boolean): string { return if c then "a" else "b" }`);
  });

  // Restrictions — all rejected at parse time.
  it("cannot be an object value (not a general expression)", () =>
    parseErr(WRAP(`{ k: if c then "a" else "b" }`), /./));

  it("cannot be a function argument", () =>
    parseErr(`def f(s: string): string { return s }\nnode main(c: boolean) {\n  return f(if c then "a" else "b")\n}`, /./));

  it("a branch cannot itself be an if expression (no nesting)", () =>
    parseErr(WRAP(`if c then (if d then "x" else "y") else "z"`), /./));

  it("no `else if` chain", () =>
    parseErr(WRAP(`if c then "x" else if d then "y" else "z"`), /else|if/i));

  it("`else` is required", () =>
    parseErr(WRAP(`if c then "a"`), /requires an `else`/));

  it("round-trips through the formatter", () => {
    const src = `node main(c: boolean): string {\n  const kind = if c then "adult" else "child"\n  return kind\n}`;
    const out = new AgencyGenerator().generate(parseRaw(src)).output;
    expect(out).toContain(`if c then "adult" else "child"`);
    expect(parseAgency(out, {}, true, false).success).toBe(true);
  });
});
