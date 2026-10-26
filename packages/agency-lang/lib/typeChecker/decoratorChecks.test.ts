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

describe("decorated body scopes", () => {
  const config = {
    typechecker: { enabled: true, undefinedVariables: "error", undefinedFunctions: "error" },
  } as const;
  const logged = "decorator def logged(call, block) { return block(call.args) }\n";

  it.each([
    ["single decorator", "@logged", "def"],
    ["stacked decorators", "@logged\n@logged", "def"],
    ["handoff function", "@logged", "export handoff def"],
  ])("resolves const and let locals for %s", (_label, tags, marker) => {
    const source = `${logged}${tags}
${marker} greet(name: string): string {
  const greeting = "hello \${name}"
  let result = greeting
  return result
}
`;
    expect(typecheckSource(source, config)).toEqual([]);
  });

  it("resolves locals in nested branches, destructive regions, and fork blocks", () => {
    const source = `${logged}@logged
def greet(name: string): string {
  let result = name
  if (name == "ada") {
    const suffix = "!"
    result = result + suffix
  }
  destructive {
    const ending = "."
    result = result + ending
  }
  const values = fork([result]) as value {
    const greeting = "hello \${value}"
    return greeting
  }
  return values[0]
}
`;
    expect(typecheckSource(source, config)).toEqual([]);
  });

  it("still reports a missing name at its original source location", () => {
    const source = `${logged}@logged
def greet(): string {
  const greeting = "hello"
  return greeting + missing
}
`;
    const errors = typecheckSource(source, config);
    expect(errors.map((error) => error.code)).toEqual(["AG4007"]);
    expect(errors[0].loc?.line).toBe(lineOf(source, "return greeting + missing"));
    expect(errors[0].message).toContain("'missing'");
  });

  it("reports reassignment to a decorated body's const once", () => {
    const source = `${logged}@logged
def greet(): string {
  const greeting = "hello"
  greeting = "goodbye"
  return greeting
}
`;
    expect(typecheckSource(source, config).map((error) => error.code)).toEqual(["AG4005"]);
  });
});

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

  it("reports AG6045, and not AG6039, at a def that is a decorator in all but the keyword", () => {
    const src =
      "def logged(tag: string | null = null, call: Call, block: () -> any): any {\n" +
      "  return block()\n}\n";
    const errors = typecheckSource(src).filter((e) => e.severity === "error");
    expect(errors.map((e) => [e.code, e.loc?.line])).toEqual([["AG6045", 0]]);
  });

  it("accepts a record slot typed with an alias of Call", () => {
    const aliased =
      "type Ctx = Call\ndecorator def d(call: Ctx, block: () -> any): any { return block() }\n";
    expect(typecheckSource(aliased).filter((e) => e.severity === "error")).toEqual([]);
  });

  it("types untyped slots so the body checks: call.name is a string and block() is allowed", () => {
    const src =
      "decorator def d(call, block) {\n  const n: string = call.name\n  return block()\n}\n";
    expect(typecheckSource(src).filter((e) => e.severity === "error")).toEqual([]);
  });

  it.each([
    { field: "id", record: '{ name: "x", args: {}, inToolCall: false }' },
    { field: "inToolCall", record: '{ name: "x", args: {}, id: "manual" }' },
  ])("requires $field in a direct decorator call", ({ record }) => {
    const src = BUDGETED + `node main() { budgeted(1, call: ${record}) { return "s" } }`;
    const errors = typecheckSource(src).filter((error) => error.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("is not assignable to parameter type 'Call'");
  });

  it("checks a direct call to a decorator like any call", () => {
    const src =
      BUDGETED +
      "node main() {\n" +
      '  budgeted(1, call: { name: "x", args: {}, id: "f.agency:x", inToolCall: false }) { return "s" }\n' +
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

  it("refuses a record slot typed with a Call the file redefined, from the stage and as AG6043", () => {
    // The decorator would be typed against a record it never receives.
    const src =
      "type Call = { foo: number }\n" +
      "decorator def d(call: Call, block: () -> any): any {\n  return block()\n}\n";
    const file = path.join(dir, "redefined.agency");
    fs.writeFileSync(file, src);
    const prepared = prepareProgram(src, file, {}, { keepGoing: true });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      prepared.diagnostics.map((found) =>
        found.stage === "decorators" ? found.message : found.stage,
      ),
    ).toEqual([expect.stringContaining("its type must be `Call` or left off")]);
    const errors = typeCheck(prepared.program, {}, prepared.info).errors;
    expect(errors.filter((error) => error.severity === "error").map((error) => error.code)).toEqual(
      ["AG6043"],
    );
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
