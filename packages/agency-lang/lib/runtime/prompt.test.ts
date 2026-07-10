import { describe, it, expect, vi } from "vitest";
import { SmolError } from "smoltalk";
import { _internal } from "./prompt.js";
import { AgencyCancelledError, makeAbortCause, readCause } from "./errors.js";

const {
  DEFAULT_TOOL_RESULT_CHARS,
  stringifyToolResult,
  capToolResultForLlm,
  assertUniqueToolNames,
} = _internal;

describe("assertUniqueToolNames", () => {
  it("accepts a list of distinct tool names", () => {
    expect(() =>
      assertUniqueToolNames([{ name: "read" }, { name: "write" }]),
    ).not.toThrow();
  });

  it("accepts an empty list", () => {
    expect(() => assertUniqueToolNames([])).not.toThrow();
  });

  it("throws naming the duplicate (the skillsDir/read regression)", () => {
    // Four skillsDir tools used to all be named `read` (read.partial keeps
    // the base name), which Anthropic rejects with an opaque 400.
    expect(() =>
      assertUniqueToolNames([
        { name: "read" },
        { name: "read" },
        { name: "read" },
        { name: "write" },
      ]),
    ).toThrow(/Duplicate tool name\(s\).*"read" \(×3\)/s);
  });

  it("points at .rename() in the message", () => {
    expect(() =>
      assertUniqueToolNames([{ name: "x" }, { name: "x" }]),
    ).toThrow(/\.rename\(/);
  });
});

describe("stringifyToolResult", () => {
  it("passes strings through unchanged", () => {
    expect(stringifyToolResult("hello")).toBe("hello");
  });

  it("JSON-stringifies objects/arrays", () => {
    expect(stringifyToolResult({ a: 1 })).toBe('{"a":1}');
    expect(stringifyToolResult([1, 2])).toBe("[1,2]");
  });

  it("falls back to String() on circular structures", () => {
    const a: any = {};
    a.self = a;
    // Does not throw; returns some string representation.
    expect(typeof stringifyToolResult(a)).toBe("string");
  });
});

describe("capToolResultForLlm", () => {
  it("returns the original value untouched when within the cap", () => {
    const obj = { big: "x".repeat(100) };
    // Object under cap → returned as-is (object identity), so smoltalk
    // serializes it exactly as before — no behavior change.
    expect(capToolResultForLlm(obj, 1000)).toBe(obj);
    expect(capToolResultForLlm("short", 1000)).toBe("short");
  });

  it("truncates an over-cap string and appends a marker", () => {
    const out = capToolResultForLlm("a".repeat(5000), 100) as string;
    expect(typeof out).toBe("string");
    expect(out.startsWith("a".repeat(100))).toBe(true);
    expect(out).toContain("truncated");
    // Marker reports the original length.
    expect(out).toContain("of 5000");
    // First `cap` chars are preserved verbatim before the marker.
    expect(out.slice(0, 100)).toBe("a".repeat(100));
  });

  it("truncates an over-cap object (by its serialized form)", () => {
    const big = { data: "y".repeat(5000) };
    const out = capToolResultForLlm(big, 100);
    expect(typeof out).toBe("string");
    expect(out).toContain("truncated");
  });

  it("cap of 0 disables the cap (returns original)", () => {
    const huge = "z".repeat(1_000_000);
    expect(capToolResultForLlm(huge, 0)).toBe(huge);
  });

  it("non-finite cap (Infinity) disables the cap", () => {
    const huge = "z".repeat(1_000_000);
    expect(capToolResultForLlm(huge, Infinity)).toBe(huge);
  });

  it("default cap is 100000 characters", () => {
    expect(DEFAULT_TOOL_RESULT_CHARS).toBe(100_000);
    const justOver = "q".repeat(DEFAULT_TOOL_RESULT_CHARS + 1);
    const out = capToolResultForLlm(justOver, DEFAULT_TOOL_RESULT_CHARS) as string;
    expect(out.slice(0, DEFAULT_TOOL_RESULT_CHARS)).toBe(
      "q".repeat(DEFAULT_TOOL_RESULT_CHARS),
    );
    expect(out).toContain("truncated");
  });
});

describe("armCallTimeout", () => {
  it("aborts with a callTimeout cause after limitMs", () => {
    vi.useFakeTimers();
    const { signal, dispose } = _internal.armCallTimeout(undefined, 1000);
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(signal!.aborted).toBe(true);
    expect(readCause(signal!)?.kind).toBe("callTimeout");
    expect((readCause(signal!) as { limitMs: number }).limitMs).toBe(1000);
    dispose();
    vi.useRealTimers();
  });

  it("limitMs <= 0 with no parent returns undefined (no cast lie)", () => {
    const { signal } = _internal.armCallTimeout(undefined, 0);
    expect(signal).toBeUndefined();
  });

  it("limitMs <= 0 with a parent passes it through", () => {
    const parent = new AbortController().signal;
    const { signal } = _internal.armCallTimeout(parent, 0);
    expect(signal).toBe(parent);
  });
});

describe("runWithRetry", () => {
  const policy = { retries: 2, timeout: 0, backoff: { initial: 1, factor: 2, max: 10 } };
  const noHooks = { onRetry: async () => {}, onTimeout: async () => {} };
  // Test normalizer: read status off a SmolError, else just the message.
  const normalize = (err: unknown) => {
    if (err instanceof SmolError && err.status !== undefined) {
      return { status: err.status, message: err.message };
    }
    if (err instanceof Error) {
      return { message: err.message };
    }
    return { message: String(err) };
  };

  it("retries a transient error then succeeds; onLLMRetry fires per retry", async () => {
    let calls = 0;
    const fired: Array<{ attempt: number; maxRetries: number; reason: string; delayMs: number }> = [];
    const dispatch = async () => {
      if (calls < 2) {
        calls += 1;
        throw new Error("ECONNRESET");
      }
      return "ok";
    };
    const hooks = {
      onRetry: (d: { attempt: number; maxRetries: number; reason: string; delayMs: number }) => {
        fired.push(d);
      },
      onTimeout: async () => {},
    };

    const result = await _internal.runWithRetry(dispatch, policy, undefined, hooks, normalize);

    expect(result).toBe("ok");
    expect(fired.map((f) => f.reason)).toEqual(["connectionLost", "connectionLost"]);
    expect(fired[0]).toMatchObject({ attempt: 1, maxRetries: 2 });
    expect(fired[1].delayMs).toBeGreaterThanOrEqual(fired[0].delayMs);
  });

  it("surfaces a plain Error (→ Failure) classified by reason after exhausting retries", async () => {
    const dispatch = async () => {
      throw new SmolError("503", { status: 503 });
    };

    // A plain Error (NOT an AgencyAbort), so the catch ladder converts it to a
    // Failure instead of aborting the run. Reason is in the message.
    const promise = _internal.runWithRetry(dispatch, policy, undefined, noHooks, normalize);
    await expect(promise).rejects.toThrow(/serverError/);
    await expect(promise).rejects.not.toHaveProperty("agencyCause");
  });

  it("#9 never swallows a user cancel during the backoff sleep", async () => {
    const ac = new AbortController();
    const dispatch = async () => {
      throw new Error("ECONNRESET");
    };
    const hooks = {
      onRetry: () => {
        ac.abort(new AgencyCancelledError(undefined, makeAbortCause({ kind: "userInterrupt" })));
      },
      onTimeout: async () => {},
    };

    const promise = _internal.runWithRetry(dispatch, policy, ac.signal, hooks, normalize);

    await expect(promise).rejects.toSatisfy((e: unknown) => readCause(e)?.kind === "userInterrupt");
  });

  it("#8 timeout with retries:0 fires onLLMTimeout once, no retry, surfaces", async () => {
    vi.useFakeTimers();
    const timeoutPolicy = { retries: 0, timeout: 20, backoff: policy.backoff };
    let timeouts = 0;
    const dispatch = (signal: AbortSignal | undefined) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    };
    const hooks = {
      onRetry: async () => {},
      onTimeout: () => {
        timeouts += 1;
      },
    };

    const promise = _internal.runWithRetry(dispatch, timeoutPolicy, undefined, hooks, normalize);
    // Attach the rejection handler BEFORE advancing timers so the rejection
    // (which fires during advanceTimersByTimeAsync) is never momentarily unhandled.
    // The exhausted timeout surfaces as a plain Error (→ Failure), not an abort.
    const settled = expect(promise).rejects.toThrow(/timeout|exceeded/);
    await vi.advanceTimersByTimeAsync(20);
    await settled;
    expect(timeouts).toBe(1);
    vi.useRealTimers();
  });

  it("#10 a retried timeout fires onLLMTimeout BEFORE onLLMRetry", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let calls = 0;
    const dispatch = (signal: AbortSignal | undefined) => {
      if (calls === 0) {
        calls += 1;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        });
      }
      return Promise.resolve("ok");
    };
    const hooks = {
      onRetry: () => {
        order.push("retry");
      },
      onTimeout: () => {
        order.push("timeout");
      },
    };
    const timeoutPolicy = { retries: 1, timeout: 20, backoff: { initial: 1, factor: 2, max: 5 } };

    const promise = _internal.runWithRetry(dispatch, timeoutPolicy, undefined, hooks, normalize);
    await vi.advanceTimersByTimeAsync(30);
    await promise;

    expect(order).toEqual(["timeout", "retry"]);
    vi.useRealTimers();
  });

  it("the exhaustion message reads 'attempt(s)', not 'retries' (so retries:0 reads correctly)", async () => {
    const zeroRetryPolicy = { retries: 0, timeout: 0, backoff: policy.backoff };
    const dispatch = async () => {
      throw new SmolError("503", { status: 503 });
    };
    await expect(
      _internal.runWithRetry(dispatch, zeroRetryPolicy, undefined, noHooks, normalize),
    ).rejects.toThrow(/after 1 attempt/);

    // retries:2 + always-failing → 3 attempts (1 initial + 2 retries).
    await expect(
      _internal.runWithRetry(dispatch, policy, undefined, noHooks, normalize),
    ).rejects.toThrow(/after 3 attempts/);
  });

  it("parent abort with a non-callTimeout cause wins a race with callTimeout", async () => {
    // Regression: previously, if AbortSignal.any saw `callTimeout` before the
    // parent's `userInterrupt`, the loop rethrew the `callTimeout` error and
    // the real cancel cause was masked. The fix surfaces the parent's cause.
    const parent = new AbortController();
    // Pre-abort the parent with a userInterrupt — the dispatch will see a
    // signal that's already aborted with TWO causes racing (parent +
    // callTimeout). We want the parent's cause to win.
    parent.abort(new AgencyCancelledError(undefined, makeAbortCause({ kind: "userInterrupt" })));

    const dispatch = (signal: AbortSignal | undefined) => {
      // Reject with whatever cause the composed signal carries. With the
      // parent already aborted, signal.reason may be either cause depending
      // on AbortSignal.any's ordering — the loop must still propagate the
      // parent's cause.
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason));
      });
    };

    await expect(
      _internal.runWithRetry(dispatch, policy, parent.signal, noHooks, normalize),
    ).rejects.toSatisfy((e: unknown) => readCause(e)?.kind === "userInterrupt");
  });
});

