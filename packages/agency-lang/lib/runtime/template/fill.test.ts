import { describe, it, expect } from "vitest";
import {
  _loadTemplateFromString,
  _parseExpr,
  _parseStatements,
  _toSource,
} from "../../stdlib/template.js";
import { _parseAST } from "../../stdlib/agency.js";
import { holeInfos } from "../../utils/holes.js";
import { fillHoles } from "./fill.js";

const load = _loadTemplateFromString;

function fillAndPrint(source: string, values: Record<string, unknown>): string {
  return _toSource(fillHoles(load(source), values));
}

describe("fillHoles: lifting", () => {
  it("lifts a string filler to a string literal, never parsing it", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, {
      v: `readFile("/etc/passwd")`,
    });
    expect(out).toContain(`"readFile(\\"/etc/passwd\\")"`);
    // The real check: fails if anyone ever makes fill parse its input.
    expect(out).not.toMatch(/=\s*readFile\(/);
  });

  // These must distinguish a value from its string form: `toContain("42")`
  // passes whether 42 was lifted to a number literal or wrongly to "42".
  it("lifts a number as a number, not a string", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: 42 });
    expect(out).toContain("= 42");
    expect(out).not.toContain(`"42"`);
  });

  it("lifts a boolean as a boolean", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: true });
    expect(out).toContain("= true");
    expect(out).not.toContain(`"true"`);
  });

  it("lifts an array of numbers, not of strings", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: [1, 2] });
    expect(out).toContain("[1, 2]");
    expect(out).not.toContain(`"1"`);
  });

  it("lifts an object to an object literal", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: { a: 1 } });
    expect(out).toContain("a: 1");
  });

  it("rejects an object with a __proto__ key", () => {
    // A `__proto__` key in a JS object literal sets the prototype even
    // when quoted; a lifted record must never smuggle that in.
    const poisoned = JSON.parse('{"__proto__": {"polluted": true}}');
    expect(() =>
      fillHoles(load(`node main() {\n  const x = #v\n}\n`), { v: poisoned }),
    ).toThrow(/__proto__/);
  });

  it("lifts null", () => {
    expect(fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: null })).toContain(
      "= null",
    );
  });

  it("fills every occurrence of a repeated name", () => {
    const out = fillAndPrint(`node main() {\n  const a = #v\n  const b = #v\n}\n`, { v: 7 });
    expect(out.match(/7/g)?.length).toBe(2);
  });

  it("rejects a value for a hole that does not exist", () => {
    expect(() => fillHoles(load(`node main() {\n  return 1\n}\n`), { nope: 1 })).toThrow(
      /nope/,
    );
  });

  it("allows a partial fill, leaving other holes in place", () => {
    const filled = fillHoles(load(`node main() {\n  const a = #x\n  const b = #y\n}\n`), {
      x: 1,
    });
    expect(_toSource(filled)).toContain("#y");
  });

  it("composes: filling the result of a partial fill empties the holes", () => {
    const template = load(`node main() {\n  const a = #x\n  const b = #y\n}\n`);
    const once = fillHoles(template, { x: 1 });
    expect(holeInfos(fillHoles(once, { y: 2 }).nodes)).toEqual([]);
  });
});

