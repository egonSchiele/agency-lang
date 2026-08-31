import { describe, it, expect, afterEach } from "vitest";
import {
  registerModuleSourceHash,
  getModuleSourceHash,
  __resetModuleSourceHashRegistry,
} from "./moduleSourceHashRegistry.js";

afterEach(__resetModuleSourceHashRegistry);

describe("module source hash registry", () => {
  it("registers and reads back per moduleId", () => {
    registerModuleSourceHash("m1", "aaa");
    expect(getModuleSourceHash("m1")).toBe("aaa");
    expect(getModuleSourceHash("m2")).toBeUndefined();
  });

  it("re-registration overwrites (a reloaded module replaces its hash)", () => {
    registerModuleSourceHash("m1", "aaa");
    registerModuleSourceHash("m1", "bbb");
    expect(getModuleSourceHash("m1")).toBe("bbb");
  });
});
