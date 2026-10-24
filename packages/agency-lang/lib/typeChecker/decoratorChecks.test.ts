import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { typecheckSource } from "./testUtils.js";
import { typeCheck } from "./index.js";
import { prepareProgram } from "../compiler/prepareProgram.js";
import { safeDeleteDirectory } from "../utils.js";
import type { TypeCheckError } from "./types.js";

// The decorator every case below uses: it takes the `call` record, one
// argument of its own, and a block returning string.
const BUDGETED =
  "decorator def budgeted(cost: number, call: Call, block: () -> string): Result<string> {\n" +
  "  return success(block())\n" +
  "}\n";

/** The 0-indexed line of the first line of `src` that contains `text`,
 *  which is what `loc.line` holds. */
function lineOf(src: string, text: string): number {
  return src.split("\n").findIndex((line) => line.includes(text));
}

function withCode(errors: TypeCheckError[], name: string): TypeCheckError[] {
  return errors.filter((error) => error.name === name);
}

describe("decorators in the checker", () => {
  it("reports AG6044 at a tag on a plain def when the checker runs on its own", () => {
    const src =
      "def logged(call: Call, block: () -> any): any { return block() }\n" +
      "@logged\n" +
      'def f(): string { return "x" }\n';
    const [error] = withCode(typecheckSource(src), "notADecorator");
    expect(error.code).toBe("AG6044");
    expect(error.message).toBe(
      "'logged' is not a decorator, so '@logged' cannot go on 'f'. Declare it as `decorator def logged(...)`.",
    );
    expect(error.loc?.line).toBe(lineOf(src, "@logged"));
  });

  it("reports AG6043 once at a decorator def in the wrong shape, and nothing at its tags", () => {
    const src = 'decorator def d(block) { return block() }\n@d\ndef f(): string { return "x" }\n';
    const errors = typecheckSource(src).filter((e) => e.severity === "error");
    expect(errors.map((e) => [e.code, e.loc?.line])).toEqual([["AG6043", 0]]);
  });

  it("types untyped slots so the body checks: call.name is a string and block() is allowed", () => {
    const src =
      "decorator def d(call, block) {\n  const n: string = call.name\n  return block()\n}\n";
    expect(typecheckSource(src).filter((e) => e.severity === "error")).toEqual([]);
  });

  it("checks a direct call to a decorator like any call", () => {
    const src =
      BUDGETED +
      "node main() {\n" +
      '  budgeted(1, call: { name: "x", args: {} }) { return "s" }\n' +
      '  budgeted(1) { return "s" }\n' +
      "}\n";
    const errors = typecheckSource(src).filter((e) => e.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].loc?.line).toBe(lineOf(src, "budgeted(1) {"));
  });
});

