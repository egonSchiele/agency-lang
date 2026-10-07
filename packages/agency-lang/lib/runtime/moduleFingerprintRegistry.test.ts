import { describe, it, expect, afterEach } from "vitest";
import {
  registerModuleFingerprint,
  getModuleFingerprint,
  __resetModuleFingerprintRegistry,
} from "./moduleFingerprintRegistry.js";

afterEach(__resetModuleFingerprintRegistry);

describe("module fingerprint registry", () => {
  it("registers and reads back per moduleId", () => {
    registerModuleFingerprint("m1", "aaa");
    expect(getModuleFingerprint("m1")).toEqual({ hash: "aaa" });
    expect(getModuleFingerprint("m2")).toBeUndefined();
  });

  it("re-registration overwrites (a reloaded module replaces its entry)", () => {
    registerModuleFingerprint("m1", "aaa");
    registerModuleFingerprint("m1", "bbb");
    expect(getModuleFingerprint("m1")!.hash).toBe("bbb");
  });

  it("reserved object-prototype names behave like any other moduleId", () => {
    expect(getModuleFingerprint("constructor")).toBeUndefined();
    registerModuleFingerprint("__proto__", "ccc");
    expect(getModuleFingerprint("__proto__")!.hash).toBe("ccc");
  });
});
