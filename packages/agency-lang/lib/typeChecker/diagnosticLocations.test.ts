import { describe, it, expect } from "vitest";
import { typeCheck } from "./index.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import type { TypeCheckError } from "./types.js";
import type { DiagnosticName } from "./diagnostics.js";

// The location audit (spec Tests item 6): every diagnostic that was pushed
// WITHOUT a loc on main must now carry one. `loc: null` is reserved for the
// dynamic cases where no AST node exists (e.g. a reserved name on an
// IMPORTED alias, which has no local declaration node) — no site hardcodes
// it. If one of these pins starts failing with null, a loc hunt regressed.

function checkSource(source: string): TypeCheckError[] {
  const parsed = parseAgency(source);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error("unreachable");
  }
  const unit = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, unit).errors;
}

function expectLocated(errors: TypeCheckError[], name: DiagnosticName): void {
  const hit = errors.find((err) => err.name === name);
  expect(hit).toBeDefined();
  expect(hit?.loc).not.toBe(null);
}

describe("previously loc-less diagnostics now carry locations", () => {
  it("type-param ordering error anchors on the alias declaration", () => {
    // Pushed with NO loc on main (the alias table carries none); now
    // resolved through the aliasDeclLocs hunt in TypeChecker.check().
    const errors = checkSource(
      "type Pair<A = string, B> = { a: A, b: B }\nnode main() { return 1 }\n",
    );
    expectLocated(errors, "typeParamDefaultOrder");
  });

  it("reserved built-in type redefinition anchors on the alias declaration", () => {
    const errors = checkSource(
      "type Result = { a: number }\nnode main() { return 1 }\n",
    );
    expectLocated(errors, "reservedBuiltinTypeRedefined");
  });

  it("an assignability error on a loc-less literal anchors on the statement", () => {
    // String literals carry no loc of their own; checkType now falls back
    // to the assignment statement's loc.
    const errors = checkSource(
      'node main() {\n  const x: number = "nope"\n  return x\n}\n',
    );
    expectLocated(errors, "typeNotAssignableInContext");
  });
});
