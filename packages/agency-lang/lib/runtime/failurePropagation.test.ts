import { describe, it, expect } from "vitest";
import { failure, propagateFailure, isFailure, isSuccess, success } from "./result.js";
import { agencyStore } from "./asyncContext.js";
import {
  acceptsFailures,
  isFailureTolerant,
  checkFailureArgs,
  checkTsFunctionArgs,
  checkResultMethodCall,
  getFailurePropagationMode,
} from "./failurePropagation.js";
import type { FuncParam } from "./agencyFunction.js";

function param(name: string, opts: Partial<FuncParam> = {}): FuncParam {
  return { name, hasDefault: false, defaultValue: undefined, variadic: false, ...opts };
}

describe("propagateFailure", () => {
  it("failure() initializes skippedFunctions to an empty array", () => {
    const f = failure("boom");
    expect(f.skippedFunctions).toEqual([]);
  });

  it("appends a skip entry, preserving every other field, without mutating the original", () => {
    const orig = failure("boom", {
      functionName: "getReport",
      destructiveRan: true,
      checkpoint: { step: 3 },
      args: { id: "abc" },
    });
    const propagated = propagateFailure(orig, { name: "wordCount", param: "text" });
    expect(propagated.skippedFunctions).toEqual([{ name: "wordCount", param: "text" }]);
    expect(propagated.error).toBe("boom");
    expect(propagated.functionName).toBe("getReport");
    expect(propagated.destructiveRan).toBe(true);
    expect(propagated.checkpoint).toEqual({ step: 3 });
    expect(propagated.args).toEqual({ id: "abc" });
    expect(orig.skippedFunctions).toEqual([]);
  });

  it("accumulates entries across hops", () => {
    const orig = failure("boom");
    const hop1 = propagateFailure(orig, { name: "a", param: "x" });
    const hop2 = propagateFailure(hop1, { name: "b", param: "y" });
    expect(hop2.skippedFunctions).toEqual([
      { name: "a", param: "x" },
      { name: "b", param: "y" },
    ]);
  });
});

describe("mode resolution", () => {
  it("defaults to 'on' outside an execution frame", () => {
    expect(getFailurePropagationMode()).toBe("on");
  });
});

describe("acceptsFailures / isFailureTolerant", () => {
  it("tags a function and returns it", () => {
    const fn = (x: unknown) => x;
    expect(acceptsFailures(fn)).toBe(fn);
    expect(isFailureTolerant(fn)).toBe(true);
  });

  it("untagged functions are not tolerant; JSON.stringify is by identity", () => {
    expect(isFailureTolerant((x: unknown) => x)).toBe(false);
    expect(isFailureTolerant(JSON.stringify)).toBe(true);
    expect(isFailureTolerant("not a function")).toBe(false);
  });

  it("isSuccess/isFailure/success/failure ship pre-tagged (aliased use routes through __call)", () => {
    expect(isFailureTolerant(isSuccess)).toBe(true);
    expect(isFailureTolerant(isFailure)).toBe(true);
    expect(isFailureTolerant(success)).toBe(true);
    expect(isFailureTolerant(failure)).toBe(true);
  });
});

