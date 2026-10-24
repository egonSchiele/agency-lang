import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgencyFunction } from "./agencyFunction.js";
import type { ParamChecks } from "./paramChecks.js";
import {
  __rebindParameters,
  __releaseRebind,
  type RebindFrame,
  type RebindSpec,
} from "./rebind.js";
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
    await __rebindParameters(run, runner, frame, fn, { a: 1 }, {}, spec, null, 0);
    expect(frame.args).toEqual({ a: 1, b: "dflt" });
    expect(runner.state.halted).toBe(false);
  });

  it("halts the runner with the bind failure instead of throwing", async () => {
    const frame = { args: {} };
    const runner = stubRunner();
    await __rebindParameters(run, runner, frame, fn, { a: 1, c: 2 }, {}, spec, null, 0);
    expect(runner.state.halted).toBe(true);
    expect(failureMessage(runner.state.haltResult)).toContain("Unknown named argument 'c'");
  });

  it("halts on a missing required key", async () => {
    const frame = { args: {} };
    const runner = stubRunner();
    await __rebindParameters(run, runner, frame, fn, {}, {}, spec, null, 0);
    expect(failureMessage(runner.state.haltResult)).toContain("Missing required argument 'a'");
  });

  it("leaves the frame untouched when binding fails", async () => {
    const frame = { args: { a: "before" } };
    const runner = stubRunner();
    await __rebindParameters(run, runner, frame, fn, { a: 1, c: 2 }, {}, spec, null, 0);
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
      {},
      [{ name: "n", checked: true }],
      positive,
      0,
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
      {},
      [{ name: "n", checked: true }],
      positive,
      0,
    );
    expect(frame.args).toEqual({ n: 3 });
    expect(runner.state.halted).toBe(false);
  });

  it("refuses a second rebind at the same depth while the first block is running", async () => {
    const frame = { args: {} };
    const first = stubRunner();
    await __rebindParameters(run, first, frame, fn, { a: 1 }, {}, spec, null, 0);
    const second = stubRunner();
    await __rebindParameters(run, second, frame, fn, { a: 2 }, {}, spec, null, 0);
    expect(second.state.halted).toBe(true);
    expect(failureMessage(second.state.haltResult)).toContain("still running");
    // The first block's arguments are untouched.
    expect(frame.args).toEqual({ a: 1, b: "dflt" });
  });

  it("allows a rebind at the same depth once the first block has released", async () => {
    const frame = { args: {} };
    await __rebindParameters(run, stubRunner(), frame, fn, { a: 1 }, {}, spec, null, 0);
    __releaseRebind(frame, 0);
    const runner = stubRunner();
    await __rebindParameters(run, runner, frame, fn, { a: 2 }, {}, spec, null, 0);
    expect(runner.state.halted).toBe(false);
    expect(frame.args).toEqual({ a: 2, b: "dflt" });
  });

  it("allows a nested rebind at another depth, as stacked decorators make", async () => {
    const frame: RebindFrame = { args: {} };
    await __rebindParameters(run, stubRunner(), frame, fn, { a: 1 }, {}, spec, null, 0);
    const inner = stubRunner();
    await __rebindParameters(run, inner, frame, fn, { a: 2 }, {}, spec, null, 1);
    expect(inner.state.halted).toBe(false);
    expect(frame.rebinding).toEqual([0, 1]);
    __releaseRebind(frame, 1);
    expect(frame.rebinding).toEqual([0]);
  });

  it("releasing a claim that is not there does nothing", () => {
    const frame: RebindFrame = { args: {} };
    __releaseRebind(frame, 0);
    expect(frame.rebinding).toEqual([]);
  });
});
