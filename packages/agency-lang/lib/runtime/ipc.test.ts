import { describe, it, expect } from "vitest";
import { clampLimits } from "./ipc.js";

describe("clampLimits", () => {
  it("clamps wallClock above 1h to 1h", () => {
    const out = clampLimits({
      wallClock: 10 * 60 * 60 * 1000,
      memory: 1,
      ipcPayload: 1,
      stdout: 1,
    });
    expect(out.wallClock).toBe(60 * 60 * 1000);
  });

  it("clamps memory above 4gb to 4gb", () => {
    const out = clampLimits({
      wallClock: 1,
      memory: 8 * 1024 * 1024 * 1024,
      ipcPayload: 1,
      stdout: 1,
    });
    expect(out.memory).toBe(4 * 1024 * 1024 * 1024);
  });

  it("clamps ipcPayload above 1gb to 1gb", () => {
    const out = clampLimits({
      wallClock: 1,
      memory: 1,
      ipcPayload: 4 * 1024 * 1024 * 1024,
      stdout: 1,
    });
    expect(out.ipcPayload).toBe(1024 * 1024 * 1024);
  });

  it("clamps stdout above 100mb to 100mb", () => {
    const out = clampLimits({
      wallClock: 1,
      memory: 1,
      ipcPayload: 1,
      stdout: 500 * 1024 * 1024,
    });
    expect(out.stdout).toBe(100 * 1024 * 1024);
  });

  it("leaves below-ceiling values unchanged", () => {
    const out = clampLimits({
      wallClock: 30000,
      memory: 256 * 1024 * 1024,
      ipcPayload: 1024,
      stdout: 512,
    });
    expect(out).toEqual({
      wallClock: 30000,
      memory: 256 * 1024 * 1024,
      ipcPayload: 1024,
      stdout: 512,
    });
  });
});
