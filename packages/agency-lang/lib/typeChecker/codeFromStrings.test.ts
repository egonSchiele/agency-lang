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
    ["eval on the global object", inNode(`const run = globalThis.eval`), ["eval"]],
    ["a call to eval on the global object", inNode(`globalThis.eval("1")`), ["eval"]],
    ["eval by string key on the global object", inNode(`const run = globalThis["eval"]`), ["eval"]],
    ["Function on the global object", inNode(`const make = globalThis.Function`), ["Function"]],
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
    ["a name that starts with eval", inNode(`const evaluate = 1\n  print(evaluate)`)],
  ])("accepts %s", (_name, source) => {
    expect(refused(source)).toEqual([]);
  });
});