describe("fillHoles: fragment kinds", () => {
  const exprTemplate = `node main() {\n  const x = #v: number\n}\n`;
  const stmtTemplate = `node main() {\n  #setup\n  return 1\n}\n`;

  it("grafts an expr fragment into an expr hole", () => {
    const out = fillAndPrint(exprTemplate, { v: _parseExpr("a + b") });
    expect(out).toContain("= a + b");
  });

  it("grafts a statements fragment into a statements hole", () => {
    const out = fillAndPrint(stmtTemplate, { setup: _parseStatements("const inner = 5") });
    expect(out).toContain("const inner = 5");
  });

  it("grafts a multi-statement fragment, spreading it into the body", () => {
    const out = fillAndPrint(stmtTemplate, {
      setup: _parseStatements("print(1)\nprint(2)"),
    });
    expect(out).toContain("print(1)");
    expect(out).toContain("print(2)");
  });

  // INVERTED deliberately by the expr-fills-statements relaxation: this
  // case used to assert a throw. An expression IS a legal statement (an
  // expression statement is the expression node itself in the body
  // array), and the relaxation is what makes code-literal kind
  // inference lossless.
  it("an expr fragment fills a statements hole as an expression statement", () => {
    const filled = fillHoles(load(stmtTemplate), { setup: _parseExpr("print(99)") });
    const main = filled.nodes.find((n: any) => n.type === "graphNode") as any;
    expect(
      main.body.some((n: any) => n.type === "functionCall" && n.functionName === "print"),
    ).toBe(true);
  });

  it("an odd expr-statement grafts fine; the generated programs compile judges it", () => {
    const filled = fillHoles(load(stmtTemplate), { setup: _parseExpr("1 + 2") });
    const main = filled.nodes.find((n: any) => n.type === "graphNode") as any;
    expect(main.body.some((n: any) => n.type === "binOpExpression")).toBe(true);
  });

  // Guards on the rows the relaxation must PRESERVE: an append that
  // became a replace would break these silently otherwise.
  it("a program fragment still fills a statements hole", () => {
    const out = fillAndPrint(stmtTemplate, {
      setup: _loadTemplateFromString("def g(): number {\n  return 1\n}\n"),
    });
    expect(out).toContain("def g(): number");
  });

  it("decl holes still reject expr and statements fragments", () => {
    const declTemplate = `#helpers\n\nnode main() {\n  return 1\n}\n`;
    expect(() => fillHoles(load(declTemplate), { helpers: _parseExpr("1") })).toThrow(/decl/);
    expect(() =>
      fillHoles(load(declTemplate), { helpers: _parseStatements("print(1)") }),
    ).toThrow(/decl/);
  });

  it("rejects a statements fragment in an expr hole", () => {
    expect(() =>
      fillHoles(load(exprTemplate), { v: _parseStatements("const x = 1") }),
    ).toThrow(/expr.*statements|statements.*expr/,
    );
  });

  // The parseAST escape hatch produces an old-shape AST with no `kind`;
  // it means "program".
  it("treats a kind-less Code value as a program in a statements hole", () => {
    const out = fillAndPrint(stmtTemplate, { setup: _parseAST("const x = 1") });
    expect(out).toContain("const x = 1");
  });

  it("rejects a kind-less Code value in an expr hole, naming program", () => {
    expect(() => fillHoles(load(exprTemplate), { v: _parseAST("const x = 1") })).toThrow(
      /program/,
    );
  });
});

describe("fillHoles: holey Code grafts and completes later", () => {
  // The motivating workflow: build the shape first, parameterize last.
  it("grafts a partially filled template and fills its holes afterward", () => {
    const guardTpl = load(`guard(maxTime: #minutes) {\n  #body\n}\n`);
    const mainTpl = load(`node main() {\n  #body\n}\n`);

    const body = _parseStatements(`print("fetching news")`);
    const guarded = fillHoles(guardTpl, { body: body }); // #minutes still open
    const program = fillHoles(mainTpl, { body: guarded }); // grafting holey Code is legal

    // The grafted hole is visible on the combined value...
    expect(holeInfos(program.nodes)).toMatchObject([{ name: "minutes", sort: "expr" }]);

    // ...and a later fill completes it.
    const done = fillHoles(program, { minutes: 120000 });
    expect(holeInfos(done.nodes)).toEqual([]);
    const out = _toSource(done);
    expect(out).toContain("guard(maxTime: 120000)");
    expect(out).toContain(`print("fetching news")`);
  });
});

