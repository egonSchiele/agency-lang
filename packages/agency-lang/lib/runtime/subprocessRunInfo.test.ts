import { describe, it, expect, vi, afterEach } from "vitest";
import { ipcChildDebug } from "./subprocessRunInfo.js";
import { agencyStore } from "./asyncContext.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ipcChildDebug", () => {
  it("posts a statelog debug event when an ALS frame has a statelog client", () => {
    const debugCalls: any[] = [];
    const store: any = {
      ctx: {
        statelogClient: {
          debug: (m: string, d: any) => { debugCalls.push([m, d]); return Promise.resolve(); },
        },
      },
    };
    agencyStore.run(store, () => {
      ipcChildDebug("callback_send_failed onNodeStart boom");
    });
    expect(debugCalls).toEqual([["[ipc:child] callback_send_failed onNodeStart boom", {}]]);
  });

  it("does not throw when there is no active ALS frame / statelog client", () => {
    expect(() => ipcChildDebug("callback_dropped_oversize onNodeStart")).not.toThrow();
  });

  it("swallows a throwing statelog client (never affects the run)", () => {
    const store: any = {
      ctx: { statelogClient: { debug: () => { throw new Error("statelog down"); } } },
    };
    expect(() =>
      agencyStore.run(store, () => { ipcChildDebug("callback_unserializable onNodeStart"); }),
    ).not.toThrow();
  });
});
