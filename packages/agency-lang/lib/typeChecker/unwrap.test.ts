import { describe, expect, it } from "vitest";
import { allCodes, errorsWithCode } from "./castTestUtils.js";

const PRELUDE = `
type Named = Result<string>

def parseName(text: string): Result<string> {
  if (text == "") {
    return failure("empty")
  }
  return success(text)
}

def parseNamed(text: string): Named {
  return parseName(text)
}

def plainName(): string {
  return "bob"
}
`;

const wrap = (body: string) =>
  `${PRELUDE}def main(): Result<string> {\n${body}\n  return success("ok")\n}\n`;
const count = (body: string, code: string) => errorsWithCode(wrap(body), code).length;

describe("typing the ? operator", () => {
  it("the success value flows out of ?", () => {
    expect(allCodes(wrap(`  const n: string = parseName("x")?`))).toEqual([]);
  });

  it("? on a non-Result is AG2023", () => {
    expect(count(`  const n = plainName()?`, "AG2023")).toBe(1);
  });

  it("old optional chaining on an object is AG2023", () => {
    expect(count(`  const o = { name: "a" }\n  const n = o?.name`, "AG2023")).toBe(1);
  });

  it("? on any is any", () => {
    expect(allCodes(wrap(`  const a: any = 1\n  const n = a?`))).toEqual([]);
  });

  it("the chain continues with the unwrapped type", () => {
    expect(allCodes(wrap(`  const n: number = parseName("x")?.length`))).toEqual([]);
  });

  it("a Result alias unwraps", () => {
    expect(allCodes(wrap(`  const n: string = parseNamed("x")?`))).toEqual([]);
  });

  it("? on an async call is AG2023: the handle is not a Result", () => {
    expect(count(`  const n = async parseName("x")?`, "AG2023")).toBe(1);
  });

  it("names the expression and its type in the message", () => {
    const [error] = errorsWithCode(wrap(`  const n = plainName()?`), "AG2023");
    expect(error.message).toContain("`plainName()?` needs a `Result`");
    expect(error.message).toContain("`plainName()` is a `string`");
  });
});
