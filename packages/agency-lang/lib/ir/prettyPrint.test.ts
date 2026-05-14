import { describe, it, expect } from "vitest";
import { ts } from "./builders.js";
import { printTs } from "./prettyPrint.js";

describe("prettyPrint", () => {
  it("TsRaw passes through verbatim", () => {
    expect(printTs(ts.raw("console.log('hello');"))).toBe(
      "console.log('hello');",
    );
  });

  it("TsIdentifier", () => {
    expect(printTs(ts.id("foo"))).toBe("foo");
  });

  it("TsStringLiteral", () => {
    expect(printTs(ts.str("hello"))).toBe('"hello"');
  });

  it("TsNumericLiteral", () => {
    expect(printTs(ts.num(42))).toBe("42");
  });

  it("TsBooleanLiteral", () => {
    expect(printTs(ts.bool(true))).toBe("true");
    expect(printTs(ts.bool(false))).toBe("false");
  });

  it("TsCall with nested args", () => {
    const node = ts.call(ts.id("foo"), [
      ts.str("bar"),
      ts.call(ts.id("baz"), [ts.num(1)]),
    ]);
    expect(printTs(node)).toBe('foo("bar", baz(1))');
  });

  it("TsAwait", () => {
    expect(printTs(ts.await(ts.call(ts.id("fetch"), [ts.str("url")])))).toBe(
      'await fetch("url")',
    );
  });

  it("TsReturn with expr", () => {
    expect(printTs(ts.return(ts.num(42)))).toBe("return 42;");
  });

  it("TsReturn without expr", () => {
    expect(printTs(ts.return())).toBe("return;");
  });

  it("TsVarDecl const with initializer", () => {
    expect(printTs(ts.constDecl("x", ts.num(5)))).toBe("const x = 5;");
  });

  it("TsVarDecl with type annotation", () => {
    expect(printTs(ts.letDecl("x", undefined, "number"))).toBe(
      "let x: number;",
    );
  });

  it("TsAssign", () => {
    expect(printTs(ts.assign(ts.id("x"), ts.num(10)))).toBe("x = 10;");
  });

  it("TsObjectLiteral empty", () => {
    expect(printTs(ts.obj([]))).toBe("{}");
  });

  it("TsObjectLiteral with entries and spread", () => {
    const node = ts.obj([
      { spread: false, key: "a", value: ts.num(1) },
      { spread: true, expr: ts.id("rest") },
    ]);
    expect(printTs(node)).toBe("{\n  a: 1,\n  ...rest\n}");
  });

  it("TsArrayLiteral", () => {
    expect(printTs(ts.arr([ts.num(1), ts.num(2), ts.num(3)]))).toBe(
      "[1, 2, 3]",
    );
  });

  it("TsArrayLiteral empty", () => {
    expect(printTs(ts.arr([]))).toBe("[]");
  });

  it("TsSpread", () => {
    expect(printTs(ts.spread(ts.id("args")))).toBe("...args");
  });

  it("TsBinOp", () => {
    expect(printTs(ts.binOp(ts.id("a"), "+", ts.id("b")))).toBe("a + b");
  });

  it("TsBinOp unary not", () => {
    expect(printTs(ts.binOp(ts.bool(true), "!", ts.id("x")))).toBe("!x");
  });

  it("TsBinOp unary not with parens", () => {
    expect(
      printTs(
        ts.binOp(ts.bool(true), "!", ts.binOp(ts.id("a"), "&&", ts.id("b")), {
          parenRight: true,
        }),
      ),
    ).toBe("!(a && b)");
  });

  it("TsPropertyAccess dot", () => {
    expect(printTs(ts.prop(ts.id("obj"), "foo"))).toBe("obj.foo");
  });

  it("TsPropertyAccess computed", () => {
    expect(printTs(ts.index(ts.id("arr"), ts.num(0)))).toBe("arr[0]");
  });

  it("TsFunctionDecl basic", () => {
    const fn = ts.functionDecl(
      "greet",
      [{ name: "name", typeAnnotation: "string" }],
      ts.return(ts.id("name")),
    );
    expect(printTs(fn)).toBe(
      "function greet(name: string) {\n  return name;\n}",
    );
  });

  it("TsFunctionDecl async export", () => {
    const fn = ts.functionDecl(
      "fetchData",
      [],
      ts.statements([ts.return(ts.call(ts.id("fetch"), []))]),
      { async: true, export: true },
    );
    expect(printTs(fn)).toBe(
      "export async function fetchData() {\n  return fetch();\n}",
    );
  });

  it("TsArrowFn expression body", () => {
    const fn = ts.arrowFn(
      [{ name: "x" }],
      ts.binOp(ts.id("x"), "+", ts.num(1)),
    );
    expect(printTs(fn)).toBe("(x) => x + 1");
  });

  it("TsArrowFn block body", () => {
    const fn = ts.arrowFn(
      [{ name: "x" }],
      ts.statements([ts.return(ts.binOp(ts.id("x"), "+", ts.num(1)))]),
    );
    expect(printTs(fn)).toBe("(x) => {\n  return x + 1;\n}");
  });

  it("TsArrowFn async", () => {
    const fn = ts.arrowFn([], ts.call(ts.id("fetch"), []), { async: true });
    expect(printTs(fn)).toBe("async () => fetch()");
  });

  it("TsIf simple", () => {
    const node = ts.if(ts.id("x"), ts.return(ts.num(1)));
    expect(printTs(node)).toBe("if (x) {\n  return 1;\n}");
  });

  it("TsIf with else-if chain", () => {
    const node = ts.if(
      ts.binOp(ts.id("x"), ">", ts.num(0)),
      ts.return(ts.str("positive")),
      {
        elseIfs: [
          {
            condition: ts.binOp(ts.id("x"), "<", ts.num(0)),
            body: ts.return(ts.str("negative")),
          },
        ],
        elseBody: ts.return(ts.str("zero")),
      },
    );
    const expected = [
      "if (x > 0) {",
      '  return "positive";',
      "} else if (x < 0) {",
      '  return "negative";',
      "} else {",
      '  return "zero";',
      "}",
    ].join("\n");
    expect(printTs(node)).toBe(expected);
  });

  it("TsFor of", () => {
    const node = ts.forOf(
      "item",
      ts.id("items"),
      ts.call(ts.prop(ts.id("console"), "log"), [ts.id("item")]),
    );
    expect(printTs(node)).toBe(
      "for (const item of items) {\n  console.log(item)\n}",
    );
  });

  it("TsFor c-style", () => {
    const node = ts.forC(
      ts.letDecl("i", ts.num(0)),
      ts.binOp(ts.id("i"), "<", ts.num(10)),
      ts.assign(ts.id("i"), ts.binOp(ts.id("i"), "+", ts.num(1))),
      ts.call(ts.prop(ts.id("console"), "log"), [ts.id("i")]),
    );
    expect(printTs(node)).toBe(
      "for (let i = 0; i < 10; i = i + 1) {\n  console.log(i)\n}",
    );
  });

  it("TsWhile", () => {
    const node = ts.while(ts.bool(true), ts.raw("break;"));
    expect(printTs(node)).toBe("while (true) {\n  break;\n}");
  });

  it("TsSwitch with cases and default", () => {
    const node = ts.switch(ts.id("x"), [
      {
        test: ts.num(1),
        body: ts.statements([ts.raw("doA();"), ts.raw("break;")]),
      },
      { test: ts.num(2), body: ts.raw("break;") },
      { test: undefined, body: ts.raw("break;") },
    ]);
    const expected = [
      "switch (x) {",
      "  case 1:",
      "    doA();",
      "    break;",
      "  case 2:",
      "    break;",
      "  default:",
      "    break;",
      "}",
    ].join("\n");
    expect(printTs(node)).toBe(expected);
  });

  it("TsTryCatch", () => {
    const node = ts.tryCatch(
      ts.call(ts.id("riskyOp"), []),
      ts.call(ts.prop(ts.id("console"), "error"), [ts.id("e")]),
      "e",
    );
    expect(printTs(node)).toBe(
      "try {\n  riskyOp()\n} catch (e) {\n  console.error(e)\n}",
    );
  });

  it("TsTemplateLit with interpolations", () => {
    const node = ts.template([
      { text: "Hello, ", expr: ts.id("name") },
      { text: "! You are ", expr: ts.id("age") },
      { text: " years old." },
    ]);
    expect(printTs(node)).toBe("`Hello, ${name}! You are ${age} years old.`");
  });

  it("TsTemplateLit escapes backticks in text so the template stays open", () => {
    // A literal `` ` `` in a template literal must be escaped as `` \` ``,
    // otherwise it would terminate the template. Caller passes raw text.
    const node = ts.template([{ text: "```json" }]);
    expect(printTs(node)).toBe("`\\`\\`\\`json`");
  });

  it("TsTemplateLit escapes ${ so it doesn't open an interpolation", () => {
    // A literal `${` would otherwise be interpreted as the start of an
    // interpolation by the JS template literal parser.
    const node = ts.template([{ text: "price: ${5}" }]);
    expect(printTs(node)).toBe("`price: \\${5}`");
  });

  it("TsTemplateLit passes backslash escape sequences through unmodified", () => {
    // Agency relies on JS template-literal escape interpretation at runtime,
    // so `\n`, `\t`, etc. must reach the output verbatim (NOT be re-escaped
    // to `\\n`, which would print a literal backslash + n).
    const node = ts.template([{ text: "line1\\nline2" }]);
    // The JS string literal `"line1\\nline2"` is the 12 chars
    // `l i n e 1 \ n l i n e 2`. The template printer should emit them as-is.
    expect(printTs(node)).toBe("`line1\\nline2`");
  });

  it("TsComment line", () => {
    expect(printTs(ts.comment("TODO: fix this"))).toBe("// TODO: fix this");
  });

  it("TsComment block", () => {
    expect(printTs(ts.comment("multi-line", true))).toBe("/* multi-line */");
  });

  it("TsExport declaration", () => {
    const node = ts.export(ts.constDecl("x", ts.num(1)));
    expect(printTs(node)).toBe("export const x = 1;");
  });

  it("TsExport names", () => {
    const node = ts.export(undefined, ["foo", "bar"]);
    expect(printTs(node)).toBe("export { foo, bar };");
  });

  it("TsNewExpr", () => {
    const node = ts.new(ts.id("Map"), []);
    expect(printTs(node)).toBe("new Map()");
  });

  it("TsImport named", () => {
    const node = ts.importDecl({
      importKind: "named",
      names: ["foo", "bar"],
      from: "./mod",
    });
    expect(printTs(node)).toBe('import { foo, bar } from "./mod";');
  });

  it("TsImport default", () => {
    const node = ts.importDecl({
      importKind: "default",
      defaultName: "React",
      from: "react",
    });
    expect(printTs(node)).toBe('import React from "react";');
  });

  it("TsImport namespace", () => {
    const node = ts.importDecl({
      importKind: "namespace",
      namespaceName: "path",
      from: "path",
    });
    expect(printTs(node)).toBe('import * as path from "path";');
  });

  it("TsImport type", () => {
    const node = ts.importDecl({
      importKind: "type",
      names: ["Foo"],
      from: "./types",
    });
    expect(printTs(node)).toBe('import type { Foo } from "./types";');
  });

  it("TsStatements", () => {
    const node = ts.statements([
      ts.constDecl("x", ts.num(1)),
      ts.constDecl("y", ts.num(2)),
    ]);
    expect(printTs(node)).toBe("const x = 1;\nconst y = 2;");
  });

  it("nested: call inside object inside function", () => {
    const fn = ts.functionDecl(
      "build",
      [],
      ts.return(
        ts.obj([
          {
            spread: false,
            key: "result",
            value: ts.call(ts.id("compute"), [ts.num(42)]),
          },
        ]),
      ),
    );
    const expected = [
      "function build() {",
      "  return {",
      "    result: compute(42)",
      "  };",
      "}",
    ].join("\n");
    expect(printTs(fn)).toBe(expected);
  });

  it("param with default value", () => {
    const fn = ts.functionDecl(
      "greet",
      [
        {
          name: "name",
          typeAnnotation: "string",
          defaultValue: ts.str("world"),
        },
      ],
      ts.return(ts.id("name")),
    );
    expect(printTs(fn)).toBe(
      'function greet(name: string = "world") {\n  return name;\n}',
    );
  });

  it("TsScopedVar global with moduleId", () => {
    expect(printTs(ts.scopedVar("x", "global", "test.agency"))).toBe(
      '__ctx.globals.get("test.agency", "x")',
    );
  });

  it("TsScopedVar global without moduleId throws", () => {
    expect(() => printTs(ts.scopedVar("x", "global"))).toThrow();
  });

  it("TsScopedVar function", () => {
    expect(printTs(ts.scopedVar("count", "function"))).toBe(
      "__stack.locals.count",
    );
  });

  it("TsScopedVar node", () => {
    expect(printTs(ts.scopedVar("result", "node"))).toBe(
      "__stack.locals.result",
    );
  });

  it("TsScopedVar args", () => {
    expect(printTs(ts.scopedVar("name", "args"))).toBe("__stack.args.name");
  });

  it("TsScopedVar imported", () => {
    expect(printTs(ts.scopedVar("helper", "imported"))).toBe("helper");
  });

  it("TsScopedVar functionRef", () => {
    expect(printTs(ts.scopedVar("greet", "functionRef"))).toBe("greet");
  });

});
