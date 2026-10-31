import { describe, it, expect } from "vitest";
import { parseAgency } from "../../parser.js";
import type { LintContext, LintFinding } from "../types.js";
import { rebuiltFailureRule } from "./rebuiltFailure.js";

function ctxFor(source: string): LintContext {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error("test source did not parse");
  return { program: parsed.result, source, filePath: "/test.agency" };
}

function findings(source: string): LintFinding[] {
  return rebuiltFailureRule.run(ctxFor(source));
}

function applyFix(source: string, finding: LintFinding): string {
  const edit = finding.fix!.edits[0];
  return source.slice(0, edit.start) + edit.newText + source.slice(edit.end);
}

const rebuilt = [
  `def f(x: Result<string>): Result<number> {`,
  `  if (x is failure(why)) {`,
  `    return failure(why)`,
  `  }`,
  `  return success(1)`,
  `}`,
  ``,
].join("\n");

describe("rebuilt-failure rule", () => {
  it("flags return failure(why) inside if (x is failure(why))", () => {
    const found = findings(rebuilt);
    expect(found).toHaveLength(1);
    expect(found[0].code).toBe("AL0004");
    expect(found[0].message).toBe(
      "failure(why) rebuilds 'x' and drops its flags. Return 'x' itself.",
    );
    expect(found[0].loc.line).toBe(2);
  });

  it("fixes it by returning the checked value", () => {
    const fixed = applyFix(rebuilt, findings(rebuilt)[0]);
    expect(fixed).toContain("    return x\n");
    expect(findings(fixed)).toEqual([]);
  });

  it("flags return failure(x.error) inside if (isFailure(x))", () => {
    const src = [
      `def f(x: Result<string>): Result<number> {`,
      `  if (isFailure(x)) {`,
      `    return failure(x.error)`,
      `  }`,
      `  return success(1)`,
      `}`,
    ].join("\n");
    expect(findings(src).map((f) => f.message)).toEqual([
      "failure(x.error) rebuilds 'x' and drops its flags. Return 'x' itself.",
    ]);
  });

  it("finds a rebuild nested deeper in the branch", () => {
    const src = [
      `def f(x: Result<string>, loud: boolean): Result<number> {`,
      `  if (x is failure(why)) {`,
      `    if (loud) {`,
      `      return failure(why)`,
      `    }`,
      `    return success(0)`,
      `  }`,
      `  return success(1)`,
      `}`,
    ].join("\n");
    expect(findings(src)).toHaveLength(1);
  });

  it("does not flag returning the checked value", () => {
    const src = [
      `def f(x: Result<string>): Result<number> {`,
      `  if (x is failure(why)) {`,
      `    return x`,
      `  }`,
      `  return success(1)`,
      `}`,
    ].join("\n");
    expect(findings(src)).toEqual([]);
  });

  it("does not flag a failure built from a new message", () => {
    const src = [
      `def f(x: Result<string>): Result<number> {`,
      `  if (x is failure(why)) {`,
      `    return failure("could not read: \${why}")`,
      `  }`,
      `  return success(1)`,
      `}`,
    ].join("\n");
    expect(findings(src)).toEqual([]);
  });

  it("does not flag a failure that carries data", () => {
    const src = [
      `def f(x: Result<string>): Result<number> {`,
      `  if (x is failure(why)) {`,
      `    return failure(why, { stage: "read" })`,
      `  }`,
      `  return success(1)`,
      `}`,
    ].join("\n");
    expect(findings(src)).toEqual([]);
  });

  it("does not flag a message bound from a different failure", () => {
    const src = [
      `def f(x: Result<string>, y: Result<string>): Result<number> {`,
      `  if (x is failure(why)) {`,
      `    const other = y.error`,
      `    return failure(other)`,
      `  }`,
      `  return success(1)`,
      `}`,
    ].join("\n");
    expect(findings(src)).toEqual([]);
  });
});