describe("decorator mismatch diagnostics", () => {
  it("names the decorator when a tag argument has the wrong type", () => {
    const src = BUDGETED + '@budgeted(cost: "x")\ndef one(): Result<string> {\n  return "a"\n}\n';
    const [error] = withCode(typecheckSource(src), "decoratorArgType");
    expect(error).toBeDefined();
    expect(error.message).toContain("Decorator 'budgeted' on 'one'");
    expect(error.message).toContain("expects 'cost: number'");
    expect(error.loc?.line).toBe(lineOf(src, "@budgeted"));
  });

  it("points at the body's return when it does not fit the decorator's block", () => {
    const src = BUDGETED + "@budgeted(cost: 1)\ndef two(): Result<string> {\n  return 5\n}\n";
    const [error] = withCode(typecheckSource(src), "decoratorBodyReturn");
    expect(error).toBeDefined();
    expect(error.message).toContain("The body of 'two' returns 'number'");
    expect(error.message).toContain("decorator 'budgeted' takes a block returning 'string'");
    expect(error.loc?.line).toBe(lineOf(src, "return 5"));
  });

  it("names the decorator when its return does not fit the def's declared type", () => {
    const src = BUDGETED + '@budgeted(cost: 1)\ndef three(): number {\n  return "a"\n}\n';
    const [error] = withCode(typecheckSource(src), "decoratorReturnMismatch");
    expect(error).toBeDefined();
    expect(error.message).toContain("'three' is declared to return 'number'");
    expect(error.message).toContain("decorator 'budgeted' returns 'Result<string>'");
    expect(error.loc?.line).toBe(lineOf(src, "@budgeted"));
  });

  it("blames the inner decorator, not the body, when stacked decorators disagree", () => {
    const src =
      BUDGETED +
      "decorator def inner(call: Call, block: () -> number): number {\n  return block()\n}\n" +
      "@budgeted(cost: 1)\n@inner\ndef five(): Result<string> {\n  return 1\n}\n";
    const errors = typecheckSource(src);
    const [error] = withCode(errors, "decoratorStackedReturn");
    expect(error).toBeDefined();
    expect(error.message).toContain("Decorator 'inner' returns 'number'");
    expect(error.message).toContain("decorator 'budgeted' above it on 'five'");
    expect(error.loc?.line).toBe(lineOf(src, "@inner"));
    expect(withCode(errors, "decoratorBodyReturn")).toEqual([]);
  });

  it("counts only the arguments the tag was written with", () => {
    const src = BUDGETED + '@budgeted\ndef four(): Result<string> {\n  return "a"\n}\n';
    const [error] = withCode(typecheckSource(src), "callArityExact");
    expect(error).toBeDefined();
    expect(error.message).toBe("Expected 1 argument(s) for 'budgeted', but got 0.");
  });

  it("leaves the call record and the body out of the valid argument names", () => {
    const src =
      BUDGETED + '@budgeted(cost: 1, costs: 2)\ndef six(): Result<string> {\n  return "a"\n}\n';
    const [error] = withCode(typecheckSource(src), "unknownNamedArg");
    expect(error).toBeDefined();
    expect(error.message).toContain("Valid names: cost.");
  });

  it("accepts block(call.args) against a block typed () -> any", () => {
    const src =
      "decorator def d(call: Call, block: () -> any): any {\n  return block(call.args)\n}\n" +
      "@d\ndef f(a: number): number {\n  return a\n}\n";
    expect(typecheckSource(src).filter((error) => error.severity === "error")).toEqual([]);
  });

  it("checks a plain block-taking call's block body, and gives the error a line", () => {
    const src =
      "def twice(block: () -> string): string {\n  return block()\n}\n" +
      "node main() {\n  twice() as {\n    return 5\n  }\n}\n";
    const [error] = withCode(typecheckSource(src), "typeNotAssignableInContext");
    expect(error).toBeDefined();
    expect(error.message).toContain("(block return)");
    expect(error.loc?.line).toBe(lineOf(src, "return 5"));
  });
});

describe("a saveDraft in a decorated body", () => {
  // The body is the decorator's block, so a draft is the block's value and
  // must fit the block slot's return type, not the def's declared type.
  it("accepts a draft of the block's return type", () => {
    const src =
      BUDGETED +
      '@budgeted(cost: 1)\ndef f(): Result<string> {\n  saveDraft("partial")\n  return "a"\n}\n';
    expect(typecheckSource(src).filter((error) => error.severity === "error")).toEqual([]);
  });

  it("refuses a draft that does not fit the block, naming the decorator", () => {
    const src =
      BUDGETED +
      '@budgeted(cost: 1)\ndef f(): Result<string> {\n  saveDraft(42)\n  return "a"\n}\n';
    const [error] = withCode(typecheckSource(src), "decoratorDraftType");
    expect(error).toBeDefined();
    expect(error.message).toBe(
      "The body of 'f' saves a draft of type 'number', but decorator 'budgeted' takes a block returning 'string'.",
    );
    expect(error.loc?.line).toBe(lineOf(src, "saveDraft(42)"));
  });

  it("accepts any draft when the decorator's block returns any", () => {
    // The shape of the stdlib @guard: a reusable decorator over a Result def.
    const src =
      "decorator def wrapped(call: Call, block: () -> any): Result {\n  return success(block())\n}\n" +
      '@wrapped\ndef f(): Result<string> {\n  saveDraft("partial")\n  return "a"\n}\n';
    expect(typecheckSource(src).filter((error) => error.severity === "error")).toEqual([]);
  });

  it("checks a draft in a plain def against the def's return type, as before", () => {
    const src = 'def f(): string {\n  saveDraft(42)\n  return "a"\n}\n';
    expect(withCode(typecheckSource(src), "typeNotAssignableInContext")).toHaveLength(1);
  });
});

