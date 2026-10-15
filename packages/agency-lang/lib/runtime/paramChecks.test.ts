import { describe, expect, it } from "vitest";
import { z } from "zod";
import { __checkParams } from "./paramChecks.js";
import type { ParamChecks } from "./paramChecks.js";
import { failure, isFailure, success } from "./result.js";
import { __validateType } from "./schema.js";
import { interrupt } from "./interrupts.js";
import type { Run } from "./asyncContext.js";

const run = {} as Run;

function stubRunner() {
  const halts: unknown[] = [];
  return { halts, halt: (result: unknown) => halts.push(result) };
}

const number: ParamChecks[string] = {
  typeText: "number",
  validate: (_run, value) => __validateType(value, z.number()),
};

describe("__checkParams", () => {
  it("stores every checked value when every check passes", async () => {
    const runner = stubRunner();
    const frame = { args: { count: 3, spec: { type: "daily", extra: 1 } } };
    const checks: ParamChecks = {
      count: number,
      spec: {
        typeText: '{ type: "daily" }',
        validate: (_run, value) => __validateType(value, z.object({ type: z.literal("daily") })),
      },
    };
    await __checkParams(run, runner, frame, "plan", checks, ["count", "spec"]);
    expect(runner.halts).toEqual([]);
    expect(frame.args).toEqual({ count: 3, spec: { type: "daily" } });
  });

  it("halts with the invalid-argument failure and checks nothing after it", async () => {
    const runner = stubRunner();
    const frame = { args: { first: 1, second: "two", third: 3 } };
    const thirdCalls: unknown[] = [];
    const checks: ParamChecks = {
      first: number,
      second: number,
      third: {
        typeText: "number",
        validate: (_run, value) => {
          thirdCalls.push(value);
          return success(value);
        },
      },
    };
    await __checkParams(run, runner, frame, "add", checks, ["first", "second", "third"]);
    expect(runner.halts).toHaveLength(1);
    const halted = runner.halts[0];
    expect(isFailure(halted)).toBe(true);
    if (isFailure(halted)) {
      expect(halted.error).toBe(
        'Argument "second" of add must be number, but received the text "two".',
      );
    }
    expect(thirdCalls).toEqual([]);
    expect(frame.args).toEqual({ first: 1, second: "two", third: 3 });
  });

  it("checks only the named parameters", async () => {
    const runner = stubRunner();
    const frame = { args: { kept: "raw", checked: 2 } };
    const checks: ParamChecks = {
      kept: { typeText: "number", validate: () => failure("should not run") },
      checked: number,
    };
    await __checkParams(run, runner, frame, "pick", checks, ["checked"]);
    expect(runner.halts).toEqual([]);
    expect(frame.args).toEqual({ kept: "raw", checked: 2 });
  });

  it("passes the run to each check", async () => {
    const runner = stubRunner();
    const frame = { args: { value: 1 } };
    const seen: Run[] = [];
    const checks: ParamChecks = {
      value: {
        typeText: "number",
        validate: (givenRun, value) => {
          seen.push(givenRun);
          return success(value);
        },
      },
    };
    await __checkParams(run, runner, frame, "see", checks, ["value"]);
    expect(seen).toEqual([run]);
  });

  it("halts with a failure when a validator raised an interrupt", async () => {
    const runner = stubRunner();
    const frame = { args: { when: "09:00" } };
    const interrupts = [
      interrupt({ effect: "test::check", message: "ok?", data: {}, origin: "t", runId: "r" }),
    ];
    const checks: ParamChecks = {
      when: {
        typeText: "Stamp",
        validate: () => interrupts,
      },
    };
    await __checkParams(run, runner, frame, "schedule", checks, ["when"]);
    const halted = runner.halts[0];
    expect(isFailure(halted) && halted.error).toContain(
      'Argument "when" of schedule could not be checked: a validator for Stamp raised an interrupt',
    );
    expect(frame.args).toEqual({ when: "09:00" });
  });

  it("throws naming the parameter when the names list has no check", async () => {
    const runner = stubRunner();
    const frame = { args: { count: 3 } };
    await expect(
      __checkParams(run, runner, frame, "tally", { count: number }, ["count", "total"]),
    ).rejects.toThrow('No check for parameter "total" of tally');
    expect(runner.halts).toEqual([]);
  });

  it("words a @validate refusal as a refusal", async () => {
    const runner = stubRunner();
    const frame = { args: { amount: -5 } };
    const checks: ParamChecks = {
      amount: { typeText: "Count", validate: () => failure("expected -5 to be > 0") },
    };
    await __checkParams(run, runner, frame, "setCount", checks, ["amount"]);
    const halted = runner.halts[0];
    expect(isFailure(halted) && halted.error).toBe(
      'Argument "amount" of setCount was refused: expected -5 to be > 0',
    );
  });
});
