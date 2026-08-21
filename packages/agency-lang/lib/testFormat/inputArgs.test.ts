import { describe, test, expect } from "vitest";
import { parseInputValues, renderNamedArguments, bindInputArgs } from "./inputArgs.js";
import {
  AgencyFunction,
  BindingParameter,
  planArgumentBindings,
  UNSET,
} from "../runtime/agencyFunction.js";

function params(
  ...specs: [string, { hasDefault?: boolean; variadic?: boolean }?][]
): BindingParameter[] {
  return specs.map(([name, opts]) => ({
    name,
    hasDefault: opts?.hasDefault ?? false,
    variadic: opts?.variadic ?? false,
  }));
}

/** The anti-parallel-implementation check: dispatch the same values through
 *  a REAL AgencyFunction and record the positional array its fn receives.
 *  Object.is on UNSET keeps default gaps visible. */
async function realCallArgs(parameters: BindingParameter[], values: unknown[]): Promise<unknown[]> {
  let received: unknown[] = [];
  const fn = new AgencyFunction({
    name: "probe",
    module: "test",
    fn: (...args: unknown[]) => {
      received = args;
      return null;
    },
    params: parameters.map((p) => ({
      name: p.name,
      hasDefault: p.hasDefault,
      defaultValue: undefined,
      variadic: p.variadic,
    })),
    toolDefinition: null,
  });
  await fn.invoke({ type: "positional", args: values });
  return received;
}

describe("parseInputValues", () => {
  test("empty input is no values", () => {
    expect(parseInputValues("")).toEqual([]);
    expect(parseInputValues("   ")).toEqual([]);
  });

  test("numbers, strings, booleans, null", () => {
    expect(parseInputValues("10, 5")).toEqual([10, 5]);
    expect(parseInputValues('"alice", "coffee"')).toEqual(["alice", "coffee"]);
    expect(parseInputValues("true, false, null")).toEqual([true, false, null]);
    expect(parseInputValues("-3")).toEqual([-3]);
  });

  test("nested arrays and objects of literals", () => {
    expect(parseInputValues('[1, 2], { a: "x", b: [true] }')).toEqual([
      [1, 2],
      { a: "x", b: [true] },
    ]);
  });

  test.each([
    ["identifier", "someVar"],
    ["call", "foo()"],
    ["interpolation", '"hi ${name}"'],
    ["non-literal object member", "{ a: foo() }"],
  ])("rejects %s with the argument index and node kind", (_, input) => {
    expect(() => parseInputValues(input)).toThrow(/argument 1/);
  });
});

describe("renderNamedArguments", () => {
  test("binds positionally to names; omitted defaults stay absent", () => {
    const plan = planArgumentBindings(params(["a"], ["b", { hasDefault: true }]), [10]);
    expect(renderNamedArguments(plan)).toEqual({ a: 10 });
  });

  test("variadic gathers zero and many extras into one named array", () => {
    const p = params(["a"], ["rest", { variadic: true }]);
    expect(renderNamedArguments(planArgumentBindings(p, [1]))).toEqual({ a: 1, rest: [] });
    expect(renderNamedArguments(planArgumentBindings(p, [1, 2, 3]))).toEqual({
      a: 1,
      rest: [2, 3],
    });
  });

  test("default before variadic", () => {
    const p = params(["a"], ["b", { hasDefault: true }], ["rest", { variadic: true }]);
    expect(renderNamedArguments(planArgumentBindings(p, [1, 2, 3]))).toEqual({
      a: 1,
      b: 2,
      rest: [3],
    });
  });

  test("schema-injected optional parameters (hasDefault) accept the shorter list", () => {
    const p = params(["a"], ["injected", { hasDefault: true }]);
    expect(renderNamedArguments(planArgumentBindings(p, [7]))).toEqual({ a: 7 });
  });

  test("too few required values throws naming the accepted count", () => {
    expect(() => renderNamedArguments(planArgumentBindings(params(["a"], ["b"]), [1]))).toThrow(
      /expected 2 argument/,
    );
  });

  test("over-arity without a variadic throws naming the range", () => {
    expect(() =>
      renderNamedArguments(
        planArgumentBindings(params(["a"], ["b", { hasDefault: true }]), [1, 2, 3]),
      ),
    ).toThrow(/expected 1-2 argument/);
  });

  test("zero parameters with values throws; without values yields {}", () => {
    expect(renderNamedArguments(planArgumentBindings([], []))).toEqual({});
    expect(() => renderNamedArguments(planArgumentBindings([], [1]))).toThrow(/expected 0/);
  });
});

describe("plan agrees with real AgencyFunction dispatch", () => {
  test("exact call", async () => {
    expect(await realCallArgs(params(["a"], ["b"]), [10, 5])).toEqual([10, 5]);
  });

  test("omitted default becomes UNSET at the runtime rendering", async () => {
    const received = await realCallArgs(params(["a"], ["b", { hasDefault: true }]), [10]);
    expect(received.length).toBe(2);
    expect(received[0]).toBe(10);
    expect(received[1]).toBe(UNSET);
  });

  test("variadic gathers at the runtime rendering", async () => {
    expect(await realCallArgs(params(["a"], ["rest", { variadic: true }]), [1, 2, 3])).toEqual([
      1,
      [2, 3],
    ]);
  });
});

describe("bindInputArgs end to end", () => {
  test("parses, binds, and names in one hop", () => {
    expect(bindInputArgs('3, "x"', params(["n"], ["label", { hasDefault: true }]))).toEqual({
      n: 3,
      label: "x",
    });
  });
});