describe("dropNullDefaultedArgs", () => {
  const P = (name: string, hasDefault: boolean) => ({
    name,
    hasDefault,
    defaultValue: undefined,
    variadic: false,
  });

  it("drops a null argument when the param has a default (LLM omitted it)", () => {
    // Mirrors the real bug: bash(command, cwd: null) — cwd has a default of "".
    const params = [P("command", false), P("cwd", true), P("timeout", true)];
    const out = _internal.dropNullDefaultedArgs(
      { command: "ls", cwd: null, timeout: null },
      params,
    );
    expect(out).toEqual({ command: "ls" });
    expect("cwd" in out).toBe(false);
    expect("timeout" in out).toBe(false);
  });

  it("keeps a null argument when the param has NO default", () => {
    // A required (or intentionally-nullable) param keeps its value so the
    // normal type error still surfaces for the model to correct.
    const params = [P("target", false)];
    expect(_internal.dropNullDefaultedArgs({ target: null }, params))
      .toEqual({ target: null });
  });

  it("leaves non-null values untouched, including falsy ones", () => {
    const params = [P("cwd", true), P("count", true), P("flag", true)];
    const out = _internal.dropNullDefaultedArgs(
      { cwd: "/app", count: 0, flag: false },
      params,
    );
    expect(out).toEqual({ cwd: "/app", count: 0, flag: false });
  });

  it("handles null/undefined argument objects", () => {
    expect(_internal.dropNullDefaultedArgs(null, [P("cwd", true)])).toEqual({});
    expect(_internal.dropNullDefaultedArgs(undefined, [P("cwd", true)])).toEqual({});
  });

  it("does not drop keys absent from the param list", () => {
    // An arg with no matching param (e.g. an LLM hallucinated key) is left
    // as-is; only declared defaulted params are considered.
    const out = _internal.dropNullDefaultedArgs(
      { extra: null },
      [P("cwd", true)],
    );
    expect(out).toEqual({ extra: null });
  });
});