describe("checkFailureArgs", () => {
  const f = failure("boom", { functionName: "origin" });

  it("propagates when a rejecting param receives a failure", () => {
    const out = checkFailureArgs("target", [param("x", { acceptsResult: false })], [f]);
    expect(out).not.toBeNull();
    expect(out!.error).toBe("boom");
    expect(out!.skippedFunctions).toEqual([{ name: "target", param: "x" }]);
  });

  it("returns null for accepting params, legacy params, and non-failure args", () => {
    expect(checkFailureArgs("t", [param("x", { acceptsResult: true })], [f])).toBeNull();
    expect(checkFailureArgs("t", [param("x")], [f])).toBeNull(); // legacy fails open
    expect(checkFailureArgs("t", [param("x", { acceptsResult: false })], ["str"])).toBeNull();
    expect(checkFailureArgs("t", [param("x", { acceptsResult: false })], [success(1)])).toBeNull();
  });

  it("leftmost failure wins", () => {
    const g = failure("second");
    const out = checkFailureArgs(
      "t",
      [param("a", { acceptsResult: false }), param("b", { acceptsResult: false })],
      [f, g],
    );
    expect(out!.error).toBe("boom");
    expect(out!.skippedFunctions[0].param).toBe("a");
  });

  it("leftmost means leftmost REJECTING param: a failure on an accepting param is ignored", () => {
    const g = failure("second");
    const out = checkFailureArgs(
      "mix",
      [param("a", { acceptsResult: true }), param("b", { acceptsResult: false })],
      [f, g],
    );
    expect(out!.error).toBe("second");
    expect(out!.skippedFunctions).toEqual([{ name: "mix", param: "b" }]);
  });

  it("checks elements of a variadic param", () => {
    const out = checkFailureArgs(
      "t",
      [param("items", { variadic: true, acceptsResult: false })],
      [["ok", f]],
    );
    expect(out!.error).toBe("boom");
    expect(out!.skippedFunctions).toEqual([{ name: "t", param: "items" }]);
  });

  it("a failure nested in an array arg of a non-variadic param passes (shallow check)", () => {
    expect(checkFailureArgs("t", [param("x", { acceptsResult: false })], [[f]])).toBeNull();
  });

  it("emits a statelog warn event on skip", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "on",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
      const out = checkFailureArgs("t", [param("x", { acceptsResult: false })], [f]);
      expect(out).not.toBeNull();
    });
    expect(events).toHaveLength(1);
    expect(events[0].warnType).toBe("failurePropagation");
    expect(events[0].functionName).toBe("t");
    expect(events[0].param).toBe("x");
  });

  it("warn mode logs but does not propagate", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "warn",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
      const out = checkFailureArgs("t", [param("x", { acceptsResult: false })], [f]);
      expect(out).toBeNull();
    });
    expect(events).toHaveLength(1);
  });

  it("warn mode is a census: every rejecting hit logs, not just the leftmost", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "warn",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
      checkFailureArgs(
        "t",
        [param("a", { acceptsResult: false }), param("b", { acceptsResult: false })],
        [f, failure("second")],
      );
    });
    expect(events).toHaveLength(2);
  });

  it("off mode neither logs nor propagates", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "off",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
      const out = checkFailureArgs("t", [param("x", { acceptsResult: false })], [f]);
      expect(out).toBeNull();
    });
    expect(events).toHaveLength(0);
  });
});

describe("checkTsFunctionArgs", () => {
  const f = failure("boom", { functionName: "origin" });

  it("throws a plain Error naming the producer for untagged functions", () => {
    const target = function formatDate() {};
    expect(() => checkTsFunctionArgs(target, "formatDate", [f])).toThrowError(
      /formatDate.*origin/s,
    );
  });

  it("does not throw for tagged functions or non-failure args", () => {
    const tolerant = acceptsFailures(function logIt() {});
    expect(() => checkTsFunctionArgs(tolerant, "logIt", [f])).not.toThrow();
    const target = function formatDate() {};
    expect(() => checkTsFunctionArgs(target, "formatDate", ["x", 1])).not.toThrow();
  });

  it("a success arg does not throw (the check is failure-only)", () => {
    const target = function formatDate() {};
    expect(() => checkTsFunctionArgs(target, "formatDate", [success(1)])).not.toThrow();
  });

  it("warn mode logs without throwing; off mode does neither", () => {
    const target = function formatDate() {};
    for (const [mode, expectedLogs] of [["warn", 1], ["off", 0]] as const) {
      const events: any[] = [];
      const ctx: any = {
        failurePropagation: mode,
        statelogClient: { warn: (e: any) => { events.push(e); } },
      };
      agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
        expect(() => checkTsFunctionArgs(target, "formatDate", [f])).not.toThrow();
      });
      expect(events).toHaveLength(expectedLogs);
    }
  });
});

