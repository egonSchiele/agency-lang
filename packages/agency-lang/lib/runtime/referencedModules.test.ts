import { describe, it, expect, afterEach } from "vitest";
import { collectModuleFingerprints, assertCodeUnchanged } from "./referencedModules.js";
import {
  registerModuleFingerprint,
  __resetModuleFingerprintRegistry,
} from "./moduleFingerprintRegistry.js";
import { CheckpointCodeChangedError } from "./errors.js";

afterEach(__resetModuleFingerprintRegistry);

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
    registerModuleFingerprint("a.agency", "aaa");
    registerModuleFingerprint("b.agency", "bbb");
    const out = collectModuleFingerprints(
      stack([frame("a.agency", "main"), frame("b.agency", "double")]) as any,
    );
    expect(out).toEqual({
      "a.agency": { hash: "aaa" },
      "b.agency": { hash: "bbb" },
    });
  });

  it("skips unnamed/bootstrap frames and modules with no registered entry", () => {
    registerModuleFingerprint("a.agency", "aaa");
    const out = collectModuleFingerprints(
      stack([frame("a.agency", "main"), frame("", ""), frame(null, "runPrompt")]) as any,
    );
    expect(out).toEqual({ "a.agency": { hash: "aaa" } });
  });

  it("recurses into fork/parallel branch stacks", () => {
    registerModuleFingerprint("a.agency", "aaa");
    registerModuleFingerprint("w.agency", "ccc");
    const branchy = frame("a.agency", "main", {
      fork_1_0: { stack: stack([frame("w.agency", "worker")]) },
    });
    const out = collectModuleFingerprints(stack([branchy]) as any);
    expect(out).toEqual({
      "a.agency": { hash: "aaa" },
      "w.agency": { hash: "ccc" },
    });
  });
});

describe("assertCodeUnchanged", () => {
  it("throws when a referenced module changed or is missing, naming both fingerprints", () => {
    registerModuleFingerprint("a.agency", "NEW");
    expect(() => assertCodeUnchanged({ "a.agency": { hash: "OLD" } })).toThrow(
      CheckpointCodeChangedError,
    );
    try {
      assertCodeUnchanged({ "a.agency": { hash: "OLD" } });
    } catch (err) {
      expect((err as Error).message).toContain("a.agency");
      expect((err as Error).message).toContain("fingerprint OLD");
      expect((err as Error).message).toContain("fingerprint NEW");
    }
    expect(() => assertCodeUnchanged({ "gone.agency": { hash: "OLD" } })).toThrow(
      CheckpointCodeChangedError,
    );
  });

  it("passes when all match, and on an undefined field", () => {
    registerModuleFingerprint("a.agency", "SAME");
    expect(() => assertCodeUnchanged({ "a.agency": { hash: "SAME" } })).not.toThrow();
    expect(() => assertCodeUnchanged(undefined)).not.toThrow();
  });
});
