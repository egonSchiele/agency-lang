import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

/** Errors whose message matches, for quick signal checks. */
const matching = (src: string, re: RegExp) =>
  typecheckSource(src).filter((e) => re.test(e.message));

describe("guard construct — Result<T> typing (spec Part 4)", () => {
  it("types the construct as Result<T> with T from the block's returns", () => {
    // T = number, so assigning r.value to a string must error…
    const bad = matching(
      `node main() {
  const r = guard(cost: $1) { return 1 }
  if (isSuccess(r)) { const s: string = r.value\n return s }
  return "f"
}`,
      /not assignable/,
    );
    expect(bad.length).toBeGreaterThan(0);
    // …and assigning it to a number must not.
    const good = matching(
      `node main() {
  const r = guard(cost: $1) { return 1 }
  if (isSuccess(r)) { const n: number = r.value\n return "ok" }
  return "f"
}`,
      /not assignable/,
    );
    expect(good).toHaveLength(0);
  });

  it("joins mixed returns into a union", () => {
    const good = matching(
      `node main() {
  const r = guard(cost: $1) { if (true) { return 1 }\n return "x" }
  if (isSuccess(r)) { const v: number | string = r.value\n return "ok" }
  return "f"
}`,
      /not assignable/,
    );
    expect(good).toHaveLength(0);
  });

  it("returns inside a NESTED block do not leak into the enclosing def's type", () => {
    // The def returns a string; the guard block returns a number. If the
    // block's return leaked into inference, the def annotation would error.
    const errs = matching(
      `def f(): string {
  const r = guard(cost: $1) { return 1 }
  return "done"
}
node main() { return f() }`,
      /not assignable/,
    );
    expect(errs).toHaveLength(0);
  });

  it("checks head argument types against the impl signature", () => {
    const errs = typecheckSource(
      `node main() {
  const r = guard(cost: "expensive") { return 1 }
  return "x"
}`,
    );
    expect(errs.some((e) => /cost|string|number/.test(e.message))).toBe(true);
  });

  it("saveDraft inside the block: parity with the legacy syntax (no draft-type check)", () => {
    // The legacy `guard(...) as { }` never type-checked a draft against
    // the BLOCK's inferred return (block bodies share the enclosing
    // scope's ScopeInfo; the draft rule keys on scope returnType).
    // The construct keeps parity — pinned here so a future strengthening
    // is a deliberate change, not an accident. Recorded as a known gap
    // in the plan's execution notes.
    const errs = matching(
      `node main() {
  const r = guard(cost: $1) { saveDraft("partial")\n return 1 }
  return "x"
}`,
      /draft/i,
    );
    expect(errs).toHaveLength(0);
  });
});

describe("guard construct — std::guard in the raises analysis (spec decisions 4, 5, 8)", () => {
  const exceeds = (src: string) =>
    typecheckSource(src).filter((e) => /exceeds/.test(e.message));

  it("an annotated def containing a guard must list std::guard (hard-require)", () => {
    const src = `def f(): number raises <> {
  const r = guard(cost: $1) { return 1 }
  return 2
}
node main() { return f() }`;
    expect(exceeds(src).length).toBeGreaterThan(0);
  });

  it("listing std::guard satisfies the requirement", () => {
    const src = `def f(): number raises <std::guard> {
  const r = guard(cost: $1) { return 1 }
  return 2
}
node main() { return f() }`;
    expect(exceeds(src)).toHaveLength(0);
  });

  it("propagates transitively to annotated callers", () => {
    const src = `def inner(): number {
  const r = guard(cost: $1) { return 1 }
  return 2
}
def outer(): number raises <> { return inner() }
node main() { return outer() }`;
    expect(exceeds(src).length).toBeGreaterThan(0);
  });

  it("a guard-free annotated def needs nothing", () => {
    const src = `def f(): number raises <> { return 2 }
node main() { return f() }`;
    expect(exceeds(src)).toHaveLength(0);
  });

  it("a handler-wrapped guard still contributes the effect (no discharge)", () => {
    const src = `def f(): number raises <> {
  handle {
  const r = guard(cost: $1) { return 1 }
  return 2
  } with (i) {
    return reject()
  }
}
node main() { return f() }`;
    expect(exceeds(src).length).toBeGreaterThan(0);
  });

  it("a bare guard in a node body warns (unhandled-interrupt warning)", () => {
    const src = `node main() {
  const r = guard(cost: $1) { return 1 }
  return "x"
}`;
    const warns = typecheckSource(src).filter((e) =>
      /handler/i.test(e.message),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it("the warning discharges inside a handle block (isInsideHandler)", () => {
    const src = `node main() {
  handle {
  const r = guard(cost: $1) { return 1 }
  return "x"
  } with (i) {
    return reject()
  }
}`;
    const warns = typecheckSource(src).filter((e) =>
      /handler/i.test(e.message),
    );
    expect(warns).toHaveLength(0);
  });
});
