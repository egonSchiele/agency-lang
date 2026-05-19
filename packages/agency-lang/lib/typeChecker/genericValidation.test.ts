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

/**
 * End-to-end typechecker tests for generic-type *validation*: the
 * typecheck pipeline must surface unknown / wrong-arity / wrong-shape
 * generic forms as `TypeCheckError` diagnostics, never crash the run.
 *
 * Before #2 was fixed, an invalid generic annotation like
 * `Array<string, number>` would throw a raw `TypeError` out of
 * `resolveType` and propagate up through the synthesizer.
 */
function errorsFrom(
  source: string,
  config: AgencyConfig = {},
): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-genvalid-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, config);
    const parseResult = parseAgency(source, config);
    if (!parseResult.success)
      throw new Error("Parse failed: " + parseResult.message);
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, config, info).errors;
  } finally {
    unlinkSync(file);
  }
}

describe("typechecker: invalid generic forms surface as diagnostics", () => {
  it("flags Array with the wrong arity", () => {
    const src = `
node main() {
  let xs: Array<string, number> = []
  print(xs)
}
`;
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThan(0);
    expect(
      errs.some((e) => /Array expects 1 type argument/.test(e.message)),
    ).toBe(true);
  });

  it("flags Schema with the wrong arity", () => {
    const src = `
node main() {
  let s: Schema<string, number> = schema(string)
  print(s)
}
`;
    const errs = errorsFrom(src);
    expect(
      errs.some((e) => /Schema expects 1 type argument/.test(e.message)),
    ).toBe(true);
  });

  it("flags Record with the wrong arity", () => {
    const src = `
node main() {
  let r: Record<string> = {}
  print(r)
}
`;
    const errs = errorsFrom(src);
    expect(
      errs.some((e) => /Record expects 2 type arguments/.test(e.message)),
    ).toBe(true);
  });

  it("flags an unknown generic name", () => {
    const src = `
node main() {
  let c: Ghost<string> = "x"
  print(c)
}
`;
    const errs = errorsFrom(src);
    expect(errs.some((e) => /Unknown generic type 'Ghost'/.test(e.message))).toBe(
      true,
    );
  });

  it("flags applying type args to a non-generic alias", () => {
    const src = `
type Plain = { x: number }

node main() {
  let p: Plain<string> = { x: 1 }
  print(p)
}
`;
    const errs = errorsFrom(src);
    expect(
      errs.some((e) => /Type 'Plain' is not a generic type/.test(e.message)),
    ).toBe(true);
  });

  it("flags a missing required generic arg", () => {
    const src = `
type Pair<A, B> = { first: A, second: B }

node main() {
  let p: Pair<string> = { first: "a", second: "b" }
  print(p)
}
`;
    const errs = errorsFrom(src);
    expect(
      errs.some((e) => /Pair requires at least 2 type arguments/.test(e.message)),
    ).toBe(true);
  });

  it("flags too many generic args", () => {
    const src = `
type Box<T> = { value: T }

node main() {
  let b: Box<string, number> = { value: "x" }
  print(b)
}
`;
    const errs = errorsFrom(src);
    expect(
      errs.some((e) => /Box expects at most 1 type argument/.test(e.message)),
    ).toBe(true);
  });

  it("flags bare reference to a generic alias with no defaults", () => {
    const src = `
type Container<T> = { value: T }

node main() {
  let c: Container = { value: 1 }
  print(c)
}
`;
    const errs = errorsFrom(src);
    expect(
      errs.some((e) =>
        /Generic type 'Container' requires type arguments/.test(e.message),
      ),
    ).toBe(true);
  });

  it("accepts bare reference when every type param has a default", () => {
    const src = `
type StringMap<V = any> = Record<string, V>

node main() {
  let r: StringMap = {}
  print(r)
}
`;
    const errs = errorsFrom(src);
    expect(errs).toEqual([]);
  });

  it("does NOT crash the typechecker run on invalid generic forms", () => {
    // Multiple invalid generic forms in one file — the pipeline should keep
    // going and surface all of them rather than throwing at the first one.
    const src = `
node main() {
  let a: Array<string, number> = []
  let b: Record<string> = {}
  let c: Ghost<string> = "x"
  print(a)
  print(b)
  print(c)
}
`;
    expect(() => errorsFrom(src)).not.toThrow();
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("typechecker: accessChain assignment writes are type-checked", () => {
  it("rejects writing a value of the wrong type to a Record element", () => {
    const src = `
node main() {
  let votes: Record<string, "approve" | "reject"> = {}
  votes["alice"] = "maybe"
  print(votes)
}
`;
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /not assignable/.test(e.message))).toBe(true);
  });

  it("accepts writing a literal that matches the value union", () => {
    const src = `
node main() {
  let votes: Record<string, "approve" | "reject"> = {}
  votes["alice"] = "approve"
  print(votes)
}
`;
    expect(errorsFrom(src)).toEqual([]);
  });

  it("rejects writing the wrong type to an object property", () => {
    const src = `
node main() {
  let user: { name: string, age: number } = { name: "Alice", age: 30 }
  user.age = "not a number"
  print(user)
}
`;
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /not assignable/.test(e.message))).toBe(true);
  });

  it("accepts writing a matching type to an object property", () => {
    const src = `
node main() {
  let user: { name: string, age: number } = { name: "Alice", age: 30 }
  user.age = 31
  print(user)
}
`;
    expect(errorsFrom(src)).toEqual([]);
  });

  it("rejects writing the wrong element type to an array via index", () => {
    const src = `
node main() {
  let xs: number[] = [1, 2, 3]
  xs[0] = "not a number"
  print(xs)
}
`;
    const errs = errorsFrom(src);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => /not assignable/.test(e.message))).toBe(true);
  });
});
