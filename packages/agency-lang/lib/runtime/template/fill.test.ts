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

  it("rejects an expr fragment in a statements hole", () => {
    expect(() => fillHoles(load(stmtTemplate), { setup: _parseExpr("42") })).toThrow(
      /statements.*expr|expr.*statements/,
    );
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