describe("checkResultMethodCall", () => {
  it("throws for a method call on a failure, naming the producer", () => {
    const f = failure("nope", { functionName: "getF" });
    expect(() => checkResultMethodCall(f, "split")).toThrowError(/split.*getF/s);
  });

  it("throws for a method call on a success, with the .value hint", () => {
    expect(() => checkResultMethodCall(success(5), "toFixed")).toThrowError(/\.value\./);
  });

  it("allows own-field callables (r.value holding a function or AgencyFunction)", () => {
    expect(() => checkResultMethodCall(success(() => 1), "value")).not.toThrow();
    const agencyLike = { __agencyFunction: true };
    expect(() => checkResultMethodCall(success(agencyLike), "value")).not.toThrow();
  });

  it("an own field that is NOT callable still throws (f.error() where error is a string)", () => {
    const f = failure("nope", { functionName: "getF" });
    expect(() => checkResultMethodCall(f, "error")).toThrowError(/error.*getF/s);
  });

  it("ignores non-Result objects", () => {
    expect(() => checkResultMethodCall({ split: undefined }, "split")).not.toThrow();
    expect(() => checkResultMethodCall("plain string", "split")).not.toThrow();
  });

  it("warn mode logs without throwing; off mode does neither", () => {
    const f = failure("nope", { functionName: "getF" });
    for (const [mode, expectedLogs] of [["warn", 1], ["off", 0]] as const) {
      const events: any[] = [];
      const ctx: any = {
        failurePropagation: mode,
        statelogClient: { warn: (e: any) => { events.push(e); } },
      };
      agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
        expect(() => checkResultMethodCall(f, "split")).not.toThrow();
      });
      expect(events).toHaveLength(expectedLogs);
    }
  });
});

import { AgencyFunction } from "./agencyFunction.js";

function makeFn(
  params: Array<Partial<FuncParam> & { name: string }>,
  fn: (...args: any[]) => any,
) {
  return new AgencyFunction({
    name: "target",
    module: "test.agency",
    fn,
    params: params.map((p) => ({
      hasDefault: false,
      defaultValue: undefined,
      variadic: false,
      ...p,
    })),
    toolDefinition: null,
  });
}

describe("invoke() failure propagation", () => {
  const f = failure("boom", { functionName: "origin" });

  it("skips the body and propagates for a rejecting param", async () => {
    let ran = false;
    const fn = makeFn([{ name: "text", acceptsResult: false }], () => { ran = true; });
    const out: any = await fn.invoke({ type: "positional", args: [f] });
    expect(ran).toBe(false);
    expect(isFailure(out)).toBe(true);
    expect(out.error).toBe("boom");
    expect(out.skippedFunctions).toEqual([{ name: "target", param: "text" }]);
  });

  it("runs the body for accepting and legacy params", async () => {
    const accepting = makeFn([{ name: "r", acceptsResult: true }], (r: unknown) => r);
    expect(isFailure(await accepting.invoke({ type: "positional", args: [f] }))).toBe(true);
    const legacy = makeFn([{ name: "r" }], (r: unknown) => "ran");
    expect(await legacy.invoke({ type: "positional", args: [f] })).toBe("ran");
  });

  it("checks values bound via .partial()", async () => {
    let ran = false;
    const fn = makeFn(
      [{ name: "a", acceptsResult: false }, { name: "b", acceptsResult: false }],
      () => { ran = true; },
    );
    const bound = fn.partial({ a: f });
    const out: any = await bound.invoke({ type: "positional", args: ["ok"] });
    expect(ran).toBe(false);
    expect(out.skippedFunctions).toEqual([{ name: "target", param: "a" }]);
  });

  it("checks named arguments", async () => {
    const fn = makeFn([{ name: "x", acceptsResult: false }], () => "ran");
    const out: any = await fn.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { x: f },
    });
    expect(out.skippedFunctions).toEqual([{ name: "target", param: "x" }]);
  });

  it("UNSET padding on an omitted defaulted param is skipped; a failure on a later param still trips", async () => {
    const fn = makeFn(
      [
        { name: "a", hasDefault: true, acceptsResult: false },
        { name: "b", acceptsResult: false },
      ],
      () => "ran",
    );
    const out: any = await fn.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: { b: f },
    });
    expect(out.skippedFunctions).toEqual([{ name: "target", param: "b" }]);
  });
});

import { __call, __callMethod } from "./call.js";

