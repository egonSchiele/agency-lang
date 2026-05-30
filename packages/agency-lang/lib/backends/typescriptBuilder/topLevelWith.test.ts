import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { TypeScriptBuilder } from "../typescriptBuilder.js";
import { printTs } from "../../ir/prettyPrint.js";

function compileSource(src: string): string {
  const parsed = parseAgency(src, {}, false);
  if (!parsed.success) throw new Error(parsed.message ?? "parse failed");
  const info = buildCompilationUnit(parsed.result);
  const preprocessor = new TypescriptPreprocessor(parsed.result, {}, info);
  const preprocessed = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(undefined, info, "test.agency");
  return printTs(builder.build(preprocessed));
}

/**
 * Issue #229: bare top-level `<expr> with handler` used to crash the
 * typescriptBuilder with `StepPathTracker: currentId() called with
 * empty path` because `processWithModifier` always read the current
 * step id, and module-init has no step path. `partitionProgram` now
 * special-cases the `withModifier` node at top level and emits a
 * lightweight `ts.withHandler` (pushHandler/popHandler) wrapper, the
 * same mechanism the static/global assignment cases already use.
 */
describe("issue #229: top-level bare `with` modifier", () => {
  it("compiles `foo() with approve` at module scope without crashing", () => {
    const src = `def foo(): number { return 42 }\n` +
      `foo() with approve\n` +
      `node main() { print("ok") }\n`;
    expect(() => compileSource(src)).not.toThrow();
  });

  it("emits a pushHandler/popHandler wrapper inside __initializeGlobals", () => {
    const src = `def foo(): number { return 42 }\n` +
      `foo() with approve\n` +
      `node main() { print("ok") }\n`;
    const out = compileSource(src);
    // The wrapper uses the same `withHandler` lowering as static/global
    // init handlers. Verify both halves of the wrapper appear inside
    // `__initializeGlobals` and that the wrapped call to `foo` sits
    // between them.
    const initStart = out.indexOf("async function __initializeGlobals");
    expect(initStart).toBeGreaterThan(-1);
    const initBody = out.slice(initStart);
    const push = initBody.indexOf("pushHandler");
    const call = initBody.indexOf("__call(foo");
    const pop = initBody.indexOf("popHandler");
    expect(push).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(push);
    expect(pop).toBeGreaterThan(call);
  });

  it("still compiles when the handler is a user-defined function name", () => {
    const src = `def myHandler(): void { }\n` +
      `def foo(): number { return 42 }\n` +
      `foo() with myHandler\n` +
      `node main() { print("ok") }\n`;
    expect(() => compileSource(src)).not.toThrow();
  });
});
