import { describe, expect, it } from "vitest";
import { inputNames, parseTypeText, printType } from "./typeText.js";

const inputs = (text: string) => parseTypeText("Inputs", text, "inputs");
const output = (text: string) => parseTypeText("Output", text, "output");
const messageOf = (result: ReturnType<typeof parseTypeText>) =>
  "message" in result ? result.message : null;

describe("parseTypeText", () => {
  it("accepts an object type and prints it canonically", () => {
    const parsed = inputs("{noteTitle:string,   count?: number}");
    expect("alias" in parsed && printType(parsed.alias)).toBe(
      "type Inputs = {\n  noteTitle: string;\n  count?: number\n}",
    );
  });

  it("carries the parser's message when the text does not parse", () => {
    expect(messageOf(inputs("{ a: "))).toMatch(/^inputs must be one object type: .+/);
  });

  it("refuses text that carries a second declaration", () => {
    expect(messageOf(inputs("{ a: string }\nexport node evil() { return 1 }"))).toBe(
      "inputs must be one object type",
    );
    expect(messageOf(output("string[]\nexport node evil() {}"))).toBe("output must be one type");
  });

  it("refuses text that carries an import", () => {
    expect(messageOf(inputs('{ a: string }\nimport { x } from "./x.agency"'))).toBe(
      "inputs must be one object type",
    );
  });

  it("refuses inputs that are not an object type, and accepts any single output type", () => {
    expect(messageOf(inputs("string"))).toBe("inputs must be one object type");
    expect(messageOf(output("string[]"))).toBe(null);
  });

  it("refuses a @validate tag on a property", () => {
    expect(messageOf(output("{\n  @validate(addListItems)\n  x: string\n}"))).toBe(
      "a type in output may not carry @validate or @jsonSchema tags",
    );
  });

  it("refuses a @jsonSchema tag, nested or not", () => {
    expect(messageOf(inputs("{\n  @jsonSchema({ minimum: 1 })\n  n: number\n}"))).toBe(
      "a type in inputs may not carry @validate or @jsonSchema tags",
    );
    expect(messageOf(inputs("{ a: {\n  @jsonSchema({ minimum: 1 })\n  n: number\n} }"))).toBe(
      "a type in inputs may not carry @validate or @jsonSchema tags",
    );
  });

  it("refuses a backslash or a line break in a string literal type", () => {
    expect(messageOf(inputs('{ a: "x\\" }'))).toBe(
      "a string literal type in inputs may not hold a backslash or a line break",
    );
    expect(messageOf(output('"a\\" | "b"'))).toBe(
      "a string literal type in output may not hold a backslash or a line break",
    );
    expect(messageOf(inputs('{ mode: "fast" | "slow" }'))).toBe(null);
  });

  it("refuses string literal text that would escape its quotes in the compiled program", () => {
    const text =
      '{ noteTitle: string, a: "x\\", in: " + (globalThis.PWNED = 1) + ", instanceof: ") }) //" }';
    expect(messageOf(inputs(text))).toBe(
      "a string literal type in inputs may not hold a backslash or a line break",
    );
  });
});

describe("inputNames", () => {
  it("reads the top-level property names only", () => {
    expect(inputNames("{ a: { noteTitle: string }, b?: number }")).toEqual(["a", "b"]);
  });

  it("ignores a colon inside a string literal type", () => {
    expect(inputNames('{ mode: "a:b" | "c", n?: number }')).toEqual(["mode", "n"]);
  });

  it("is empty for text that is not an object type", () => {
    expect(inputNames("string")).toEqual([]);
    expect(inputNames("{ a: ")).toEqual([]);
  });
});
