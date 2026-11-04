import { describe, expect, it } from "vitest";
import { allCodes, errorsWithCode } from "./castTestUtils.js";
import { asyncRefusals } from "./asyncChecks.js";
import { parseAgency } from "../parser.js";

const PRELUDE = `def f(n: number): string {
  return "a"
}

def r(): Result<string> {
  return success("a")
}

def take(s: string): string {
  return s
}

type Box = { name: string }
`;

const inMain = (body: string) => `${PRELUDE}node main() {\n${body}\n}\n`;
const count = (source: string, code: string) => errorsWithCode(source, code).length;
const ASYNC_CODES = [
  "AG1026",
  "AG1027",
  "AG1028",
  "AG1029",
  "AG1030",
  "AG1031",
  "AG1032",
  "AG1033",
];
const asyncCodes = (source: string) =>
  allCodes(source).filter((code) => ASYNC_CODES.includes(code));

describe("the type of an async call", () => {
  it("`let x = async f()` has f's return type", () => {
    // f returns string, so assigning x to a number is a mismatch.
    const source = inMain(
      `  let x = async f(1)\n  print("working")\n  const y: number = x\n  print(y)`,
    );
    const [error] = errorsWithCode(source, "AG2001");
    expect(error.message).toContain("'string' is not assignable to type 'number'");
    expect(error.message).toContain("'y'");
  });

  it("`let x = async f()` with a matching use reports nothing", () => {
    const source = inMain(
      `  let x = async f(1)\n  print("working")\n  const y: string = x\n  print(y)`,
    );
    expect(allCodes(source)).toEqual([]);
  });

  it("a declared type that does not match f's return type is refused", () => {
    const source = inMain(`  let x: number = async f(1)\n  print("working")\n  print(x)`);
    const [error] = errorsWithCode(source, "AG2001");
    expect(error.message).toContain("(assignment to 'x')");
  });

  it("the arguments are checked against f's parameters", () => {
    const source = inMain(`  let x = async f("no")\n  print("working")\n  print(x)`);
    expect(count(source, "AG6019")).toBe(1);
  });

  it("`async llm(...)` takes its type from the declared type", () => {
    // The declared number flows to x, so assigning x to a string is a
    // mismatch that names y.
    const source = inMain(
      `  let x: number = async llm("pick a number")\n  print("working")\n  const y: string = x\n  print(y)`,
    );
    const [error] = errorsWithCode(source, "AG2001");
    expect(error.message).toContain("'number' is not assignable to type 'string'");
    expect(error.message).toContain("'y'");
  });
});

