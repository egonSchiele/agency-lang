import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { liftCallbackBlocks } from "../preprocessors/liftCallbacks.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

// Errors when a `handle { } with X` handler can transitively raise an
// interrupt — that would re-enter the handler chain and recurse. See
// the rationale at `checkHandlerBodyInterrupts` in interruptAnalysis.ts.

function errorsFrom(source: string): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-handler-body-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const lifted = liftCallbackBlocks(parseResult.result);
    const info = buildCompilationUnit(lifted, symbolTable, absPath, source);
    const { errors } = typeCheck(lifted, {}, info);
    return errors.filter((e) => e.severity === "error");
  } finally {
    unlinkSync(file);
  }
}

describe("checkHandlerBodyInterrupts", () => {
  it("errors when an inline handler directly raises an interrupt", () => {
    const errors = errorsFrom(`
      node main() {
        handle {
          let _x: number = 1
        } with (_data) {
          interrupt myapp::pause("nope")
        }
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("(inline)");
    expect(errors[0].message).toContain("myapp::pause");
    expect(errors[0].message).toContain("re-enter the handler chain");
  });

  it("errors when an inline handler transitively raises via a called function", () => {
    const errors = errorsFrom(`
      def maybeFail() {
        interrupt myapp::transitive("nope")
      }
      node main() {
        handle {
          let _x: number = 1
        } with (_data) {
          maybeFail()
        }
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("(inline)");
    expect(errors[0].message).toContain("myapp::transitive");
  });

  it("errors when a functionRef handler may raise an interrupt", () => {
    const errors = errorsFrom(`
      def myHandler(_intr) {
        interrupt myapp::nested("nope")
      }
      node main() {
        handle {
          let _x: number = 1
        } with myHandler
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("'myHandler'");
    expect(errors[0].message).toContain("myapp::nested");
  });

  it("errors when a functionRef handler transitively interrupts", () => {
    const errors = errorsFrom(`
      def innerCall() {
        interrupt myapp::deep("nope")
      }
      def myHandler(_intr) {
        innerCall()
      }
      node main() {
        handle {
          let _x: number = 1
        } with myHandler
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("'myHandler'");
    expect(errors[0].message).toContain("myapp::deep");
  });

  it("catches interrupts via function refs passed as arguments (e.g. tools)", () => {
    // Mirrors the analyzeInterruptsFromScopes treatment of
    // `functionRefsInArgs`: handing an interrupt-raising function as a
    // value (tool, callback, strategy, etc.) to another call inside the
    // handler still risks re-entering the chain when that callee invokes
    // it. Catches the gap Copilot flagged on the original PR.
    const errors = errorsFrom(`
      def deploy() {
        interrupt myapp::deploy("nope")
      }
      node main() {
        handle {
          let _x: number = 1
        } with (_data) {
          llm("do it", { tools: [deploy] })
        }
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("(inline)");
    expect(errors[0].message).toContain("myapp::deploy");
  });

  it("does NOT error when the handler is interrupt-free", () => {
    const errors = errorsFrom(`
      def myHandler(_intr) {
        print("just logging")
      }
      node main() {
        handle {
          let _x: number = 1
        } with myHandler
        handle {
          let _y: number = 2
        } with (_data) {
          print("inline but safe")
        }
        return 1
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it("does NOT error for `with approve` / `with reject` modifiers", () => {
    // The built-in approve/reject handlers don't run user code.
    const errors = errorsFrom(`
      def needsApproval() {
        interrupt app::read("ignored")
      }
      node main() {
        needsApproval() with approve
        return 1
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it("is suppressible with @tc-ignore on the line above the handle block", () => {
    const errors = errorsFrom(`
      def myHandler(_intr) {
        interrupt myapp::escape("intentional")
      }
      node main() {
        // @tc-ignore
        handle {
          let _x: number = 1
        } with myHandler
        return 1
      }
    `);
    expect(errors).toHaveLength(0);
  });
});
