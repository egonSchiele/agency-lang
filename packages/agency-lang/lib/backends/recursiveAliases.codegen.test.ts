import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

function generate(source: string): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success)
    throw new Error(`Failed to parse: ${parseResult.message}`);
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const pre = preprocessor.preprocess();
  const builder = new TypeScriptBuilder({} as AgencyConfig, info, "test.agency");
  return printTs(builder.build(pre));
}

// Issue #470 bug 1: alias schema consts referencing not-yet-emitted aliases
// (self-recursion, forward refs, cycle back-edges) must defer with z.lazy;
// backward references stay bare (zero churn for existing code).
describe("recursive/forward alias codegen", () => {
  it("wraps a self-reference in z.lazy", () => {
    const out = generate(`
type Tree = {
  value: number,
  children: Tree[],
}
node main() {
  return 1
}
`);
    expect(out).toContain("z.array(z.lazy(() => Tree))");
  });

  it("wraps a forward reference in z.lazy but keeps backward refs bare", () => {
    const out = generate(`
type Ahead = {
  b: Behind,
}
type Behind = {
  x: number,
}
type After = {
  b: Behind,
}
node main() {
  return 1
}
`);
    expect(out).toContain("z.lazy(() => Behind)"); // forward (in Ahead)
    // Backward ref (in After) stays a bare const reference.
    expect(out).toMatch(/const After = z\.object\(\{ "b": Behind \}\)/);
  });

  it("splits a mutual cycle: forward edge lazy, backward edge bare", () => {
    const out = generate(`
type Employee = {
  name: string,
  manager: Manager | null,
}
type Manager = {
  reports: Employee[],
}
node main() {
  return 1
}
`);
    expect(out).toContain("z.lazy(() => Manager)");
    expect(out).toMatch(/const Manager = z\.object\(\{ "reports": z\.array\(Employee\) \}\)/);
  });

  it("wraps a def-before-type tool-schema reference in z.lazy", () => {
    // Tool definitions initialize at module load; a def declared before
    // the alias it references used to TDZ-crash (probe-confirmed).
    const out = generate(`
def f(x: Later): number {
  return 1
}
type Later = {
  v: number,
}
node main() {
  return f({ v: 1 })
}
`);
    expect(out).toContain("z.lazy(() => Later)");
  });

  it("accepts a legitimate alias-of-alias (regression: guard false positive)", () => {
    // `type Point = Coords` compiled on main but the first guard version
    // rejected it: resolveTypeDeep leaves plain alias refs intact by
    // design, so every bare-alias body looked circular. safeResolveType
    // resolves the CHAIN; only chains that land back on a known alias ref
    // (genuine cycles) throw.
    const out = generate(`
type Coords = {
  x: number,
}
type Point = Coords
node main() {
  return 1
}
`);
    expect(out).toMatch(/const Point = Coords/);
  });

  it("emits z.lazy for a FORWARD alias-of-alias", () => {
    const out = generate(`
type Point = Coords
type Coords = {
  x: number,
}
node main() {
  return 1
}
`);
    expect(out).toContain("const Point = z.lazy(() => Coords)");
  });

  it("rejects a bare two-alias cycle (type A = B, type B = A)", () => {
    // Must STAY rejected: a validated bare cycle would emit ref -> ref
    // descriptors with no structural node between them.
    expect(() =>
      generate(`
type A = B
type B = A
node main() {
  return 1
}
`),
    ).toThrow(/circularly references itself with no structure/);
  });

  it("rejects type Loop = Loop with a clear error", () => {
    expect(() =>
      generate(`
type Loop = Loop
node main() {
  return 1
}
`),
    ).toThrow(/circularly references itself with no structure/);
  });
});

describe("recursive value-parameterized aliases (#484)", () => {
  // The unguarded inline expansion fires when the instantiation is USED
  // (a declaration alone emits nothing) — each test includes a use site.
  it("rejects a directly self-referencing value-param alias with a clear error", () => {
    expect(() =>
      generate(`
type Weird(n: number) = {
  next: Weird(n),
}
type Holder = {
  w: Weird(1),
}
node main() {
  return 1
}
`),
    ).toThrow(/recursive value-parameterized/i);
  });

  it("rejects a mutually recursive value-param alias pair", () => {
    expect(() =>
      generate(`
type A(n: number) = {
  next: B(n),
}
type B(n: number) = {
  next: A(n),
}
type Holder = {
  w: A(1),
}
node main() {
  return 1
}
`),
    ).toThrow(/recursive value-parameterized/i);
  });

  it("still accepts a NON-recursive value-param alias chain at a use site", () => {
    const out = generate(`
type Age(low: number) = number
type Person(low: number) = {
  age: Age(low),
}
type Holder = {
  p: Person(1),
}
node main() {
  return 1
}
`);
    expect(out).toContain("const Holder");
  });
});
