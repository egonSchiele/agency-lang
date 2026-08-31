import { describe, it, expect, afterEach } from "vitest";
import {
  registerModuleFingerprint,
  getModuleFingerprint,
  __resetModuleFingerprintRegistry,
} from "./moduleFingerprintRegistry.js";

afterEach(__resetModuleFingerprintRegistry);

describe("module fingerprint registry", () => {
  it("registers and reads back per moduleId", () => {
    registerModuleFingerprint("m1", "aaa", import.meta.url);
    const entry = getModuleFingerprint("m1")!;
    expect(entry.hash).toBe("aaa");
    // A real artifact URL yields its mtime as an ISO timestamp.
    expect(entry.compiledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getModuleFingerprint("m2")).toBeUndefined();
  });

  it("a non-file artifact URL degrades to an unknown timestamp", () => {
    registerModuleFingerprint("m1", "aaa", "not-a-url");
    expect(getModuleFingerprint("m1")).toEqual({ hash: "aaa", compiledAt: "unknown" });
  });

  it("re-registration overwrites (a reloaded module replaces its entry)", () => {
    registerModuleFingerprint("m1", "aaa", "not-a-url");
    registerModuleFingerprint("m1", "bbb", "not-a-url");
    expect(getModuleFingerprint("m1")!.hash).toBe("bbb");
  });

  it("reserved object-prototype names behave like any other moduleId", () => {
    expect(getModuleFingerprint("constructor")).toBeUndefined();
    registerModuleFingerprint("__proto__", "ccc", "not-a-url");
    expect(getModuleFingerprint("__proto__")!.hash).toBe("ccc");
  });
});
