import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function warningsFrom(source: string): TypeCheckError[] {
  const file = path.join(os.tmpdir(), `tc-int-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`);
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    const { errors } = typeCheck(program, {}, info);
    return errors.filter((e) => e.severity === "warning");
  } finally {
    unlinkSync(file);
  }
}

describe("interrupt kind warnings", () => {
  it("warns when calling a function with interrupts outside a handler", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        deploy()
      }
    `);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("myapp::deploy");
  });

  it("warns with transitive interrupt kinds", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def orchestrate() {
        deploy()
      }
      node main() {
        orchestrate()
      }
    `);
    const orchestrateWarnings = warnings.filter((w) =>
      w.message.includes("orchestrate"),
    );
    expect(orchestrateWarnings.length).toBeGreaterThanOrEqual(1);
    expect(orchestrateWarnings[0].message).toContain("myapp::deploy");
  });

  it("does not warn when call is inside a handleBlock", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        handle {
          deploy()
        } with (interrupt) {
          return approve()
        }
      }
    `);
    expect(warnings).toHaveLength(0);
  });

  it("does not warn when call has withModifier approve", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        deploy() with approve
      }
    `);
    expect(warnings).toHaveLength(0);
  });

  it("does not warn when call has withModifier reject", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        deploy() with reject
      }
    `);
    expect(warnings).toHaveLength(0);
  });

  it("still warns when call has withModifier propagate", () => {
    const warnings = warningsFrom(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      node main() {
        deploy() with propagate
      }
    `);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("myapp::deploy");
  });

  it("does not warn for functions with no interrupts", () => {
    const warnings = warningsFrom(`
      def add(a: number, b: number): number {
        return a + b
      }
      node main() {
        add(1, 2)
      }
    `);
    expect(warnings).toHaveLength(0);
  });

  it("warns for imported functions with interrupts", () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const libFile = path.join(os.tmpdir(), `tc-lib-${suffix}.agency`);
    const mainFile = path.join(os.tmpdir(), `tc-main-${suffix}.agency`);
    const mainSource = `
      import { deploy } from "${libFile}"
      node main() {
        deploy()
      }
    `;
    writeFileSync(libFile, `
      export def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
    `);
    writeFileSync(mainFile, mainSource);
    try {
      const absPath = path.resolve(mainFile);
      const symbolTable = SymbolTable.build(absPath);
      const parseResult = parseAgency(mainSource, {});
      if (!parseResult.success) throw new Error("Parse failed");
      const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, mainSource);
      const { errors } = typeCheck(parseResult.result, {}, info);
      const warnings = errors.filter((e) => e.severity === "warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain("myapp::deploy");
    } finally {
      unlinkSync(mainFile);
      unlinkSync(libFile);
    }
  });
});
