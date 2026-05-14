import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";
import type { AgencyConfig } from "../config.js";

function errorsFrom(source: string, config: AgencyConfig = {}): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-undef-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, config);
    const parseResult = parseAgency(source, config);
    if (!parseResult.success) throw new Error("Parse failed");
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, config, info).errors;
  } finally {
    unlinkSync(file);
  }
}

const WARN: AgencyConfig = { typechecker: { undefinedFunctions: "warn" } };

describe("undefined function diagnostic", () => {
  it("warns on a genuinely undefined function", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = parseJSON("{}")
      }
    `,
      WARN,
    );
    const undef = errors.filter((e) => e.message.includes("parseJSON"));
    expect(undef).toHaveLength(1);
    expect(undef[0].severity).toBe("warning");
  });

  it("does not warn on a locally defined function", () => {
    const errors = errorsFrom(
      `
      def helper(): string { return "ok" }
      node main() {
        helper()
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("helper"))).toHaveLength(0);
  });

  it("does not warn on a builtin function", () => {
    const errors = errorsFrom(
      `
      node main() {
        print("hello")
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("print"))).toHaveLength(0);
  });

  it("does not warn on a reserved name", () => {
    const errors = errorsFrom(
      `
      node main() {
        let r = success(42)
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("success"))).toHaveLength(0);
  });

  it("does not warn on a variable in scope (lambda/partial)", () => {
    const errors = errorsFrom(
      `
      def add(a: number, b: number): number { return a + b }
      node main() {
        const add2 = add.partial(a: 2)
        add2(3)
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("add2"))).toHaveLength(0);
  });

  it("does not warn on a flat callable JS global", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = parseInt("42")
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("parseInt"))).toHaveLength(0);
  });

  it("warns on a bare-statement call to an undefined function", () => {
    const errors = errorsFrom(
      `
      node main() {
        doStuff()
      }
    `,
      WARN,
    );
    const undef = errors.filter((e) => e.message.includes("doStuff"));
    expect(undef).toHaveLength(1);
  });

  it("does not warn on a node call (goto target)", () => {
    const errors = errorsFrom(
      `
      node start() {
        return finish()
      }
      node finish() {
        print("done")
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("finish"))).toHaveLength(0);
  });

  it("emits the diagnostic exactly once when used in an assignment (no double-fire)", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = doesNotExist()
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("doesNotExist"))).toHaveLength(1);
  });

  it("respects undefinedFunctions: silent (default)", () => {
    const errors = errorsFrom(`
      node main() {
        parseJSON("{}")
      }
    `);
    expect(errors.filter((e) => e.message.includes("parseJSON"))).toHaveLength(0);
  });

  it("respects undefinedFunctions: error", () => {
    const errors = errorsFrom(
      `
      node main() {
        parseJSON("{}")
      }
    `,
      { typechecker: { undefinedFunctions: "error" } },
    );
    const undef = errors.filter((e) => e.message.includes("parseJSON"));
    expect(undef).toHaveLength(1);
    expect(undef[0].severity).toBe("error");
  });
});

describe("undefined function diagnostic — JS namespaces", () => {
  it("does not warn on a known namespace member", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = JSON.parse("{}")
        let y = Math.floor(1.5)
      }
    `,
      WARN,
    );
    expect(
      errors.filter((e) => e.message.includes("JSON") || e.message.includes("Math")),
    ).toHaveLength(0);
  });

  it("warns on an unknown member of a known namespace", () => {
    const errors = errorsFrom(
      `
      node main() {
        let x = JSON.banana("{}")
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("JSON.banana"))).toHaveLength(1);
  });

  it("does not warn when the base is a value in scope", () => {
    const errors = errorsFrom(
      `
      def makeObj(): any { return { foo: "bar" } }
      node main() {
        const obj = makeObj()
        obj.foo
      }
    `,
      WARN,
    );
    expect(errors.filter((e) => e.message.includes("obj"))).toHaveLength(0);
  });
});