describe("the checks checkType does besides assignability still run on a decorated def", () => {
  const ANY_DECORATOR =
    "decorator def wrapped(call: Call, block: () -> any): any {\n  return block()\n}\n";

  it("rejects a regex in a decorated llm() return type", () => {
    const src =
      "decorator def deco(call: Call, block: () -> regex): regex {\n  return block()\n}\n" +
      '@deco\ndef f(): regex {\n  return llm("pick a pattern")\n}\n';
    expect(withCode(typecheckSource(src), "regexInStructuredOutput")).toHaveLength(1);
  });

  it("explains a failure with missing data", () => {
    const src =
      "type Oops = { code: number }\n" +
      "def deco(block: () -> Result<string, Oops>): Result<string, Oops> {\n  return block()\n}\n" +
      '@deco\ndef f(): Result<string, Oops> {\n  return failure("no")\n}\n';
    expect(withCode(typecheckSource(src), "failureNeedsData")).toHaveLength(1);
  });

  it("reports an extra key on an object literal", () => {
    const src =
      "type Point = { x: number }\n" +
      "def deco(block: () -> Point): Point {\n  return block()\n}\n" +
      "@deco\ndef f(): Point {\n  return { x: 1, y: 2 }\n}\n";
    expect(withCode(typecheckSource(src), "unknownProperty")).toHaveLength(1);
  });

  it("stays quiet for a decorator whose block is any", () => {
    const src = ANY_DECORATOR + "@wrapped\ndef f(): number {\n  return 5\n}\n";
    expect(typecheckSource(src).filter((error) => error.severity === "error")).toEqual([]);
  });
});

describe("a typo in a decorator name", () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(process.cwd(), ".agency-tmp", `decorator-checks-${nanoid()}`);
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    safeDeleteDirectory(dir, false);
  });

  it("is reported once, by the decorators stage, and not again as an undefined function", () => {
    const src =
      "def budgeted(block: () -> any): any {\n  return block()\n}\n" +
      '@budgted\ndef f(): string {\n  return "x"\n}\n';
    const file = path.join(dir, "main.agency");
    fs.writeFileSync(file, src);
    // The path `agency typecheck` and the editor take: keep going past the
    // stage failure and run the checker anyway.
    const prepared = prepareProgram(src, file, {}, { keepGoing: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.diagnostics.map((found) => found.stage)).toEqual(["decorators"]);
    const errors = typeCheck(prepared.program, {}, prepared.info).errors;
    expect(withCode(errors, "undefinedFunction")).toEqual([]);
  });

  it("reports a wrong-shape decorator from the stage and as AG6043, and nothing else", () => {
    // The checker adds no argument-count error against the wrong slots; its
    // one error is the same shape report, which the editor drops.
    const src =
      "decorator def d(call: Call, tag: string, block: () -> any): any {\n  return block()\n}\n" +
      '@d("t")\ndef f(): string {\n  return "a"\n}\n';
    const file = path.join(dir, "shape.agency");
    fs.writeFileSync(file, src);
    const prepared = prepareProgram(src, file, {}, { keepGoing: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      prepared.diagnostics.map((found) =>
        found.stage === "decorators" ? found.message : found.stage,
      ),
    ).toEqual([expect.stringContaining("'tag' receives the call record")]);
    const errors = typeCheck(prepared.program, {}, prepared.info).errors;
    expect(errors.filter((error) => error.severity === "error").map((error) => error.code)).toEqual(
      ["AG6043"],
    );
  });
});
