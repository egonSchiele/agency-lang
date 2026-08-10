import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

// Pins validatePipeArg to the runtime's __pipeBind semantics: only a genuine
// Result LHS is unwrapped before flowing into the RHS's first parameter. A
// plain record — even one with a `success` field, like std::markdown's
// ParseResult — flows through as-is, so piping it into an array slot is a
// true positive, not a checker bug.
describe("pipe slot checking", () => {
  const PARSEISH = `
type ParseResult = {
  success: boolean;
  blocks: any[];
  error: string
}
def parseDoc(input: string): ParseResult {
  return { success: true, blocks: [input], error: "" }
}
def render(blocks: any[]): string {
  return "ok"
}`;

  // A pipe expression's own type is Result<slot fn's return>, so these bind
  // it to a local rather than returning it — the return-type check would
  // otherwise add unrelated errors.
  it("rejects piping a record into an array slot", () => {
    const errors = check(`${PARSEISH}
def go() {
  const h = parseDoc("x") |> render
}`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("pipe slot");
  });

  it("accepts piping the record's array field", () => {
    expect(
      check(`${PARSEISH}
def go() {
  const h = parseDoc("x").blocks |> render
}`),
    ).toEqual([]);
  });

  it("unwraps a genuine Result LHS to its success type", () => {
    expect(
      check(`
def half(n: number): Result<number> {
  return success(n / 2)
}
def go(): Result<number> {
  return half(10) |> half
}`),
    ).toEqual([]);
  });

  it("rejects a Result whose success type does not fit the slot", () => {
    const errors = check(`
def give(): Result<string> {
  return success("hi")
}
def wantNumber(n: number): number {
  return n
}
def go(): any {
  return give() |> wantNumber
}`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("pipe slot");
  });
});
