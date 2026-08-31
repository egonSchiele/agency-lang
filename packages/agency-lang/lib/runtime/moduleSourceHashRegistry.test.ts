import { describe, it, expect, afterEach } from "vitest";
import {
  registerModuleSourceHash,
  getModuleSourceHash,
  __resetModuleSourceHashRegistry,
} from "./moduleSourceHashRegistry.js";

afterEach(__resetModuleSourceHashRegistry);

describe("module source hash registry", () => {
  it("registers and reads back per moduleId", () => {
    registerModuleSourceHash("m1", "aaa", "2026-08-30T00:00:00.000Z");
    expect(getModuleSourceHash("m1")).toEqual({
      hash: "aaa",
      compiledAt: "2026-08-30T00:00:00.000Z",
    });
    expect(getModuleSourceHash("m2")).toBeUndefined();
  });

  it("re-registration overwrites (a reloaded module replaces its entry)", () => {
    registerModuleSourceHash("m1", "aaa", "2026-08-30T00:00:00.000Z");
    registerModuleSourceHash("m1", "bbb", "2026-08-31T00:00:00.000Z");
    expect(getModuleSourceHash("m1")!.hash).toBe("bbb");
  });

  it("reserved object-prototype names behave like any other moduleId", () => {
    expect(getModuleSourceHash("constructor")).toBeUndefined();
    registerModuleSourceHash("__proto__", "ccc", "2026-08-30T00:00:00.000Z");
    expect(getModuleSourceHash("__proto__")!.hash).toBe("ccc");
  });
});
