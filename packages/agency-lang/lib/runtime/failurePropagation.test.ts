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
      retryable: true,
      checkpoint: { step: 3 },
      args: { id: "abc" },
    });
    const propagated = propagateFailure(orig, { name: "wordCount", param: "text" });
    expect(propagated.skippedFunctions).toEqual([{ name: "wordCount", param: "text" }]);
    expect(propagated.error).toBe("boom");
    expect(propagated.functionName).toBe("getReport");
    expect(propagated.retryable).toBe(true);
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
