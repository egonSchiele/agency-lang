import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string) {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  const result = typeCheck(parsed.result, {}, info);
  return {
    errors: result.errors.filter((e) => (e.severity ?? "error") === "error").map((e) => e.message),
  };
}

describe("the failure branch's shape", () => {
  it("types .error as a string", () => {
    const { errors } = check(`
def f(): Result { return failure("boom") }
def g(): number {
  const outcome = f()
  if (isFailure(outcome)) { return outcome.error }
  return 0
}`);
    expect(errors.join("\n")).toContain("not assignable");
  });

  it("types .data from the second type parameter", () => {
    const { errors } = check(`
type D = { status: string }
def f(): Result<number, D> { return failure("boom", { status: "gone" }) }
def g(): string {
  const outcome = f()
  if (isFailure(outcome)) { return outcome.data.status }
  return ""
}`);
    expect(errors).toEqual([]);
  });

  it("leaves .data open when no data type is declared", () => {
    const { errors } = check(`
def f(): Result<number> { return failure("boom", { anything: 1 }) }
def g(): string {
  const outcome = f()
  if (isFailure(outcome)) { return outcome.data.whatever }
  return ""
}`);
    expect(errors).toEqual([]);
  });
});

describe("failure argument diagnostics", () => {
  it("refuses a non-string message", () => {
    const { errors } = check(`def f(): Result { return failure(42) }`);
    expect(errors.join("\n")).toContain("first argument to failure()");
  });

  it("refuses data that is not an object", () => {
    const { errors } = check(`def f(): Result { return failure("boom", [1, 2]) }`);
    expect(errors.join("\n")).toContain("second argument to failure()");
  });

  it("refuses a bare failure in a function that declared a data type", () => {
    const { errors } = check(`
type D = { status: string }
def f(): Result<number, D> { return failure("boom") }`);
    expect(errors.join("\n")).toContain("needs a second argument");
  });

  it("refuses a bare failure through a type alias for the Result", () => {
    const { errors } = check(`
type D = { status: string }
type Outcome = Result<number, D>
def f(): Outcome { return failure("boom") }`);
    expect(errors.join("\n")).toContain("needs a second argument");
  });

  it("accepts a bare failure when the data type includes null", () => {
    const { errors } = check(`
type D = { status: string }
def f(): Result<number, D | null> { return failure("boom") }`);
    expect(errors).toEqual([]);
  });

  it("accepts a bare failure when no data type is declared", () => {
    const { errors } = check(`def f(): Result<number> { return failure("boom") }`);
    expect(errors).toEqual([]);
  });

  it("refuses an annotation whose data slot is not an object", () => {
    const { errors } = check(
      `def f(): Result<number, string> { return failure("boom", { a: 1 }) }`,
    );
    expect(errors.join("\n")).toContain("failure data must be an object");
  });
});

describe("a Result annotation whose data slot is not an object", () => {
  it("is refused on a variable declaration", () => {
    const { errors } = check(`
node main() {
  const outcome: Result<number, string> = success(1)
}`);
    expect(errors.join("\n")).toContain("failure data must be an object");
  });

  it("is refused rather than asking for a second argument", () => {
    // AG2015 would say "declares 'string' as its failure data, so failure()
    // needs a second argument", which is advice nobody can act on.
    const { errors } = check(`def f(): Result<number, string> { return failure("boom") }`);
    expect(errors.join("\n")).toContain("failure data must be an object");
    expect(errors.join("\n")).not.toContain("needs a second argument");
  });
});

describe("failure() and splats", () => {
  it("refuses a splatted failure", () => {
    const { errors } = check(`
def f(args: any[]): Result {
  return failure(...args)
}`);
    expect(errors.join("\n")).toContain("failure() cannot take a splat");
  });
});

describe("reject takes a string", () => {
  it("refuses a non-string reason", () => {
    const { errors } = check(`
node main() {
  handle {
    print("x")
  } with (intr) {
    return reject(42)
  }
}`);
    expect(errors.join("\n")).toContain("not assignable");
  });

  it("accepts a string reason and no reason at all", () => {
    const { errors } = check(`
node main() {
  handle {
    print("x")
  } with (intr) {
    if (intr.effect == "std::read") {
      return reject("not allowed")
    }
    return reject()
  }
}`);
    expect(errors).toEqual([]);
  });
});
