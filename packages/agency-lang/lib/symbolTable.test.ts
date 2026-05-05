import { describe, it, expect } from "vitest";
import { classifySymbols } from "./symbolTable.js";
import { parseAgency } from "./parser.js";

function parseAndClassify(source: string) {
  const result = parseAgency(source, {}, false);
  if (!result.success) throw new Error("Parse failed");
  return classifySymbols(result.result);
}

describe("classifySymbols", () => {
  it("classifies graph nodes", () => {
    const symbols = parseAndClassify(`
node greet(name: string) {
  return "hi"
}
`);
    expect(symbols.greet).toMatchObject({
      kind: "node",
      name: "greet",
      loc: { col: 0, end: 43, line: 1, start: 1 },
    });
  });

  it("classifies functions", () => {
    const symbols = parseAndClassify(`
def add(a: number, b: number) {
  return a + b
}
`);
    const add = symbols.add;
    expect(add).toMatchObject({ kind: "function", name: "add" });
    if (add.kind !== "function") throw new Error("expected function");
    expect(add.parameters).toHaveLength(2);
  });

  it("classifies type aliases", () => {
    const symbols = parseAndClassify(`
type Greeting = string
`);
    expect(symbols.Greeting).toMatchObject({ kind: "type", name: "Greeting" });
  });

  it("classifies multiple symbols from one file", () => {
    const symbols = parseAndClassify(`
type Config = { model: string }

def helper() {
  return 1
}

node main() {
  return helper()
}
`);
    expect(symbols.Config).toMatchObject({ kind: "type", name: "Config" });
    expect(symbols.helper).toMatchObject({ kind: "function", name: "helper" });
    expect(symbols.main).toMatchObject({
      kind: "node",
      name: "main",
      loc: { col: 0, end: 96, line: 7, start: 63 },
    });
  });

  it("finds type aliases nested inside functions", () => {
    const symbols = parseAndClassify(`
def myFunc() {
  type Inner = number
  return 1
}
`);
    expect(symbols.Inner).toMatchObject({ kind: "type", name: "Inner" });
    expect(symbols.myFunc).toMatchObject({ kind: "function", name: "myFunc" });
  });
});
