import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// Regression tests for issue #470 bug 2: comparing a recursive alias to
// itself used to recurse forever (each isAssignable call re-resolved the
// alias with a fresh guard) and crash with RangeError.
describe("assignability of recursive type aliases", () => {
  it("self-recursive alias vs itself terminates and accepts", () => {
    const errors = typecheckSource(`
type Tree = {
  value: number,
  children: Tree[],
}
def id(x: Tree): Tree {
  return x
}
node main() {
  const a: Tree = { value: 3, children: [{ value: 4, children: [] }] }
  const b: Tree = id(a)
  return b.value
}
`);
    expect(errors).toEqual([]);
  });

  it("mutually recursive aliases terminate and accept", () => {
    const errors = typecheckSource(`
type Forest = {
  trees: Tree[],
}
type Tree = {
  value: number,
  forest: Forest | null,
}
def id(f: Forest): Forest {
  return f
}
node main() {
  const f: Forest = { trees: [] }
  return id(f)
}
`);
    expect(errors).toEqual([]);
  });

  it("still REJECTS a genuinely incompatible recursive type", () => {
    // Anti-vacuity: a guard that returns true too eagerly fails here.
    const errors = typecheckSource(`
type Tree = {
  value: number,
  children: Tree[],
}
type NamedTree = {
  name: string,
  children: NamedTree[],
}
def wantsNamed(x: NamedTree): number {
  return 1
}
node main() {
  const t: Tree = { value: 3, children: [] }
  return wantsNamed(t)
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });

  it("removal-on-exit: a refuted pair must not be assumed true later in the SAME comparison", () => {
    // Review must-fix 4. Inside ONE top-level isAssignable call:
    // property a checks Tree ~> (NamedTree | Tree): the union tries
    // Tree~>NamedTree first (false — pair added then REMOVED), then
    // Tree~>Tree (true). Property b then re-checks Tree~>NamedTree.
    // A memoizing guard (never removes) sees the stale pair and wrongly
    // accepts; correct removal-on-exit recomputes and rejects b.
    const errors = typecheckSource(`
type Tree = {
  value: number,
  children: Tree[],
}
type NamedTree = {
  name: string,
  children: NamedTree[],
}
type Target = {
  a: NamedTree | Tree,
  b: NamedTree,
}
def wants(x: Target): number {
  return 1
}
node main() {
  const t: Tree = { value: 3, children: [] }
  return wants({ a: t, b: t })
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });
});
