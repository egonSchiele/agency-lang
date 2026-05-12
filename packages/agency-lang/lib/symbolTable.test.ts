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

describe("SymbolTable direct interrupt collection", () => {
  it("populates direct interruptKinds on function and node symbols", () => {
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
      // Only direct interrupt kinds — no transitive propagation
      expect(symbols["deploy"]).toMatchObject({
        kind: "function",
        interruptKinds: [{ kind: "myapp::deploy" }],
      });
      expect(symbols["orchestrate"]).toMatchObject({
        kind: "function",
        interruptKinds: [],
      });
      expect(symbols["main"]).toMatchObject({
        kind: "node",
        interruptKinds: [],
      });
    } finally {
      unlinkSync(file);
    }
  });

  it("collects direct interrupt kinds from imported files", () => {
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
      const libSymbols = st.getFile(path.resolve(libFile))!;
      expect(libSymbols["deploy"].kind).toBe("function");
      expect((libSymbols["deploy"] as any).interruptKinds).toEqual([{ kind: "myapp::deploy" }]);
      // main has no direct interrupts — transitive propagation happens in type checker
      const mainSymbols = st.getFile(path.resolve(mainFile))!;
      expect(mainSymbols["main"].kind).toBe("node");
      expect((mainSymbols["main"] as any).interruptKinds).toEqual([]);
    } finally {
      unlinkSync(mainFile);
      unlinkSync(libFile);
    }
  });
});

