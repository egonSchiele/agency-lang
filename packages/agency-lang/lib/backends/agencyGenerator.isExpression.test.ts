import { describe, expect, it } from "vitest";
import { formatSource } from "../formatter.js";

// A prefix operator binds to the atom before `is` takes it, so
// `!value is string` parses as `(!value) is string`. The formatter has to
// keep the parentheses in `!(value is string)`.
function formatted(body: string): string | null {
  return formatSource(`def f(value: any, x: number) {\n${body}\n}\n`);
}

describe("formatting an is-expression", () => {
  it("keeps the parentheses when the is-expression is negated", () => {
    const body = "  const a = !(value is string)";
    expect(formatted(body)).toContain(body);
  });

  it("keeps the parentheses in an if condition", () => {
    const body = "  if (!(value is string)) {\n    return 1\n  }";
    expect(formatted(body)).toContain(body);
  });

  it("leaves an is-expression bare beside a binary operator", () => {
    const body = "  const e = value is string || x > 1";
    expect(formatted(body)).toContain(body);
  });
});