describe("fill-time type checking", () => {
  const t = `node main() {\n  const prompt: string = #text\n  return prompt\n}\n`;

  it("accepts a Code filler of the right type", () => {
    expect(fillAndPrint(t, { text: _parseExpr(`"hello"`) })).toContain(`"hello"`);
  });

  it("rejects a Code filler of the wrong type", () => {
    expect(() => fillHoles(load(t), { text: _parseExpr("42") })).toThrow(/string/);
  });

  it("accepts a plain string", () => {
    expect(fillAndPrint(t, { text: "hello" })).toContain(`"hello"`);
  });

  it("rejects a plain number for a string hole", () => {
    expect(() => fillHoles(load(t), { text: 42 })).toThrow(/string/);
  });

  it("names the hole in the error", () => {
    expect(() => fillHoles(load(t), { text: 42 })).toThrow(/#text/);
  });

  it("checks against an inline annotation too", () => {
    const annotated = `node main() {\n  f(#count: number)\n}\n`;
    expect(() => fillHoles(load(annotated), { count: "many" })).toThrow(/number/);
    expect(fillAndPrint(annotated, { count: 3 })).toContain("f(3)");
  });

  it("lets an unknowable fragment through — validation, not a guarantee", () => {
    expect(fillAndPrint(t, { text: _parseExpr("getGreeting()") })).toContain(
      "getGreeting()",
    );
  });

  it("treats an interpolated string literal as unknowable, not as string", () => {
    // `"${x}"` could evaluate to anything a formatter renders; the guard
    // in certainTypeOf must return null for it in BOTH directions.
    const numberHole = `node main() {\n  const n: number = #v\n  return n\n}\n`;
    expect(() =>
      fillHoles(load(numberHole), { v: _parseExpr('"${getCount()}"') }),
    ).not.toThrow();
  });

  it("validates against the FIRST position when a name appears twice", () => {
    const src = `node main() {\n  const a: string = #v\n  const b: number = #v\n  return b\n}\n`;
    expect(() => fillHoles(load(src), { v: "hello" })).not.toThrow(); // string wins
    expect(() => fillHoles(load(src), { v: 42 })).toThrow(/string/);
  });

  // Code is a plain record an Agency caller can build by hand, so the
  // structural guards are load-bearing, not dead code.
  it("rejects an expr fragment carrying more than one node", () => {
    const t2 = `node main() {\n  const x = #v: number\n}\n`;
    const bad = {
      type: "agencyProgram" as const,
      kind: "expr" as const,
      nodes: [_parseExpr("1").nodes[0], _parseExpr("2").nodes[0]],
    };
    expect(() => fillHoles(load(t2), { v: bad })).toThrow();
  });

  it("a nodes-less object lifts as data, not as Code", () => {
    const t2 = `node main() {\n  const x = #v\n}\n`;
    expect(fillAndPrint(t2, { v: { type: "agencyProgram" } })).toContain("agencyProgram");
  });

  it("rejects a non-finite number — no Agency literal exists for it", () => {
    const t2 = `node main() {\n  const x = #v\n}\n`;
    expect(() => fillHoles(load(t2), { v: JSON.parse("1e400") })).toThrow(/non-finite/);
    expect(() => fillHoles(load(t2), { v: Number.NaN })).toThrow(/non-finite/);
  });
});

describe("fillHoles: origin stamping", () => {
  it("stamps origin on every node of a grafted fragment, not just the top", () => {
    const filled = fillHoles(load(`node main() {\n  #setup\n}\n`), {
      setup: _parseStatements(`const x = f(1 + 2)`),
    });
    const nodeDef = filled.nodes.find((n) => n.type === "graphNode");
    if (!nodeDef || nodeDef.type !== "graphNode") throw new Error("no node");
    const assignment = nodeDef.body.find((n) => n.type === "assignment");
    if (!assignment || assignment.type !== "assignment") throw new Error("no assignment");
    // Top of the graft...
    expect(assignment.loc?.origin).toEqual({ kind: "filler", name: "setup" });
    // ...and a nested expression inside it.
    const call = assignment.value as { loc?: { origin?: unknown } };
    expect(call.loc?.origin).toEqual({ kind: "filler", name: "setup" });
  });
});

describe("fillHoles: holes inside guard-block heads", () => {
  // Regression: walkNodes did not descend into a guardBlock's argument
  // expressions, so `guard(time: #minutes)` inside a def lost its hole —
  // holesOf reported nothing and the composed-template workflow broke.
  it("finds and fills a hole in a guard head inside a def", () => {
    const tpl = load(
      `def guarded(): string {\n  const result = guard(time: #minutes) {\n    return "x"\n  }\n  return result.value\n}\n\nnode main() {\n  return guarded()\n}\n`,
    );
    expect(holeInfos(tpl.nodes)).toMatchObject([{ name: "minutes", sort: "expr" }]);
    const out = _toSource(fillHoles(tpl, { minutes: 120000 }));
    expect(out).toContain("guard(time: 120000)");
  });
});

describe("fillHoles: identifier holes", () => {
  const template = `import { #tool } from "std::fs"\n\nnode main() {\n  return 1\n}\n`;

  it("accepts a legal identifier", () => {
    expect(fillAndPrint(template, { tool: "readFile" })).toContain("readFile");
  });

  it("accepts a leading underscore", () => {
    expect(fillAndPrint(template, { tool: "_hidden" })).toContain("_hidden");
  });

  it("fills a def-name hole", () => {
    const out = fillAndPrint(`def #name(): number {\n  return 1\n}\n`, { name: "helper" });
    expect(out).toContain("def helper()");
  });

  it("fills a node-name hole", () => {
    const out = fillAndPrint(`node #n() {\n  return 1\n}\n`, { n: "start" });
    expect(out).toContain("node start()");
  });

  it("rejects an injection attempt", () => {
    expect(() => fillHoles(load(template), { tool: "x } import evil" })).toThrow(
      /not a legal identifier/,
    );
  });

  it("rejects a leading digit", () => {
    expect(() => fillHoles(load(template), { tool: "1st" })).toThrow(
      /not a legal identifier/,
    );
  });

  it("rejects a non-string", () => {
    expect(() => fillHoles(load(template), { tool: 42 })).toThrow(
      /not a legal identifier/,
    );
  });

  it("rejects a reserved word", () => {
    expect(() => fillHoles(load(template), { tool: "if" })).toThrow(/reserved word/);
  });

  it("rejects the hygiene prefix", () => {
    expect(() => fillHoles(load(template), { tool: "__hyg1_x" })).toThrow(/reserved/);
  });
});

describe("filling splices", () => {
  const importTpl = `#...imports\n\nnode main() {\n  return 1\n}\n`;

  it("expands to as many items as the array has", () => {
    const filled = fillHoles(load(importTpl), {
      imports: ["readFile", "grep"].map((name) =>
        fillHoles(load(`import { #tool } from "std::fs"\n`), { tool: name }),
      ),
    });
    const out = _toSource(filled);
    expect(out).toContain("readFile");
    expect(out).toContain("grep");
    expect(out.match(/^import /gm)?.length).toBe(2);
  });

  it("expands an empty array to nothing", () => {
    const out = _toSource(fillHoles(load(importTpl), { imports: [] }));
    expect(out).not.toContain("import");
  });

  it("rejects a non-array for a splice", () => {
    expect(() => fillHoles(load(importTpl), { imports: "readFile" })).toThrow(
      /needs an array/,
    );
  });

  it("splices statements into a statement list", () => {
    const out = _toSource(
      fillHoles(load(`node main() {\n  #...steps\n}\n`), {
        steps: [_parseStatements("print(1)"), _parseStatements("print(2)")],
      }),
    );
    expect(out).toContain("print(1)");
    expect(out).toContain("print(2)");
  });

  it("splices into an argument list", () => {
    const out = _toSource(
      fillHoles(load(`node main() {\n  f(#...args)\n}\n`), {
        args: [_parseExpr("1"), _parseExpr("2")],
      }),
    );
    expect(out).toContain("f(1, 2)");
  });
});

describe("origin attribution", () => {
  it("a type error on a grafted hole names the graft it arrived through", () => {
    // The guard template routes #minutes through an annotated assignment
    // because fill-time type validation reads the hole annotation or the
    // annotated-assignment parent only; a bare named-argument hole would
    // supply no expected type and validation would silently pass.
    const guardTpl = load(
      `def guarded(): string {\n  const ms: number = #minutes\n  #body\n  return "done"\n}\n`,
    );
    const mainTpl = load(`#helpers\n\nnode main(): string {\n  return guarded()\n}\n`);
    const partial = fillHoles(guardTpl, { body: _parseStatements("print(1)") });
    const program = fillHoles(mainTpl, { helpers: partial });
    expect(() => fillHoles(program, { minutes: "two" })).toThrow(
      /in code grafted by the fill for `#helpers`/,
    );
  });

  it("an author-written hole gets no origin suffix", () => {
    const tpl = load(`node main() {\n  const x: number = #count\n}\n`);
    expect(() => fillHoles(tpl, { count: "two" })).toThrow(/expects `number`/);
    expect(() => fillHoles(tpl, { count: "two" })).not.toThrow(/grafted by the fill/);
  });

  it("the unknown-name error annotates grafted holes with their origin", () => {
    const inner = load(`node main() {\n  const x: number = #minutes\n}\n`);
    const outer = load(`#helpers\n`);
    const program = fillHoles(outer, { helpers: inner });
    expect(() => fillHoles(program, { nope: 1 })).toThrow(
      /#minutes \(from the fill for `#helpers`\)/,
    );
  });
});

describe("fill-time type checking: records and aliases", () => {
  const personTemplate = [
    "type Person = {",
    "  name: string;",
    "  age: number",
    "}",
    "",
    "node main(): string {",
    "  const person: Person = #person",
    '  return "ok"',
    "}",
    "",
  ].join("\n");

  // These assert THAT the fill is rejected and which hole is named — not
  // the wording. Task 2 throws the general two-types message; the messages
  // that name a property arrive in Task 3, and their assertions live
  // there. Asserting content here would fail at the end of Task 2 and stop
  // the executor for the wrong reason.

  it("rejects a record missing a required property", () => {
    expect(() => fillHoles(load(personTemplate), { person: { name: "Alice" } })).toThrow(
      /#person.*expects/,
    );
  });

  it("rejects a primitive where a record is wanted", () => {
    expect(() => fillHoles(load(personTemplate), { person: 42 })).toThrow(/expects/);
  });

  it("accepts a complete record", () => {
    expect(fillAndPrint(personTemplate, { person: { name: "Alice", age: 30 } })).toContain(
      "Alice",
    );
  });

  it("resolves an alias for a primitive", () => {
    const aliased = [
      "type Name = string",
      "",
      "node main(): string {",
      "  const n: Name = #who",
      "  return n",
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(aliased), { who: 42 })).toThrow(/expects/);
    expect(fillAndPrint(aliased, { who: "Alice" })).toContain("Alice");
  });

  it("checks a nested record", () => {
    const nested = [
      "type Address = {",
      "  city: string",
      "}",
      "type Person = {",
      "  name: string;",
      "  address: Address",
      "}",
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(nested), { person: { name: "A", address: {} } }),
    ).toThrow(/expects/);
  });

  it("checks an array of records", () => {
    const list = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main(): string {",
      "  const people: Person[] = #people",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(list), { people: [{ name: "A", age: 1 }, { name: "B" }] }),
    ).toThrow(/expects/);
    expect(fillAndPrint(list, { people: [{ name: "A", age: 1 }] })).toContain("A");
  });

  it("accepts an absent optional property", () => {
    const optional = [
      "type Person = {",
      "  name: string;",
      "  nickname?: string",
      "}",
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(optional, { person: { name: "A" } })).toContain("A");
  });

  it("accepts any arm of a union and rejects something outside it", () => {
    const union = [
      "node main(): string {",
      "  const v: string | number = #v",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(union, { v: "a" })).toContain('"a"');
    expect(fillAndPrint(union, { v: 1 })).toContain("1");
    expect(() => fillHoles(load(union), { v: true })).toThrow(/expects/);
  });

  it("accepts a string against a union of string literals", () => {
    // THE INVARIANT TEST. `const mode: "fast" | "slow" = "fast"` compiles,
    // so fill must not refuse it. The widened description does not fit the
    // union; the literal-accurate second pass does.
    const literals = [
      "node main(): string {",
      '  const mode: "fast" | "slow" = #mode',
      "  return mode",
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(literals, { mode: "fast" })).toContain('"fast"');
    expect(() => fillHoles(load(literals), { mode: "medium" })).toThrow(/expects/);
  });

  it("rejects a number against a union of number literals, as the compile does", () => {
    // synthType widens numbers, so `const n: 1 | 2 = 1` does NOT compile.
    // Fill agreeing with that is the invariant working in both directions.
    const numeric = [
      "node main(): number {",
      "  const n: 1 | 2 = #n",
      "  return n",
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(numeric), { n: 1 })).toThrow(/expects/);
  });

  it("accepts an empty array for an array hole", () => {
    const list = [
      "node main(): string {",
      "  const xs: number[] = #xs",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(list, { xs: [] })).toContain("[]");
  });

  it("does not hang on a recursive alias", () => {
    const recursive = [
      "type Tree = {",
      "  value: number;",
      "  children: Tree[]",
      "}",
      "",
      "node main(): string {",
      "  const t: Tree = #tree",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(
      fillAndPrint(recursive, { tree: { value: 1, children: [{ value: 2, children: [] }] } }),
    ).toContain("value");
  });

  it("rejects a bad element inside a recursive alias, and terminates", () => {
    const recursive = [
      "type Tree = {",
      "  value: number;",
      "  children: Tree[]",
      "}",
      "",
      "node main(): string {",
      "  const t: Tree = #tree",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(recursive), { tree: { value: 1, children: [{ value: 2 }] } }),
    ).toThrow(/expects/);
  });

  it("still lets an unknowable fragment through", () => {
    expect(
      fillAndPrint(personTemplate, { person: _parseExpr("buildPerson()") }),
    ).toContain("buildPerson()");
  });

  it("still rejects a literal fragment of the wrong primitive", () => {
    const t = `node main() {\n  const prompt: string = #text\n  return prompt\n}\n`;
    expect(() => fillHoles(load(t), { text: _parseExpr("42") })).toThrow(/string/);
  });

  it("now rejects a literal fragment against an alias, which it could not before", () => {
    const aliased = [
      "type Name = string",
      "",
      "node main(): string {",
      "  const n: Name = #who",
      "  return n",
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(aliased), { who: _parseExpr("42") })).toThrow(/expects/);
  });

  it("checks a hole with an inline record annotation", () => {
    const inline = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main() {",
      "  f(#person: Person)",
      "}",
      "",
    ].join("\n");
    expect(() => fillHoles(load(inline), { person: { name: "A" } })).toThrow(/expects/);
    expect(fillAndPrint(inline, { person: { name: "A", age: 1 } })).toContain("A");
  });

  it("rejects null for a non-nullable hole and accepts it for a nullable one", () => {
    const strict = `node main() {\n  const s: string = #v\n  return s\n}\n`;
    expect(() => fillHoles(load(strict), { v: null })).toThrow(/expects/);
    const nullable = `node main() {\n  const s: string | null = #v\n  return "ok"\n}\n`;
    expect(fillAndPrint(nullable, { v: null })).toContain("null");
  });
});

