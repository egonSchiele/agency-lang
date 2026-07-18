import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

describe("finalize binder — typing and collisions (spec Part 3)", () => {
  it("types the binder as T | null: unguarded use as T errors", () => {
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize as d {
    const s: string = d
    return s
  }
}
node main() { return f() }`,
    ).filter((e) => /null|not assignable/i.test(e.message));
    expect(errs.length).toBeGreaterThan(0);
  });

  it("a null-guarded use narrows to T and passes", () => {
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize as d {
    if (d != null) {
      const s: string = d
      return s
    }
    return "empty"
  }
}
node main() { return f() }`,
    ).filter((e) => /null|not assignable/i.test(e.message));
    expect(errs).toHaveLength(0);
  });

  it("an undeclared return type leaves the binder as any (no errors AT ALL)", () => {
    // UNFILTERED on purpose (plan review T1): the bug this guards
    // against — the pass failing to declare `d` — surfaces as an
    // "undefined variable" error, which a binder/null/assignable
    // message filter would silently drop. Zero errors total is the
    // only assertion that fails in that direction. The unguarded
    // `const s: string = d` doubles as the any-permissiveness probe:
    // legal for `any`, an error for `T | null`.
    const errs = typecheckSource(
      `def f() {
  return "x"
  finalize as d {
    const s: string = d
    return s
  }
}
node main() { return f() }`,
    );
    expect(errs).toHaveLength(0);
  });

  it("a binder colliding with a local is AG6037", () => {
    const errs = typecheckSource(
      `def f(): string {
  const outline = "o"
  return outline
  finalize as outline {
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.some((e) => e.code === "AG6037")).toBe(true);
  });

  it("a binder colliding with a parameter is AG6037", () => {
    const errs = typecheckSource(
      `def f(topic: string): string {
  return topic
  finalize as topic {
    return "y"
  }
}
node main() { return f("t") }`,
    );
    expect(errs.some((e) => e.code === "AG6037")).toBe(true);
  });

  it("a binder named like a MODULE-level const is allowed (collision check is scope-local)", () => {
    // The miscompile AG6037 prevents is a same-frame local resolving
    // to __stack.locals.<name>. A module global compiles differently
    // (not a frame local), so it is NOT a hazard, and a parent-walking
    // `has` would false-positive here (plan review finding 3 / M2).
    const errs = typecheckSource(
      `const banner = "b"
def f(): string {
  return "x"
  finalize as banner {
    if (banner != null) { return banner }
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.filter((e) => e.code === "AG6037")).toHaveLength(0);
  });

  it("a fresh binder name does not disturb outer variables", () => {
    const errs = typecheckSource(
      `def f(): string {
  const outline = "o"
  return outline
  finalize as d {
    if (outline != null) { return outline }
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.filter((e) => e.code === "AG6037")).toHaveLength(0);
  });

  it("the binder-less form is untouched", () => {
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize {
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.filter((e) => e.code === "AG6037")).toHaveLength(0);
  });

  it("two binders is AG6038 (finalize yields one value)", () => {
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize as (a, b) {
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.some((e) => e.code === "AG6038")).toBe(true);
  });

  it("an explicit type hint wins over the scope's return type", () => {
    // def returns string; the binder is annotated number, so using it
    // as a string (after the null guard) must error.
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize as d: number {
    if (d != null) {
      const s: string = d
      return "y"
    }
    return "y"
  }
}
node main() { return f() }`,
    ).filter((e) => /not assignable/i.test(e.message));
    expect(errs.length).toBeGreaterThan(0);
  });
});
