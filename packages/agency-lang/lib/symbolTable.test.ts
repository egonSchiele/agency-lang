import { describe, it, expect } from "vitest";
import { classifySymbols, SymbolTable } from "./symbolTable.js";
import { parseAgency } from "./parser.js";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

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

describe("SymbolTable interrupt analysis", () => {
  it("populates interruptKinds on function and node symbols", () => {
    const file = path.join(os.tmpdir(), `st-int-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`);
    writeFileSync(
      file,
      `
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def orchestrate() {
        deploy()
      }
      node main() {
        orchestrate()
      }
    `,
    );
    try {
      const st = SymbolTable.build(file);
      const symbols = st.getFile(path.resolve(file))!;
      expect(symbols).toBeDefined();
      expect(symbols["deploy"]).toMatchObject({
        kind: "function",
        interruptKinds: [{ kind: "myapp::deploy" }],
      });
      expect(symbols["orchestrate"]).toMatchObject({
        kind: "function",
        interruptKinds: [{ kind: "myapp::deploy" }],
      });
      expect(symbols["main"]).toMatchObject({
        kind: "node",
        interruptKinds: [{ kind: "myapp::deploy" }],
      });
    } finally {
      unlinkSync(file);
    }
  });

  it("propagates interrupt kinds across imported files", () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const libFile = path.join(os.tmpdir(), `st-lib-${suffix}.agency`);
    const mainFile = path.join(os.tmpdir(), `st-main-${suffix}.agency`);
    writeFileSync(
      libFile,
      `
      export def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
    `,
    );
    writeFileSync(
      mainFile,
      `
      import { deploy } from "${libFile}"
      node main() {
        deploy()
      }
    `,
    );
    try {
      const st = SymbolTable.build(mainFile);
      const mainSymbols = st.getFile(path.resolve(mainFile))!;
      const libSymbols = st.getFile(path.resolve(libFile))!;
      expect(libSymbols["deploy"].kind).toBe("function");
      expect((libSymbols["deploy"] as any).interruptKinds).toEqual([{ kind: "myapp::deploy" }]);
      expect(mainSymbols["main"].kind).toBe("node");
      expect((mainSymbols["main"] as any).interruptKinds).toEqual([{ kind: "myapp::deploy" }]);
    } finally {
      unlinkSync(mainFile);
      unlinkSync(libFile);
    }
  });

  it("propagates interrupt kinds through aliased imports", () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const libFile = path.join(os.tmpdir(), `st-lib-alias-${suffix}.agency`);
    const mainFile = path.join(os.tmpdir(), `st-main-alias-${suffix}.agency`);
    writeFileSync(libFile, `
      export def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
    `);
    writeFileSync(mainFile, `
      import { deploy as d } from "${libFile}"
      node main() {
        d()
      }
    `);
    try {
      const st = SymbolTable.build(mainFile);
      const mainSymbols = st.getFile(path.resolve(mainFile))!;
      expect(mainSymbols["main"].kind).toBe("node");
      expect((mainSymbols["main"] as any).interruptKinds).toEqual([{ kind: "myapp::deploy" }]);
    } finally {
      unlinkSync(mainFile);
      unlinkSync(libFile);
    }
  });

  it("propagates interrupt kinds through imported nodes", () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const libFile = path.join(os.tmpdir(), `st-lib-node-${suffix}.agency`);
    const mainFile = path.join(os.tmpdir(), `st-main-node-${suffix}.agency`);
    writeFileSync(libFile, `
      export node checkout() {
        interrupt payment::charge("Charge?")
      }
    `);
    writeFileSync(mainFile, `
      import node { checkout } from "${libFile}"
      node main() {
        return checkout()
      }
    `);
    try {
      const st = SymbolTable.build(mainFile);
      const mainSymbols = st.getFile(path.resolve(mainFile))!;
      expect(mainSymbols["main"].kind).toBe("node");
      expect((mainSymbols["main"] as any).interruptKinds).toEqual([{ kind: "payment::charge" }]);
    } finally {
      unlinkSync(mainFile);
      unlinkSync(libFile);
    }
  });
});
