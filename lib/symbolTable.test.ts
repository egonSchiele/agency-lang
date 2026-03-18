import { describe, it, expect } from "vitest";
import { classifySymbols } from "./symbolTable.js";
import { parseAgency } from "./parser.js";

function parseAndClassify(source: string) {
  const result = parseAgency(source);
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
    expect(symbols.greet).toEqual({ kind: "node", name: "greet" });
  });

  it("classifies functions", () => {
    const symbols = parseAndClassify(`
def add(a: number, b: number) {
  return a + b
}
`);
    expect(symbols.add).toEqual({ kind: "function", name: "add" });
  });

  it("classifies type aliases", () => {
    const symbols = parseAndClassify(`
type Greeting = string
`);
    expect(symbols.Greeting).toEqual({ kind: "type", name: "Greeting" });
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
    expect(symbols.Config).toEqual({ kind: "type", name: "Config" });
    expect(symbols.helper).toEqual({ kind: "function", name: "helper" });
    expect(symbols.main).toEqual({ kind: "node", name: "main" });
  });

  it("finds type aliases nested inside functions", () => {
    const symbols = parseAndClassify(`
def myFunc() {
  type Inner = number
  return 1
}
`);
    expect(symbols.Inner).toEqual({ kind: "type", name: "Inner" });
    expect(symbols.myFunc).toEqual({ kind: "function", name: "myFunc" });
  });
});
