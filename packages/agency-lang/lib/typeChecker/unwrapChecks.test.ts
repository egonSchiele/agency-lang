import { describe, expect, it } from "vitest";
import { allCodes, errorsWithCode } from "./castTestUtils.js";

const PRELUDE = `
effect test::ask { n: number }

def parseName(text: string): Result<string> {
  if (text == "") {
    return failure("empty")
  }
  return success(text)
}

def ask(n: number): Result<number> {
  interrupt test::ask("ok?", { n: n })
  return success(n)
}

def use(value: any): any {
  return value
}
`;

const inMain = (body: string) =>
  `${PRELUDE}node main(): Result<string> {\n  const a: any = 1\n${body}\n  return success("ok")\n}\n`;
const count = (source: string, code: string) => errorsWithCode(source, code).length;

describe("AG2024: the enclosing function must be able to return a failure", () => {
  it("a def declared to return string cannot use ?", () => {
    const source = `${PRELUDE}def f(): string {\n  return parseName("x")?\n}\n`;
    expect(count(source, "AG2024")).toBe(1);
  });

  it("a def declared to return Result may", () => {
    const source = `${PRELUDE}def f(): Result<string> {\n  return success(parseName("x")?)\n}\n`;
    expect(count(source, "AG2024")).toBe(0);
  });

  it("a def declared to return string | Result may", () => {
    const source = `${PRELUDE}def f(): string | Result<string> {\n  return parseName("x")?\n}\n`;
    expect(count(source, "AG2024")).toBe(0);
  });

  it("a def with no declared return type is not checked", () => {
    const source = `${PRELUDE}def f() {\n  return parseName("x")?\n}\n`;
    expect(count(source, "AG2024")).toBe(0);
  });

  it("? inside a block argument is not checked against the def", () => {
    const source = `${PRELUDE}def f(): string {\n  const xs = map([1]) as x {\n    return parseName("a")?\n  }\n  return "ok"\n}\n`;
    expect(count(source, "AG2024")).toBe(0);
  });

  it("names the function and its declared type", () => {
    const source = `${PRELUDE}def f(): string {\n  return parseName("x")?\n}\n`;
    const [error] = errorsWithCode(source, "AG2024");
    expect(error.message).toContain("returns a failure from `f`");
    expect(error.message).toContain("declared to return `string`");
  });
});

describe("AG1021: positions the hoist pass cannot lower", () => {
  it.each([
    'a && parseName("x")?',
    'a ?? parseName("x")?',
    'parseName("x")? catch ""',
    'parseName("x") catch parseName("y")?',
    'success(1) |> use(parseName("x")?)',
    'try parseName("x")?',
  ])("refuses %s", (expr) => {
    expect(count(inMain(`  const r = ${expr}`), "AG1021")).toBe(1);
  });

  it("its own line is fine", () => {
    expect(count(inMain(`  const r = parseName("x")?`), "AG1021")).toBe(0);
  });

  it("under with approve is fine", () => {
    expect(count(inMain(`  const r = ask(1)? with approve`), "AG1021")).toBe(0);
  });

  it("the message names the expression", () => {
    const [error] = errorsWithCode(inMain(`  const r = a && parseName("x")?`), "AG1021");
    // expressionToString prints string literals without quotes.
    expect(error.message).toContain("`parseName(x)?` cannot be lowered");
  });
});

describe("AG1022: outside every body", () => {
  it("a module-level initializer", () => {
    const source = `${PRELUDE}const top = parseName("x")?\nnode main() {\n  return top\n}\n`;
    expect(count(source, "AG1022")).toBe(1);
  });

  it("a parameter default", () => {
    // A default is a literal; an array literal may hold any expression.
    const source = `${PRELUDE}def f(names: any = [parseName("x")?]): any {\n  return names\n}\n`;
    expect(count(source, "AG1022")).toBe(1);
  });
});

describe("AG1023: a handler body", () => {
  it("refuses ? inside with (intr) { ... }", () => {
    const source = inMain(
      `  handle {\n    use(1)\n  } with (intr) {\n    const r = parseName("x")?\n    return approve()\n  }`,
    );
    expect(count(source, "AG1023")).toBe(1);
  });
});

describe("AG1024: a parallel arm", () => {
  it("refuses ? at the top level of an arm", () => {
    const source = inMain(
      `  parallel {\n    const p = parseName("x")?\n    const q = parseName("y")\n  }`,
    );
    expect(count(source, "AG1024")).toBe(1);
  });

  it("allows ? inside a block argument in an arm", () => {
    const source = inMain(
      `  parallel {\n    const p = map([1]) as n {\n      return parseName("x")?\n    }\n    const q = parseName("y")\n  }`,
    );
    expect(count(source, "AG1024")).toBe(0);
  });
});

describe("AG1025: an assignment target", () => {
  it("refuses obj?.field = 1", () => {
    expect(count(inMain(`  let o: any = {}\n  o?.field = 1`), "AG1025")).toBe(1);
  });
});

describe("a clean program", () => {
  it("reports nothing", () => {
    expect(
      allCodes(inMain(`  const r = parseName("x")?\n  const s = ask(2)? with approve`)),
    ).toEqual([]);
  });
});