describe("dispatcher failure checks", () => {
  const f = failure("boom", { functionName: "origin" });

  it("__call: failure arg into an untagged plain TS function throws", async () => {
    const target = function formatDate() {};
    await expect(
      __call(target, { type: "positional", args: [f] }),
    ).rejects.toThrowError(/formatDate.*origin/s);
  });

  it("__call: tagged plain TS function receives the failure", async () => {
    const seen: unknown[] = [];
    const target = acceptsFailures((...args: unknown[]) => { seen.push(...args); });
    await __call(target, { type: "positional", args: [f] });
    expect(isFailure(seen[0])).toBe(true);
  });

  it("__call: calling a failure value gives the rich message", async () => {
    await expect(
      __call(f, { type: "positional", args: [] }),
    ).rejects.toThrowError(/failure value produced by 'origin'/);
  });

  it("__callMethod: method call on a failure throws the rich message", async () => {
    await expect(
      __callMethod(f, "split", { type: "positional", args: [" "] }),
    ).rejects.toThrowError(/split.*origin/s);
  });

  it("__callMethod: method call on a success throws with the .value hint", async () => {
    await expect(
      __callMethod(success(5), "toFixed", { type: "positional", args: [1] }),
    ).rejects.toThrowError(/\.value\./);
  });

  it("__callMethod: r.value() works when the success wraps a function", async () => {
    const s = success((n: number) => n + 1);
    const out = await __callMethod(s, "value", { type: "positional", args: [41] });
    expect(out).toBe(42);
  });

  it("__callMethod: method arguments are NOT scanned — arr.push(failure) works", async () => {
    // CRITICAL contract (plan-review finding 1): native prototype methods
    // are untagged plain functions, and collecting Results into arrays is
    // the pattern the shallow check exists to protect. The TS-function
    // argument scan therefore lives in __call ONLY.
    const arr: unknown[] = [];
    await __callMethod(arr, "push", { type: "positional", args: [f] });
    expect(arr).toHaveLength(1);
    const out = await __callMethod(arr, "includes", { type: "positional", args: [f] });
    expect(out).toBe(true);
  });

  it("__call: an ALIASED JSON.stringify accepts a failure by identity", async () => {
    const stringify = JSON.stringify;
    const out = await __call(stringify, { type: "positional", args: [f] });
    expect(typeof out).toBe("string");
  });
});

import { vi } from "vitest";
import { FAILURE_TOLERANT_BUILTINS } from "./failurePropagation.js";
import { DIRECT_CALL_FUNCTIONS } from "../backends/typescriptBuilder/nameClassifier.js";
import { truncate } from "./truncate.js";

describe("FAILURE_TOLERANT_BUILTINS sync tripwire", () => {
  it("every runtime failure-tolerant builtin is on the compiler DIRECT_CALL_FUNCTIONS list", () => {
    // The tolerance list only matters for ALIASED use because by-name calls
    // to DIRECT_CALL functions bypass the dispatcher. If an entry here is
    // NOT a direct-call function, either the entry is wrong or the
    // classifier changed — both need a human decision, so fail loudly.
    for (const fn of FAILURE_TOLERANT_BUILTINS) {
      expect(DIRECT_CALL_FUNCTIONS.has(fn.name), `${fn.name} missing from DIRECT_CALL_FUNCTIONS`).toBe(true);
    }
  });
});

describe("truncate hardening", () => {
  it("falls back to String() for values JSON.stringify throws on", () => {
    expect(truncate(BigInt(7))).toBe("7");
    const circular: any = { name: "loop" };
    circular.self = circular;
    expect(truncate(circular)).toBe("[object Object]");
  });
});

describe("warn-mode console echo", () => {
  it("is payload-free and says 'would be skipped' (nothing is skipped in warn mode)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ctx: any = { failurePropagation: "warn", statelogClient: { warn: () => {} } };
      agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
        checkFailureArgs(
          "target",
          [param("x", { acceptsResult: false })],
          [failure("SECRET-PAYLOAD", { functionName: "origin" })],
        );
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0][0] as string;
      expect(line).toContain("would be skipped");
      expect(line).toContain("target");
      expect(line).not.toContain("SECRET-PAYLOAD");
    } finally {
      spy.mockRestore();
    }
  });

  it("statelog warn event still carries the full detail (message + error)", () => {
    const events: any[] = [];
    const ctx: any = {
      failurePropagation: "warn",
      statelogClient: { warn: (e: any) => { events.push(e); } },
    };
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      agencyStore.run({ ctx, stack: null, threads: null } as any, () => {
        checkFailureArgs(
          "target",
          [param("x", { acceptsResult: false })],
          [failure("SECRET-PAYLOAD")],
        );
      });
    } finally {
      spy.mockRestore();
    }
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("SECRET-PAYLOAD");
    expect(events[0].message).toContain("would be skipped");
    expect(events[0].error).toBe("SECRET-PAYLOAD");
  });
});
