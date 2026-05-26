import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import { liftCallbackBlocks } from "../preprocessors/liftCallbacks.js";
import type { TypeCheckError } from "./types.js";
import type { AgencyConfig } from "../config.js";

function errorsFrom(
  source: string,
  config: AgencyConfig = {},
  opts: { lift?: boolean } = {},
): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-undef-var-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, config);
    const parseResult = parseAgency(source, config);
    if (!parseResult.success) throw new Error("Parse failed");
    // Callback block bodies are lifted to module-level defs by a
    // preprocessor before typechecking in the real pipeline (see
    // lib/compiler/typecheck.ts). For tests that exercise callback
    // capture rules we need to run the same lift; for everything else
    // we skip it so existing call sites stay unchanged.
    const program = opts.lift
      ? liftCallbackBlocks(parseResult.result)
      : parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, config, info).errors;
  } finally {
    unlinkSync(file);
  }
}

const WARN: AgencyConfig = { typechecker: { undefinedVariables: "warn" } };

describe("undefined variable diagnostic", () => {
  it("warns on `let x = doesNotExist`", () => {
    const errors = errorsFrom(
      `node main() {\n let x = doesNotExist\n print(x)\n }\n`,
      WARN,
    );
    const undef = errors.filter(
      (e) => e.message.includes("doesNotExist") && e.message.includes("not defined"),
    );
    expect(undef).toHaveLength(1);
    expect(undef[0].severity).toBe("warning");
  });

  it("does not warn on a function reference (`map(items, myDef)`)", () => {
    const errors = errorsFrom(
      `def myDef(x: number): number { return x }\nnode main() {\n let xs = [1, 2, 3]\n let ys = xs.map(myDef)\n print(ys)\n }\n`,
      WARN,
    );
    expect(
      errors.filter((e) => e.message.includes("myDef") && e.message.includes("not defined")),
    ).toHaveLength(0);
  });

  it("does not warn on a builtin reference (`success`)", () => {
    const errors = errorsFrom(
      `node main() {\n let f = success\n print(f)\n }\n`,
      WARN,
    );
    expect(
      errors.filter((e) => e.message.includes("'success'") && e.message.includes("not defined")),
    ).toHaveLength(0);
  });

  it("does not warn on a JS namespace base (`JSON`)", () => {
    const errors = errorsFrom(
      `node main() {\n let x = JSON.parse("{}")\n print(x)\n }\n`,
      WARN,
    );
    expect(
      errors.filter((e) => e.message.includes("'JSON'") && e.message.includes("not defined")),
    ).toHaveLength(0);
  });

  it("warns when iterating an undefined array", () => {
    const errors = errorsFrom(
      `node main() {\n for (item in someArray) {\n print(item)\n }\n }\n`,
      WARN,
    );
    expect(
      errors.filter((e) => e.message.includes("'someArray'") && e.message.includes("not defined")),
    ).toHaveLength(1);
  });

  it("does not warn on a for-loop's own itemVar/indexVar", () => {
    const errors = errorsFrom(
      `node main() {\n let xs = [1, 2, 3]\n for (item in xs) {\n print(item)\n }\n }\n`,
      WARN,
    );
    expect(
      errors.filter((e) => e.message.includes("item") && e.message.includes("not defined")),
    ).toHaveLength(0);
  });

  it("respects undefinedVariables: silent (default)", () => {
    const errors = errorsFrom(
      `node main() {\n let x = doesNotExist\n print(x)\n }\n`,
    );
    expect(
      errors.filter((e) => e.message.includes("doesNotExist") && e.message.includes("not defined")),
    ).toHaveLength(0);
  });

  it("respects undefinedVariables: error", () => {
    const errors = errorsFrom(
      `node main() {\n let x = doesNotExist\n print(x)\n }\n`,
      { typechecker: { undefinedVariables: "error" } },
    );
    const undef = errors.filter(
      (e) => e.message.includes("doesNotExist") && e.message.includes("not defined"),
    );
    expect(undef).toHaveLength(1);
    expect(undef[0].severity).toBe("error");
  });

  it("warns on a callback argument that doesn't resolve (`xs.map(doesNotExist)`)", () => {
    const errors = errorsFrom(
      `node main() {\n let xs = [1, 2, 3]\n let ys = xs.map(doesNotExist)\n print(ys)\n }\n`,
      WARN,
    );
    expect(
      errors.filter(
        (e) => e.message.includes("doesNotExist") && e.message.includes("not defined"),
      ),
    ).toHaveLength(1);
  });

  it("warns on a callback argument to a bare call (`map(xs, doesNotExist)`)", () => {
    const errors = errorsFrom(
      `node main() {\n let xs = [1, 2, 3]\n let ys = map(xs, doesNotExist)\n print(ys)\n }\n`,
      WARN,
    );
    expect(
      errors.filter(
        (e) => e.message.includes("doesNotExist") && e.message.includes("not defined"),
      ),
    ).toHaveLength(1);
  });

  it("does not warn on lambda/block parameters", () => {
    const errors = errorsFrom(
      `node main() {\n let xs = [1, 2, 3]\n let ys = xs.map(\\(x) -> x + 1)\n print(ys)\n }\n`,
      WARN,
    );
    expect(
      errors.filter((e) => e.message.includes("'x'") && e.message.includes("not defined")),
    ).toHaveLength(0);
  });

  // A `callback("onX") as data { ... }` block is lifted to a module-level
  // `def __cb_<scope>_<n>(data) { ... }` BEFORE typechecking. The lifted body
  // therefore has no lexical access to enclosing-function locals — any such
  // reference becomes an ordinary "Variable 'x' is not defined" diagnostic
  // emitted at the original source location. This is the design contract
  // documented in `lib/preprocessors/liftCallbacks.ts`.
  it("warns when a callback block body references an enclosing-function local", () => {
    const errors = errorsFrom(
      `def wrap() {
  let counter = 0
  callback("onFunctionStart") as data {
    print(counter)
  }
}
node main() { wrap() }
`,
      WARN,
      { lift: true },
    );
    const undef = errors.filter(
      (e) =>
        e.message.includes("counter") &&
        e.message.includes("not defined"),
    );
    // Should fire for at least one reference to `counter` inside the lifted
    // body. Don't pin to an exact count — the diagnostic may report each
    // read independently.
    expect(undef.length).toBeGreaterThanOrEqual(1);
    expect(undef[0].severity).toBe("warning");
  });
});
