import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// A null literal reaches the synthesizer as a bare variableName named "null"
// (no dedicated case in synthType), so it used to synth as "any" — which made
// synthObject bail and skip assignment checking for the WHOLE object literal.
// These tests pin the fix: null in an object literal synths as the null type,
// so the other properties still get checked.
describe("null literals in object literals", () => {
  it("rejects null against a non-nullable property", () => {
    const errors = typecheckSource(`
node main() {
  const c: { name: string } = { name: null }
  return c
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });

  it("accepts null against a nullable property", () => {
    const errors = typecheckSource(`
node main() {
  const c: { name: string | null } = { name: null }
  return c
}
`);
    expect(errors).toEqual([]);
  });

  it("a null property no longer disables checking of its siblings", () => {
    const errors = typecheckSource(`
node main() {
  const c: { name: string | null, age: number } = { name: null, age: "x" }
  return c
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });
});
