import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

/** The names AG4014 reported for `source`, in order. */
function refused(source: string): string[] {
  return typecheckSource(source)
    .filter((error) => error.code === "AG4014")
    .map((error) => error.message.split("'")[1]);
}

const inNode = (statement: string) => `node main() {\n  ${statement}\n}\n`;

describe("AG4014: eval and Function are refused in every program", () => {
  it.each([
    ["a call to eval", inNode(`const x = eval("1 + 2")`), ["eval"]],
    ["eval as a value", inNode(`const run = eval`), ["eval"]],
    ["a property of what eval returns", inNode(`const n = eval("[1]").length`), ["eval"]],
    ["eval passed as an argument", inNode(`print(eval)`), ["eval"]],
    ["a call to Function", inNode(`const add = Function("return 1")`), ["Function"]],
    ["new Function", inNode(`const add = new Function("return 1")`), ["Function"]],
    ["a property of Function", inNode(`const proto = Function.prototype`), ["Function"]],
    ["eval on the global object", inNode(`const run = globalThis.eval`), ["globalThis.eval"]],
    ["a call to eval on the global object", inNode(`globalThis.eval("1")`), ["globalThis.eval"]],
    [
      "eval by string key on the global object",
      inNode(`const run = globalThis["eval"]`),
      ["globalThis.eval"],
    ],
    [
      "Function on the global object",
      inNode(`const make = globalThis.Function`),
      ["globalThis.Function"],
    ],
    ["eval on window", inNode(`const run = window.eval`), ["window.eval"]],
    ["the global object copied to a local", inNode(`const g = globalThis`), ["globalThis"]],
    ["the global object passed as an argument", inNode(`print(globalThis)`), ["globalThis"]],
    [
      "the global object read with a computed key",
      inNode(`const key = "ev" + "al"\n  const run = globalThis[key]`),
      ["globalThis"],
    ],
    [
      "constructor twice on a value",
      inNode(`const n = 1\n  const make = n.constructor.constructor`),
      [".constructor.constructor"],
    ],
    [
      "constructor twice by string key",
      inNode(`const n = 1\n  const make = n["constructor"]["constructor"]`),
      [".constructor.constructor"],
    ],
    [
      "a call to constructor of constructor",
      inNode(`const n = 1\n  const run = n.constructor.constructor("return 1")`),
      [".constructor.constructor"],
    ],
    ["eval inside an interpolated string", inNode('const s = "total: ${eval("1")}"'), ["eval"]],
    ["eval in a block argument", inNode(`map([1]) as n {\n    return eval("n")\n  }`), ["eval"]],
    ["eval at the top level", `const x = eval("1")\nnode main() {\n  print(x)\n}\n`, ["eval"]],
    [
      "eval in a default parameter value",
      `def f(xs: any[] = [eval("1")]) {\n  print(xs)\n}\n`,
      ["eval"],
    ],
    [
      "eval in a tag argument",
      `@jsonSchema({ example: eval("1") })\ntype P = {\n  n: number\n}\nnode main() {\n  print(1)\n}\n`,
      ["eval"],
    ],
    ["eval in a docstring", 'def f() {\n  """total is ${eval("1")}"""\n  print(1)\n}\n', ["eval"]],
  ])("refuses %s", (_name, source, expected) => {
    expect(refused(source)).toEqual(expected);
  });

  it("is an error, not a warning", () => {
    const errors = typecheckSource(inNode(`const x = eval("1")`)).filter(
      (error) => error.code === "AG4014",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
  });

  // The def makes the bare name `Function` the program's own. A member of
  // the global object is never the program's function.
  it("refuses Function on the global object in a program that defines Function", () => {
    const source = `def Function(): number {\n  return 1\n}\nnode main() {\n  const make = globalThis.Function\n  print(Function())\n}\n`;
    expect(refused(source)).toEqual(["globalThis.Function"]);
  });

  // `window`, `self`, and `global` are ordinary names a program may use for
  // its own values. Reading `.eval` from one is refused anyway: the check has
  // no types, and the real `window.eval` must not pass.
  it("refuses eval read from a local named window, on purpose", () => {
    expect(refused(inNode(`const window = { eval: 1 }\n  print(window.eval)`))).toEqual([
      "window.eval",
    ]);
  });

  it.each([
    ["a method named eval on a value", inNode(`const model = { name: "m" }\n  model.eval()`)],
    [
      "a property named Function on a value",
      inNode(`const o = { Function: 1 }\n  print(o.Function)`),
    ],
    ["a string that says eval", inNode(`print("eval this")`)],
    [
      "a def named Function",
      `def Function(): number {\n  return 1\n}\nnode main() {\n  print(Function())\n}\n`,
    ],
    ["one constructor on a value", inNode(`const n = 1\n  print(n.constructor)`)],
    [
      "a data key named constructor",
      inNode(`const o = { a: 1 }\n  print(o["constructor"].entries)`),
    ],
    ["another member of the global object", inNode(`print(globalThis.Math.max(1, 2))`)],
    ["a local named self", inNode(`const self = { name: "me" }\n  print(self.name)`)],
    ["a name that starts with eval", inNode(`const evaluate = 1\n  print(evaluate)`)],
  ])("accepts %s", (_name, source) => {
    expect(refused(source)).toEqual([]);
  });
});
