import { describe, it, expect, afterEach } from "vitest";
import { collectModuleFingerprints, assertCodeUnchanged } from "./referencedModules.js";
import {
  registerModuleFingerprint,
  __resetModuleFingerprintRegistry,
} from "./moduleFingerprintRegistry.js";
import { CheckpointCodeChangedError } from "./errors.js";

afterEach(__resetModuleFingerprintRegistry);

// Fake artifact URLs: compiledAt degrades to "unknown", which is all these
// tests need — the check compares hashes.
const UNKNOWN = "unknown";

const frame = (moduleId: string | null, scopeName: string | null, branches?: any) => {
  const frameJson: any = { args: {}, locals: {}, threads: null, step: 0, moduleId, scopeName };
  if (branches) {
    frameJson.branches = branches;
  }
  return frameJson;
};
const stack = (frames: any[]) => ({
  stack: frames,
  mode: "serialize",
  other: {},
  deserializeStackLength: 0,
  nodesTraversed: [],
});

describe("collectModuleFingerprints", () => {
  it("collects fingerprints for modules that have a frame and a registered entry", () => {
    registerModuleFingerprint("a.agency", "aaa", "not-a-url");
    registerModuleFingerprint("b.agency", "bbb", "not-a-url");
    const out = collectModuleFingerprints(
      stack([frame("a.agency", "main"), frame("b.agency", "double")]) as any,
    );
    expect(out).toEqual({
      "a.agency": { hash: "aaa", compiledAt: UNKNOWN },
      "b.agency": { hash: "bbb", compiledAt: UNKNOWN },
    });
  });

  it("skips unnamed/bootstrap frames and modules with no registered entry", () => {
    registerModuleFingerprint("a.agency", "aaa", "not-a-url");
    const out = collectModuleFingerprints(
      stack([frame("a.agency", "main"), frame("", ""), frame(null, "runPrompt")]) as any,
    );
    expect(out).toEqual({ "a.agency": { hash: "aaa", compiledAt: UNKNOWN } });
  });

  it("recurses into fork/parallel branch stacks", () => {
    registerModuleFingerprint("a.agency", "aaa", "not-a-url");
    registerModuleFingerprint("w.agency", "ccc", "not-a-url");
    const branchy = frame("a.agency", "main", {
      fork_1_0: { stack: stack([frame("w.agency", "worker")]) },
    });
    const out = collectModuleFingerprints(stack([branchy]) as any);
    expect(out).toEqual({
      "a.agency": { hash: "aaa", compiledAt: UNKNOWN },
      "w.agency": { hash: "ccc", compiledAt: UNKNOWN },
    });
  });
});

describe("assertCodeUnchanged", () => {
  it("throws when a referenced module changed or is missing, naming both code versions", () => {
    registerModuleFingerprint("a.agency", "NEW", "not-a-url");
    expect(() =>
      assertCodeUnchanged({ "a.agency": { hash: "OLD", compiledAt: "2026-08-30T00:00:00.000Z" } }),
    ).toThrow(CheckpointCodeChangedError);
    try {
      assertCodeUnchanged({ "a.agency": { hash: "OLD", compiledAt: "2026-08-30T00:00:00.000Z" } });
    } catch (err) {
      expect((err as Error).message).toContain("a.agency");
      expect((err as Error).message).toContain("2026-08-30T00:00:00.000Z");
    }
    expect(() =>
      assertCodeUnchanged({ "gone.agency": { hash: "OLD", compiledAt: UNKNOWN } }),
    ).toThrow(CheckpointCodeChangedError);
  });

  it("passes when all match, and on an undefined field", () => {
    registerModuleFingerprint("a.agency", "SAME", "not-a-url");
    expect(() =>
      assertCodeUnchanged({ "a.agency": { hash: "SAME", compiledAt: UNKNOWN } }),
    ).not.toThrow();
    expect(() => assertCodeUnchanged(undefined)).not.toThrow();
  });
});
