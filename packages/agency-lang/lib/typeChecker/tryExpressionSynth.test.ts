import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

const notAssignable = (src: string) =>
  typecheckSource(src).filter((e) => /not assignable/.test(e.message));

describe("try expression: Result typing", () => {
  it("wraps a plain return type in a Result", () => {
    const src = (annotation: string) => `def f(): number { return 1 }
node main() {
  const x: Result<${annotation}> = try f()
  return "ok"
}`;
    expect(notAssignable(src("number"))).toHaveLength(0);
    expect(notAssignable(src("string")).length).toBeGreaterThan(0);
  });

  it("passes a Result named by a type alias through", () => {
    const src = (annotation: string) => `type R = Result<number>
def f(): R { return success(1) }
node main() {
  const x: Result<${annotation}> = try f()
  return "ok"
}`;
    expect(notAssignable(src("number"))).toHaveLength(0);
    expect(notAssignable(src("string")).length).toBeGreaterThan(0);
  });

  it("takes the success type from each Result in a union", () => {
    const src = (annotation: string) => `def f(): Result<number> | string { return success(1) }
node main() {
  const x: Result<${annotation}> = try f()
  return "ok"
}`;
    expect(notAssignable(src("number | string"))).toHaveLength(0);
    expect(notAssignable(src("boolean")).length).toBeGreaterThan(0);
  });
});
