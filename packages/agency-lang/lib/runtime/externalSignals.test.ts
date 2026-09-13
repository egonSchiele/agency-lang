import { describe, it, expect } from "vitest";
import {
  attachAbortSignal,
  attachPauseSignal,
  withExternalSignals,
  type SignalTarget,
} from "./externalSignals.js";
import { AgencyCancelledError } from "./errors.js";

type FakeTarget = SignalTarget & { cancelled: number };

function fakeTarget(): FakeTarget {
  const target: FakeTarget = {
    pauseRequested: false,
    cancelled: 0,
    cancel() {
      target.cancelled++;
    },
  };
  return target;
}

describe("attachPauseSignal", () => {
  it("does nothing without a signal and returns a no-op detach", () => {
    const target = fakeTarget();
    const detach = attachPauseSignal(target, undefined);
    detach();
    expect(target.pauseRequested).toBe(false);
  });

  it("sets the flag at once for an already-aborted signal", () => {
    const target = fakeTarget();
    const ctl = new AbortController();
    ctl.abort();
    attachPauseSignal(target, ctl.signal);
    expect(target.pauseRequested).toBe(true);
  });

  it("sets the flag when the signal fires later", () => {
    const target = fakeTarget();
    const ctl = new AbortController();
    attachPauseSignal(target, ctl.signal);
    expect(target.pauseRequested).toBe(false);
    ctl.abort();
    expect(target.pauseRequested).toBe(true);
  });

  it("does nothing after detach", () => {
    const target = fakeTarget();
    const ctl = new AbortController();
    const detach = attachPauseSignal(target, ctl.signal);
    detach();
    ctl.abort();
    expect(target.pauseRequested).toBe(false);
  });
});

describe("attachAbortSignal", () => {
  it("throws AgencyCancelledError for an already-aborted signal", () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(() => attachAbortSignal(fakeTarget(), ctl.signal)).toThrow(AgencyCancelledError);
  });

  it("cancels the target when the signal fires later", () => {
    const target = fakeTarget();
    const ctl = new AbortController();
    attachAbortSignal(target, ctl.signal);
    expect(target.cancelled).toBe(0);
    ctl.abort();
    expect(target.cancelled).toBe(1);
  });

  it("does nothing after detach", () => {
    const target = fakeTarget();
    const ctl = new AbortController();
    const detach = attachAbortSignal(target, ctl.signal);
    detach();
    ctl.abort();
    expect(target.cancelled).toBe(0);
  });
});

describe("withExternalSignals", () => {
  it("attaches for the body and detaches after it returns", async () => {
    const target = fakeTarget();
    const pause = new AbortController();
    const cancel = new AbortController();
    const value = await withExternalSignals(
      target,
      { pauseSignal: pause.signal, abortSignal: cancel.signal },
      async () => {
        pause.abort();
        return "done";
      },
    );
    expect(value).toBe("done");
    expect(target.pauseRequested).toBe(true);
    cancel.abort();
    expect(target.cancelled).toBe(0);
  });

  it("detaches when the body throws", async () => {
    const target = fakeTarget();
    const cancel = new AbortController();
    await expect(
      withExternalSignals(target, { abortSignal: cancel.signal }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    cancel.abort();
    expect(target.cancelled).toBe(0);
  });

  it("throws before the body for an already-aborted abort signal", async () => {
    const cancel = new AbortController();
    cancel.abort();
    let ran = false;
    await expect(
      withExternalSignals(fakeTarget(), { abortSignal: cancel.signal }, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(AgencyCancelledError);
    expect(ran).toBe(false);
  });
});
