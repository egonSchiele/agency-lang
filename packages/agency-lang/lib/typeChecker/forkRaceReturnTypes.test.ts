import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

/** Errors whose message matches. Reject-cases only - accept-cases
 *  assert the raw list is empty so unrelated diagnostics cannot hide. */
const matching = (src: string, re: RegExp) =>
  typecheckSource(src).filter((e) => re.test(e.message));

const clean = (src: string) => typecheckSource(src);

const DOUBLE = `def double(x: number): number {
  return x * 2
}
`;

describe("fork block calls type as T[]", () => {
  it("infers the element type - consuming an element as the wrong type errors", () => {
    // Under the old `any` typing this produced nothing; the downstream
    // mismatch is what distinguishes a working inference from an
    // absent one.
    const errs = matching(
      DOUBLE +
        `node main() {
  const xs = fork([1, 2]) as x { return double(x) }
  const s: string = xs[0]
  return s
}`,
      /not assignable to type 'string'/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("accepts a T[] annotation with no diagnostics at all", () => {
    expect(
      clean(
        DOUBLE +
          `node main() {
  const xs: number[] = fork([1, 2]) as x { return double(x) }
  return xs
}`,
      ),
    ).toHaveLength(0);
  });

  it("rejects a scalar annotation", () => {
    const errs = matching(
      DOUBLE +
        `node main() {
  const n: number = fork([1, 2]) as x { return double(x) }
  return n
}`,
      /not assignable to type 'number'/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("joins mixed block returns into a union element type", () => {
    expect(
      clean(
        DOUBLE +
          `node main() {
  const xs: (number | string)[] = fork([1, 2]) as x {
    if (x == 1) {
      return double(x)
    }
    return "odd"
  }
  return xs
}`,
      ),
    ).toHaveLength(0);
  });

  it("types a fork nested in a fork block as T[][]", () => {
    // exercises the shared walk's nested-blockArgument skip against the
    // new case: the OUTER block's return is the inner fork call, and
    // the inner block's return must NOT leak into the outer element
    expect(
      clean(
        DOUBLE +
          `node main() {
  const grid: number[][] = fork([1]) as x {
    return fork([2, 3]) as y { return double(y) }
  }
  return grid
}`,
      ),
    ).toHaveLength(0);
  });

  it("keeps isFailure legal on a typed element", () => {
    // Pins the spec's failures-invisible decision at its dependency:
    // isFailure takes ANY_T (builtins.ts:245), so a number element is a
    // legal argument. If isFailure ever gets a narrower signature, this
    // fails HERE, pointing at the recorded decision, instead of
    // breaking the merged interrupt execution tests at a distance.
    expect(
      clean(
        DOUBLE +
          `node main() {
  const xs: number[] = fork([1, 2]) as x { return double(x) }
  if (isFailure(xs[1])) {
    return "failed"
  }
  return "ok"
}`,
      ),
    ).toHaveLength(0);
  });
});

describe("race block calls type as T | null", () => {
  it("rejects a T[] annotation - the issue 603 headline case", () => {
    const errs = matching(
      DOUBLE +
        `node main() {
  const w: number[] = race([1, 2]) as x { return double(x) }
  return w
}`,
      /not assignable to type 'number\[\]'/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("rejects a bare T annotation - the result is nullable", () => {
    const errs = matching(
      DOUBLE +
        `node main() {
  const w: number = race([1, 2]) as x { return double(x) }
  return w
}`,
      /not assignable to type 'number'/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("accepts T | null, and infers T through a nullish coalesce", () => {
    // the coalesce half both accepts (number survives ??) and consumes
    // (string binding must error) - see the second block
    expect(
      clean(
        DOUBLE +
          `node main() {
  const w: number | null = race([1, 2]) as x { return double(x) }
  const maybe = race([1, 2]) as x { return double(x) }
  const n: number = maybe ?? 0
  return n
}`,
      ),
    ).toHaveLength(0);
    const errs = matching(
      DOUBLE +
        `node main() {
  const maybe = race([1, 2]) as x { return double(x) }
  const s: string = maybe ?? 0
  return s
}`,
      /not assignable to type 'string'/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe("fail-open behavior on any-element blocks", () => {
  it("race collapses to any - the headline mistake is NOT caught here", () => {
    // `x` is an any-typed block parameter, so the element is any and
    // race must fail open (any, not any | null). This is the recorded
    // limitation: the wrong annotation passes when the block returns
    // any. The PR description states it.
    expect(
      clean(
        `node main() {
  const w: string[] = race([1, 2]) as x { return x }
  const s: string = race([1, 2]) as x { return x }
  return s
}`,
      ),
    ).toHaveLength(0);
  });

  it("fork keeps the list shape even for any elements - scalar annotations now error", () => {
    // Deliberate NEW strictness on the fail-open path: any[] is real
    // information (the list shape), so a scalar annotation errors
    // where it used to pass. The one shape that can produce sweep
    // churn in previously-clean code.
    const errs = matching(
      `node main() {
  const s: string = fork([1, 2]) as x { return x }
  return s
}`,
      /not assignable to type 'string'/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("fork any[] still accepts any array annotation", () => {
    expect(
      clean(
        `node main() {
  const xs: string[] = fork([1, 2]) as x { return x }
  return xs
}`,
      ),
    ).toHaveLength(0);
  });
});

describe("degenerate shapes", () => {
  it("a void block produces no diagnostics unannotated", () => {
    // the synthesized types are void[] / void | null (blockReturnType
    // folds no-returns to VOID_T); asserted only as absence-of-error
    // because `void[]` in annotation position is untested grammar
    expect(
      clean(
        `node main() {
  const a = fork([1, 2]) as x { print("side effect") }
  const b = race([1, 2]) as x { print("side effect") }
  return "ok"
}`,
      ),
    ).toHaveLength(0);
  });

  it("a user function named toString with a block does not hit the table", () => {
    // expr.functionName is user-controlled and BLOCK_CALL_RESULT is a
    // plain object literal, so a bare index would walk the prototype
    // chain: table["toString"] is Object.prototype.toString, and the
    // dispatch would wrap the block type with it - synthesizing the
    // string "[object Object]" as a type, silently. The Object.hasOwn
    // guard keeps inherited keys out; this call must type through the
    // ordinary user-def path instead.
    expect(
      clean(
        `def toString(xs: number[]): number[] {
  return xs
}

node main() {
  const r: number[] = toString([1, 2]) as x { return x }
  return r
}`,
      ),
    ).toHaveLength(0);
  });

  it("a blockless fork call falls back to the builtin type and does not crash", () => {
    // the table dispatch is gated on blockOf(expr); a blockless call
    // must fall through to BUILTIN_FUNCTION_TYPES (any[]), not reach
    // blockReturnType with undefined
    expect(
      clean(
        `node main() {
  const r = fork([1, 2])
  return "ok"
}`,
      ),
    ).toHaveLength(0);
  });

  it("a fork result returned from a def checks through the return path", () => {
    expect(
      clean(
        DOUBLE +
          `def spread(xs: number[]): number[] {
  return fork(xs) as x { return double(x) }
}

node main() {
  return spread([1, 2])
}`,
      ),
    ).toHaveLength(0);
    const errs = matching(
      DOUBLE +
        `def wrong(xs: number[]): number {
  return fork(xs) as x { return double(x) }
}

node main() {
  return wrong([1, 2])
}`,
      /not assignable/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("a fork inside a guard composes", () => {
    // a bare guard legitimately warns AG3009 (may throw interrupts
    // outside a handler) - that one expected code is excluded so the
    // assertion stays strict about everything else, in particular that
    // r.value : number[] binds cleanly
    const errs = clean(
      DOUBLE +
        `node main() {
  const r = guard(cost: $1) {
    return fork([1, 2]) as x { return double(x) }
  }
  if (isSuccess(r)) {
    const xs: number[] = r.value
    return "ok"
  }
  return "failed"
}`,
    ).filter((e) => e.code !== "AG3009");
    expect(errs).toHaveLength(0);
  });
});

describe("comprehension forms inherit the types", () => {
  it("race comprehensions reject a list annotation", () => {
    const errs = matching(
      DOUBLE +
        `node main() {
  const w: number[] = race [double(x) for x in [1, 2]]
  return w
}`,
      /not assignable to type 'number\[\]'/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it("raceShared is nullable too - bare T rejected, T | null accepted", () => {
    // the fourth #604 prefix, carrying both the shared named argument
    // and the nullable return
    const errs = matching(
      DOUBLE +
        `node main() {
  const w: number = raceShared [double(x) for x in [1, 2]]
  return w
}`,
      /not assignable to type 'number'/,
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(
      clean(
        DOUBLE +
          `node main() {
  const w: number | null = raceShared [double(x) for x in [1, 2]]
  return "ok"
}`,
      ),
    ).toHaveLength(0);
  });

  it("fork and forkShared comprehensions accept T[] and reject T", () => {
    expect(
      clean(
        DOUBLE +
          `node main() {
  const xs: number[] = forkShared [double(x) for x in [1, 2]]
  return xs
}`,
      ),
    ).toHaveLength(0);
    const errs = matching(
      DOUBLE +
        `node main() {
  const n: number = fork [double(x) for x in [1, 2]]
  return n
}`,
      /not assignable to type 'number'/,
    );
    expect(errs.length).toBeGreaterThan(0);
  });
});
