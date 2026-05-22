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

// The compile-time complement of the runtime check in
// `lib/runtime/hooks.ts` — `callback("onAgentStart"|"onAgentEnd", fn)`
// where `fn` may raise an interrupt is rejected at typecheck time.
// `liftCallbackBlocks` MUST run before the typechecker so the
// `callback(...) { ... }` block syntax has been rewritten to the
// 2-arg `callback("hook", __cb_scope_N)` form the check looks for.

function errorsFrom(source: string): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-agent-cb-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
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

describe("checkAgentLifecycleCallbackInterrupts", () => {
  it("errors when an onAgentStart callback may raise an interrupt", () => {
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
    expect(errors[0].message).toContain("outside any agency frame");
  });

  it("errors when an onAgentEnd callback may raise an interrupt", () => {
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

  it("does NOT error when an onAgentStart callback has no interrupts", () => {
    const errors = errorsFrom(`
      callback("onAgentStart") as _data {
        let _x: number = 1
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(0);
  });

  it("does NOT error for hooks that support interrupts (onFunctionStart, onNodeStart, onEmit, etc.)", () => {
    const errors = errorsFrom(`
      callback("onFunctionStart") as _data {
        interrupt myapp::ok("supported")
      }
      callback("onNodeStart") as _data {
        interrupt myapp::ok("supported")
      }
      callback("onEmit") as _data {
        interrupt myapp::ok("supported")
      }
      node main() {
        return 1
      }
    `);
    expect(errors).toHaveLength(0);
  });
});
