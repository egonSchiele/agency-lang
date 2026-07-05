import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { AgencyGenerator } from "../backends/agencyGenerator.js";

function firstAssignmentValue(src: string): any {
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(parsed.message);
  for (const node of parsed.result.nodes as any[]) {
    const body = node.body ?? [];
    const assign = body.find((n: any) => n.type === "assignment");
    if (assign) return assign.value;
  }
  throw new Error("no assignment found");
}

describe("if expression parsing", () => {
  it("parses `if c then a else b` into an ifExpression with three sub-expressions", () => {
    const value = firstAssignmentValue(
      `node main() {\n  const x = if isProd then "prod" else "local"\n  return x\n}`,
    );
    expect(value.type).toBe("ifExpression");
    expect(value.condition.type).toBe("variableName");
    expect(value.thenExpr.segments[0].value).toBe("prod");
    expect(value.elseExpr.segments[0].value).toBe("local");
  });

  it("parses as an object property value (a plain expression position)", () => {
    const value = firstAssignmentValue(
      `node main(age: number) {\n  const p = { kind: if age > 18 then "adult" else "child" }\n  return p\n}`,
    );
    expect(value.type).toBe("agencyObject");
    const kind = value.entries.find((e: any) => e.key === "kind");
    expect(kind.value.type).toBe("ifExpression");
  });

  it("does not swallow identifiers that merely start with the keywords", () => {
    // `iffy` / `thenable` are ordinary identifiers, not `if` / `then`.
    const value = firstAssignmentValue(
      `node main(iffy: number) {\n  const x = iffy\n  return x\n}`,
    );
    expect(value.type).toBe("variableName");
    expect(value.value).toBe("iffy");
  });

  it("round-trips through the formatter", () => {
    const src = `node main(age: number): string {\n  const kind = if age > 18 then "adult" else "child"\n  return kind\n}`;
    const parsed = parseAgency(src);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const out = new AgencyGenerator().generate(parsed.result).output;
    expect(out).toContain(`if age > 18 then "adult" else "child"`);
    // and the formatted output re-parses
    expect(parseAgency(out).success).toBe(true);
  });
});
