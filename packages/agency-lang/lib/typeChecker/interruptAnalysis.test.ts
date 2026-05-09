import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function interruptKindsFor(source: string, funcName: string): string[] {
  const file = path.join(
    os.tmpdir(),
    `int-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, source);
    const { interruptKindsByFunction } = typeCheck(parseResult.result, {}, info);
    return (interruptKindsByFunction[funcName] ?? []).map((ik) => ik.kind).sort();
  } finally {
    unlinkSync(file);
  }
}

describe("interrupt analysis via type checker", () => {
  it("collects direct interrupt kinds", () => {
    expect(
      interruptKindsFor(
        `
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
    `,
        "deploy",
      ),
    ).toEqual(["myapp::deploy"]);
  });

  it("propagates transitively through calls", () => {
    expect(
      interruptKindsFor(
        `
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def orchestrate() {
        deploy()
      }
    `,
        "orchestrate",
      ),
    ).toEqual(["myapp::deploy"]);
  });

  it("handles cycles without infinite loop", () => {
    const kinds = interruptKindsFor(
      `
      def ping() {
        interrupt myapp::ping("Ping")
        pong()
      }
      def pong() {
        interrupt myapp::pong("Pong")
        ping()
      }
    `,
      "ping",
    );
    expect(kinds).toEqual(["myapp::ping", "myapp::pong"]);
  });

  it("resolves function refs in llm tools arrays", () => {
    expect(
      interruptKindsFor(
        `
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def main() {
        llm("do it", { tools: [deploy] })
      }
    `,
        "main",
      ),
    ).toEqual(["myapp::deploy"]);
  });

  it("resolves function refs via variable assignment", () => {
    expect(
      interruptKindsFor(
        `
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def main() {
        let tools = [deploy]
        llm("do it", { tools: tools })
      }
    `,
        "main",
      ),
    ).toEqual(["myapp::deploy"]);
  });

  it("resolves function refs via spread", () => {
    expect(
      interruptKindsFor(
        `
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def validate() {
        interrupt myapp::validate("Validate?")
      }
      def main() {
        let base = [deploy]
        llm("do it", { tools: [...base, validate] })
      }
    `,
        "main",
      ),
    ).toEqual(["myapp::deploy", "myapp::validate"]);
  });

  it("returns empty for functions with no interrupts", () => {
    expect(
      interruptKindsFor(
        `
      def add(a: number, b: number): number {
        return a + b
      }
    `,
        "add",
      ),
    ).toEqual([]);
  });

  it("propagates through multiple levels", () => {
    expect(
      interruptKindsFor(
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
        "main",
      ),
    ).toEqual(["myapp::deploy"]);
  });
});
