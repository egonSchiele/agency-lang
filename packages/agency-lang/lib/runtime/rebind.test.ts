import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgencyFunction } from "./agencyFunction.js";
import type { ParamChecks } from "./paramChecks.js";
import { __rebindParameters, type RebindSpec } from "./rebind.js";
import { isFailure } from "./result.js";
import { __validateType } from "./schema.js";
import type { Run } from "./asyncContext.js";

const run = {} as Run;

function stubRunner() {
  const state = { halted: false, haltResult: undefined as unknown };
  return {
    state,
    halt: (result: unknown) => {
      state.halted = true;
      state.haltResult = result;
    },
  };
}

function makeFunction(params: { name: string; hasDefault?: boolean; variadic?: boolean }[]) {
  return new AgencyFunction({
    name: "f",
    module: "test.agency",
    fn: async () => undefined,
    params: params.map((p) => ({
      name: p.name,
      hasDefault: p.hasDefault ?? false,
      defaultValue: undefined,
      variadic: p.variadic ?? false,
    })),
    toolDefinition: null,
  });
}

const fn = makeFunction([{ name: "a" }, { name: "b", hasDefault: true }]);
const spec: RebindSpec[] = [
  { name: "a", checked: false },
  { name: "b", checked: false, defaultValue: () => "dflt" },
];

const positive: ParamChecks = {
  n: {
    typeText: "Positive",
    validate: (_run, value) => __validateType(value, z.number().positive()),
  },
};

function failureMessage(result: unknown): string {
  if (!isFailure(result)) {
    throw new Error("expected a failure");
  }
  return result.error;
}

describe("__rebindParameters", () => {
  it("stores bound values and calls the default thunk for an absent key", async () => {
    const frame = { args: {} };
    const runner = stubRunner();
    await __rebindParameters(run, runner, frame, fn, { a: 1 }, undefined, spec, null);
    expect(frame.args).toEqual({ a: 1, b: "dflt" });
    expect(runner.state.halted).toBe(false);
  });

  it("halts the runner with the bind failure instead of throwing", async () => {
    const frame = { args: {} };
    const runner = stubRunner();
    await __rebindParameters(run, runner, frame, fn, { a: 1, c: 2 }, undefined, spec, null);
    expect(runner.state.halted).toBe(true);
    expect(failureMessage(runner.state.haltResult)).toContain("Unknown named argument 'c'");
  });

  it("halts on a missing required key", async () => {
    const frame = { args: {} };
    const runner = stubRunner();
    await __rebindParameters(run, runner, frame, fn, {}, undefined, spec, null);
    expect(failureMessage(runner.state.haltResult)).toContain("Missing required argument 'a'");
  });

  it("leaves the frame untouched when binding fails", async () => {
    const frame = { args: { a: "before" } };
    const runner = stubRunner();
    await __rebindParameters(run, runner, frame, fn, { a: 1, c: 2 }, undefined, spec, null);
    expect(frame.args).toEqual({ a: "before" });
  });

  it("runs the ! checks and halts on a failed one", async () => {
    const checked = makeFunction([{ name: "n" }]);
    const frame = { args: {} };
    const runner = stubRunner();
    await __rebindParameters(
      run,
      runner,
      frame,
      checked,
      { n: -1 },
      undefined,
      [{ name: "n", checked: true }],
      positive,
    );
    expect(runner.state.halted).toBe(true);
    expect(failureMessage(runner.state.haltResult)).toContain("n");
  });

  it("stores the checked value when the check passes", async () => {
    const checked = makeFunction([{ name: "n" }]);
    const frame = { args: {} };
    const runner = stubRunner();
    await __rebindParameters(
      run,
      runner,
      frame,
      checked,
      { n: 3 },
      undefined,
      [{ name: "n", checked: true }],
      positive,
    );
    expect(frame.args).toEqual({ n: 3 });
    expect(runner.state.halted).toBe(false);
  });
});