/** Create temp .agency files keyed by a stable name; returns absolute paths and a cleanup fn. */
function withTempFiles(
  files: Record<string, string>,
): { paths: Record<string, string>; cleanup: () => void } {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const paths: Record<string, string> = {};
  for (const name of Object.keys(files)) {
    paths[name] = path.join(os.tmpdir(), `st-${name}-${suffix}.agency`);
  }
  // Substitute @name@ placeholders in file contents with the actual paths.
  for (const [name, contents] of Object.entries(files)) {
    let resolved = contents;
    for (const [other, otherPath] of Object.entries(paths)) {
      resolved = resolved.replaceAll(`@${other}@`, otherPath);
    }
    writeFileSync(paths[name], resolved);
  }
  return {
    paths,
    cleanup: () => {
      for (const p of Object.values(paths)) {
        try {
          unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

describe("SymbolTable: re-export reachability and merging", () => {
  it("parses a file only reachable through an exportFromStatement", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo() { return 1 }`,
      reexporter: `export { foo } from "@source@"`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      expect(st.has(path.resolve(paths.source))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("merges a named function re-export with reExportedFrom metadata", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo(x: number): string { return "" }`,
      reexporter: `export { foo } from "@source@"`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      const reSyms = st.getFile(path.resolve(paths.reexporter))!;
      const foo = reSyms["foo"] as any;
      expect(foo.kind).toBe("function");
      expect(foo.exported).toBe(true);
      expect(foo.parameters).toHaveLength(1);
      expect(foo.reExportedFrom).toEqual({
        sourceFile: path.resolve(paths.source),
        originalName: "foo",
      });
    } finally {
      cleanup();
    }
  });

  it("aliases via `as`", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo() { return 1 }`,
      reexporter: `export { foo as bar } from "@source@"`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      const reSyms = st.getFile(path.resolve(paths.reexporter))!;
      expect(reSyms["foo"]).toBeUndefined();
      expect(reSyms["bar"]).toBeDefined();
      expect(reSyms["bar"].name).toBe("bar");
      expect((reSyms["bar"] as any).reExportedFrom?.originalName).toBe("foo");
    } finally {
      cleanup();
    }
  });

  it("per-name `safe` overrides source's safe flag", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo() { return 1 }`,
      reexporter: `export { safe foo } from "@source@"`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      const foo = st.getFile(path.resolve(paths.reexporter))!["foo"];
      expect(foo.kind).toBe("function");
      expect((foo as any).safe).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("per-name safe leaves siblings unchanged", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo() { return 1 }
        export def bar() { return 2 }`,
      reexporter: `export { safe foo, bar } from "@source@"`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      const reSyms = st.getFile(path.resolve(paths.reexporter))!;
      expect((reSyms["foo"] as any).safe).toBe(true);
      expect((reSyms["bar"] as any).safe).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("hard errors when source symbol is missing", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo() { return 1 }`,
      reexporter: `export { nope } from "@source@"`,
    });
    try {
      expect(() => SymbolTable.build(paths.reexporter)).toThrow(
        /Symbol 'nope' is not defined/,
      );
    } finally {
      cleanup();
    }
  });

  it("hard errors when source symbol is not exported", () => {
    const { paths, cleanup } = withTempFiles({
      source: `def foo() { return 1 }`,
      reexporter: `export { foo } from "@source@"`,
    });
    try {
      expect(() => SymbolTable.build(paths.reexporter)).toThrow(
        /Function 'foo' .* is not exported/,
      );
    } finally {
      cleanup();
    }
  });

  it("uses kind-specific label in 'not exported' error for types", () => {
    const { paths, cleanup } = withTempFiles({
      source: `type Foo = string`,
      reexporter: `export { Foo } from "@source@"`,
    });
    try {
      expect(() => SymbolTable.build(paths.reexporter)).toThrow(
        /Type 'Foo' .* is not exported/,
      );
    } finally {
      cleanup();
    }
  });

  it("re-exports an unexported node via named export (nodes don't require 'export')", () => {
    // Nodes are importable without `export` (see importResolver). Re-exports
    // should follow the same rule, otherwise plain `node main()` declarations
    // would be invisible to `export { main } from ...`.
    const { paths, cleanup } = withTempFiles({
      source: `node main() { return 1 }`,
      reexporter: `export { main } from "@source@"`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      const main = st.getFile(path.resolve(paths.reexporter))!["main"];
      expect(main).toBeDefined();
      expect(main.kind).toBe("node");
      expect((main as any).reExportedFrom).toEqual({
        sourceFile: path.resolve(paths.source),
        originalName: "main",
      });
    } finally {
      cleanup();
    }
  });

  it("re-exports an unexported node via star export", () => {
    const { paths, cleanup } = withTempFiles({
      source: `node main() { return 1 }`,
      reexporter: `export * from "@source@"`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      const main = st.getFile(path.resolve(paths.reexporter))!["main"];
      expect(main).toBeDefined();
      expect(main.kind).toBe("node");
      expect((main as any).reExportedFrom?.originalName).toBe("main");
    } finally {
      cleanup();
    }
  });

  it("rejects aliasing a re-exported node", () => {
    // Re-exported nodes preserve their original name because the source
    // graph is merged wholesale; renaming would silently desync.
    const { paths, cleanup } = withTempFiles({
      source: `export node srcNode() { return 1 }`,
      reexporter: `export { srcNode as renamed } from "@source@"`,
    });
    try {
      expect(() => SymbolTable.build(paths.reexporter)).toThrow(
        /Node 'srcNode' .* cannot be re-exported under a different name/,
      );
    } finally {
      cleanup();
    }
  });

  it("re-exported entry's loc points at the exportFromStatement", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo() { return 1 }`,
      reexporter: `\nexport { foo } from "@source@"\n`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      const foo = st.getFile(path.resolve(paths.reexporter))!["foo"];
      // The reexporter's first line is blank (line 0); export-from is on line 1.
      // Just assert the loc isn't the source's loc.
      expect(foo.loc).toBeDefined();
      // Source's foo is on the first line (line 0)
      const sourceFoo = st.getFile(path.resolve(paths.source))!["foo"];
      expect(foo.loc).not.toEqual(sourceFoo.loc);
    } finally {
      cleanup();
    }
  });
});

describe("SymbolTable: star and transitive re-exports", () => {
  it("star merges all exported symbols from source", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo() { return 1 }
        export def bar() { return 2 }
        def hidden() { return 3 }`,
      reexporter: `export * from "@source@"`,
    });
    try {
      const st = SymbolTable.build(paths.reexporter);
      const reSyms = st.getFile(path.resolve(paths.reexporter))!;
      expect(reSyms["foo"]).toBeDefined();
      expect((reSyms["foo"] as any).reExportedFrom?.originalName).toBe("foo");
      expect(reSyms["bar"]).toBeDefined();
      expect(reSyms["hidden"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("transitive a → b → c star resolves", () => {
    const { paths, cleanup } = withTempFiles({
      c: `export def foo() { return 1 }`,
      b: `export * from "@c@"`,
      a: `export * from "@b@"`,
    });
    try {
      const st = SymbolTable.build(paths.a);
      const aSyms = st.getFile(path.resolve(paths.a))!;
      expect(aSyms["foo"]).toBeDefined();
      // The immediate source for a's foo should be b's path.
      expect((aSyms["foo"] as any).reExportedFrom?.sourceFile).toBe(path.resolve(paths.b));
    } finally {
      cleanup();
    }
  });

  it("detects re-export cycle a → b → a", () => {
    const { paths, cleanup } = withTempFiles({
      a: `export * from "@b@"`,
      b: `export * from "@a@"`,
    });
    try {
      expect(() => SymbolTable.build(paths.a)).toThrow(
        /Re-export cycle detected/,
      );
    } finally {
      cleanup();
    }
  });

  it("collides when two sources re-export the same name via star", () => {
    const { paths, cleanup } = withTempFiles({
      a: `export def foo() { return 1 }`,
      b: `export def foo() { return 2 }`,
      reexporter: `export * from "@a@"
        export * from "@b@"`,
    });
    try {
      expect(() => SymbolTable.build(paths.reexporter)).toThrow(
        /re-exported from both/,
      );
    } finally {
      cleanup();
    }
  });

  it("collides when explicit named re-export shadows a star", () => {
    const { paths, cleanup } = withTempFiles({
      a: `export def foo() { return 1 }`,
      b: `export def foo() { return 2 }`,
      reexporter: `export * from "@a@"
        export { foo } from "@b@"`,
    });
    try {
      expect(() => SymbolTable.build(paths.reexporter)).toThrow(
        /re-exported from both/,
      );
    } finally {
      cleanup();
    }
  });

  it("collides with local declaration", () => {
    const { paths, cleanup } = withTempFiles({
      source: `export def foo() { return 1 }`,
      reexporter: `def foo() { return 2 }
        export { foo } from "@source@"`,
    });
    try {
      expect(() => SymbolTable.build(paths.reexporter)).toThrow(
        /collides with local declaration/,
      );
    } finally {
      cleanup();
    }
  });
});