describe("positions async cannot take", () => {
  it("AG1026: async inside an expression", () => {
    const source = inMain(`  const y = take(async f(1))\n  print(y)`);
    expect(asyncCodes(source)).toEqual(["AG1026"]);
  });

  it("AG1027: async at module level", () => {
    const source = `${PRELUDE}const g = async f(1)\nnode main() {\n  print(g)\n}\n`;
    expect(asyncCodes(source)).toEqual(["AG1027"]);
  });

  it("AG1028: async in a handler body", () => {
    const source = inMain(
      `  handle {\n    print("a")\n  } with (intr) {\n    async f(1)\n    print("b")\n    return approve()\n  }`,
    );
    expect(asyncCodes(source)).toEqual(["AG1028"]);
  });

  it("AG1029: async in a callback body", () => {
    const source = inMain(
      `  callback("onFunctionStart") as data {\n    async f(1)\n    print("cb")\n  }\n  print("x")`,
    );
    expect(asyncCodes(source)).toEqual(["AG1029"]);
  });

  it("AG1030: async as a direct arm of parallel", () => {
    const source = inMain(`  parallel {\n    async f(1)\n    let b = f(2)\n  }`);
    expect(asyncCodes(source)).toEqual(["AG1030"]);
  });

  it("AG1030 does not apply inside a seq arm", () => {
    const source = inMain(
      `  parallel {\n    seq {\n      async f(1)\n      print("x")\n    }\n    let b = f(2)\n  }`,
    );
    expect(asyncCodes(source)).toEqual([]);
  });

  it("AG1031: ? on the async call", () => {
    const source = `${PRELUDE}def h(): Result<string> {\n  let x = async r()?\n  print("a")\n  return success(x)\n}\nnode main() {\n  print(h())\n}\n`;
    expect(asyncCodes(source)).toEqual(["AG1031"]);
  });

  it("AG1032: async on something that is not a call", () => {
    const source = inMain(`  const v = 1\n  let x = async v\n  print("a")\n  print(x)`);
    expect(asyncCodes(source)).toEqual(["AG1032"]);
  });

  it("AG1033: a break nested inside the arm", () => {
    const source = inMain(
      `  for (i in [1, 2]) {\n    async f(i)\n    if (i == 1) {\n      break\n    }\n    print(i)\n  }`,
    );
    const errors = errorsWithCode(source, "AG1033");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("`break`");
  });

  it("AG1033: a continue nested inside the arm", () => {
    const source = inMain(
      `  for (i in [1, 2]) {\n    async f(i)\n    if (i == 1) {\n      continue\n    }\n    print(i)\n  }`,
    );
    const errors = errorsWithCode(source, "AG1033");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("`continue`");
  });

  it("AG1033: a goto nested inside the arm", () => {
    const source = `${PRELUDE}node other() {\n  print("o")\n}\nnode main() {\n  async f(1)\n  if (true) {\n    goto other()\n  }\n  print("x")\n}\n`;
    const errors = errorsWithCode(source, "AG1033");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("`goto`");
  });

  it("AG1033 does not apply to an exit after the join", () => {
    // x is used on the line before the if, so the arm ends there and the
    // break is not inside it.
    const source = inMain(
      `  for (i in [1, 2]) {\n    let x = async f(i)\n    print(x)\n    if (i == 1) {\n      break\n    }\n  }`,
    );
    expect(asyncCodes(source)).toEqual([]);
  });

  it("is reported from the tree alone, without the type checker", () => {
    // The compile path calls asyncRefusals even when the checker is off.
    const parsed = parseAgency(inMain(`  const y = take(async f(1))\n  print(y)`), {}, false);
    if (!parsed.success) throw new Error(parsed.message);
    const codes = asyncRefusals(parsed.result.nodes).map((error) => error.code);
    expect(codes).toEqual(["AG1026"]);
  });
});

describe("async positions that are allowed", () => {
  it("`async f() with approve` as a statement", () => {
    expect(allCodes(inMain(`  async f(1) with approve\n  print("a")`))).toEqual([]);
  });

  it("`let x = async f() with approve`", () => {
    expect(allCodes(inMain(`  let x = async f(1) with approve\n  print("a")\n  print(x)`))).toEqual(
      [],
    );
  });

  it("an async method call", () => {
    const source = inMain(
      `  const box: Box = { name: "a" }\n  let x = async box.name.toUpperCase()\n  print("a")\n  print(x)`,
    );
    expect(allCodes(source)).toEqual([]);
  });

  it("a top-level break right after the async in a loop body", () => {
    // The join moves to just before the break, so the break is not in the arm.
    const source = inMain(`  for (i in [1, 2]) {\n    async f(i)\n    print(i)\n    break\n  }`);
    expect(allCodes(source)).toEqual([]);
  });

  it("a top-level continue right after the async in a loop body", () => {
    const source = inMain(`  for (i in [1, 2]) {\n    async f(i)\n    print(i)\n    continue\n  }`);
    expect(allCodes(source)).toEqual([]);
  });

  it("a break inside a loop that is itself inside the arm", () => {
    const source = inMain(
      `  async f(1)\n  for (i in [1, 2]) {\n    if (i == 2) {\n      break\n    }\n    print(i)\n  }`,
    );
    expect(allCodes(source)).toEqual([]);
  });

  it("a break inside a while loop that is inside the arm", () => {
    const source = inMain(
      `  async f(1)\n  let n = 0\n  while (n < 3) {\n    n = n + 1\n    if (n == 2) {\n      break\n    }\n  }\n  print(n)`,
    );
    expect(allCodes(source)).toEqual([]);
  });
});