describe("fill-time type checking: a type it cannot resolve is not checked", () => {
  // The rule that keeps this feature from rejecting ordinary templates.
  // An unknown alias resolves to itself, and a synthesized record compared
  // against it is not assignable — so without the guard, every one of
  // these templates would reject every record fill.

  it("accepts a record when the type comes from an import", () => {
    const imported = [
      'import { Person } from "./types.agency"',
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(imported, { person: { name: "A" } })).toContain("A");
  });

  it("accepts a record when the alias is declared inside a body", () => {
    const bodyAlias = [
      "node main(): string {",
      "  type Local = {",
      "    name: string;",
      "    age: number",
      "  }",
      "  const p: Local = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(bodyAlias, { person: { name: "A" } })).toContain("A");
  });

  it("accepts a record when an unresolved name is nested deep in the type", () => {
    const deep = [
      "type Person = {",
      "  name: string;",
      "  pet: Animal",
      "}",
      "",
      "node main(): string {",
      "  const p: Person = #person",
      '  return "ok"',
      "}",
      "",
    ].join("\n");
    expect(fillAndPrint(deep, { person: { name: "A" } })).toContain("A");
  });
});

describe("fill-time type checking: splices check one element at a time", () => {
  // A splice annotation describes ONE spliced element, not the array. This
  // is what the code already does; these tests make it deliberate.
  const spliceTemplate = `node main() {\n  f(#...items: string)\n}\n`;

  it("accepts an array whose every element matches", () => {
    expect(fillAndPrint(spliceTemplate, { items: ["a", "b"] })).toContain('f("a", "b")');
  });

  it("rejects the element that does not match", () => {
    expect(() => fillHoles(load(spliceTemplate), { items: ["a", 1] })).toThrow(/expects/);
  });

  it("checks record elements property by property", () => {
    const records = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main() {",
      "  f(#...people: Person)",
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(records), { people: [{ name: "A", age: 1 }, { name: "B" }] }),
    ).toThrow(/expects/);
  });

  it("rejects an array-typed splice annotation, which is the easy mistake", () => {
    const arrayAnnotated = [
      "type Person = {",
      "  name: string;",
      "  age: number",
      "}",
      "",
      "node main() {",
      "  f(#...people: Person[])",
      "}",
      "",
    ].join("\n");
    expect(() =>
      fillHoles(load(arrayAnnotated), { people: [{ name: "A", age: 1 }] }),
    ).toThrow();
  });
});
