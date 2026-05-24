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

// `interrupt` is statically forbidden inside any callback body.
// `liftCallbackBlocks` MUST run before the typechecker so the
// `callback(...) { ... }` block syntax has been rewritten to the
// 2-arg `callback("hook", __cb_scope_N)` form the check looks for.

function errorsFrom(source: string): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-cb-body-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
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

describe("checkCallbackBodyInterrupts", () => {
  it("errors when an onAgentStart callback raises an interrupt", () => {
    const errors = errorsFrom(`
      callback("onAgentStart") as _data {
        interrupt myapp::cantHandle("pause")
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("onAgentStart");
    expect(errors[0].message).toContain("myapp::cantHandle");
    expect(errors[0].message).toContain("not allowed inside a callback body");
  });

  it("errors when an onAgentEnd callback raises an interrupt", () => {
    const errors = errorsFrom(`
      callback("onAgentEnd") as _data {
        interrupt myapp::cantHandle("pause")
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("onAgentEnd");
  });

  it("errors when an onLLMCallStart callback raises an interrupt", () => {
    const errors = errorsFrom(`
      callback("onLLMCallStart") as _data {
        interrupt myapp::pause("nope")
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("onLLMCallStart");
    expect(errors[0].message).toContain("not allowed inside a callback body");
  });

  it("errors when an onToolCallStart callback raises an interrupt", () => {
    const errors = errorsFrom(`
      callback("onToolCallStart") as _data {
        interrupt myapp::pause("nope")
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("onToolCallStart");
  });

  it("errors when an onFunctionStart callback raises an interrupt", () => {
    const errors = errorsFrom(`
      callback("onFunctionStart") as _data {
        interrupt myapp::pause("nope")
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("onFunctionStart");
  });

  it("errors when an onEmit callback raises an interrupt", () => {
    const errors = errorsFrom(`
      callback("onEmit") as _data {
        interrupt myapp::pause("nope")
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("onEmit");
  });

  it("catches transitive interrupts (callback body calls a function that interrupts)", () => {
    const errors = errorsFrom(`
      def maybeFail() {
        interrupt myapp::transitive("nope")
      }
      callback("onAgentStart") as _data {
        maybeFail()
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("onAgentStart");
    expect(errors[0].message).toContain("myapp::transitive");
  });

  it("catches interrupts inside an if branch inside a callback body", () => {
    const errors = errorsFrom(`
      callback("onFunctionStart") as data {
        if (data.functionName == "foo") {
          interrupt myapp::pause("nope")
        }
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("onFunctionStart");
    expect(errors[0].message).toContain("myapp::pause");
  });

  it("does NOT error when a callback has no interrupts", () => {
    const errors = errorsFrom(`
      callback("onAgentStart") as _data {
        let _x: number = 1
      }
      callback("onFunctionStart") as _data {
        let _y: number = 2
      }
      callback("onEmit") as _data {
        let _z: number = 3
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it("does NOT error for `interrupt` inside an ordinary function/node", () => {
    const errors = errorsFrom(`
      def maybeFail() {
        interrupt myapp::pause("ok")
      }
      node main() {
        interrupt myapp::pause("ok")
        return 1
      }
    `);
    expect(errors).toHaveLength(0);
  });
});
