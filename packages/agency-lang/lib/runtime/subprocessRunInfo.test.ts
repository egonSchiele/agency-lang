import { describe, it, expect, vi, afterEach } from "vitest";
import { ipcChildDebug } from "./subprocessRunInfo.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ipcChildDebug", () => {
  it("posts a statelog debug event to the logger it is handed", () => {
    const debugCalls: any[] = [];
    const store: any = {
      ctx: {
        statelogClient: {
          debug: (m: string, d: any) => {
            debugCalls.push([m, d]);
            return Promise.resolve();
          },
        },
      },
    };
    ipcChildDebug("callback_send_failed onNodeStart boom", store.ctx.statelogClient);
    expect(debugCalls).toEqual([["[ipc:child] callback_send_failed onNodeStart boom", {}]]);
  });

  it("does not throw when it is handed no logger", () => {
    expect(() => ipcChildDebug("callback_dropped_oversize onNodeStart", undefined)).not.toThrow();
  });

  it("swallows a throwing statelog client (never affects the run)", () => {
    const store: any = {
      ctx: {
        statelogClient: {
          debug: () => {
            throw new Error("statelog down");
          },
        },
      },
    };
    expect(() =>
      ipcChildDebug("callback_unserializable onNodeStart", store.ctx.statelogClient),
    ).not.toThrow();
  });
});
