import { describe, it, expect, afterEach } from "vitest";
import { collectModuleSourceHashes, assertCodeUnchanged } from "./referencedModules.js";
import {
  registerModuleSourceHash,
  __resetModuleSourceHashRegistry,
} from "./moduleSourceHashRegistry.js";
import { CheckpointCodeChangedError } from "./errors.js";

afterEach(__resetModuleSourceHashRegistry);

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

describe("collectModuleSourceHashes", () => {
  it("collects hashes for modules that have a frame and a registered hash", () => {
    registerModuleSourceHash("a.agency", "aaa");
    registerModuleSourceHash("b.agency", "bbb");
    const out = collectModuleSourceHashes(
      stack([frame("a.agency", "main"), frame("b.agency", "double")]) as any,
    );
    expect(out).toEqual({ "a.agency": "aaa", "b.agency": "bbb" });
  });

  it("skips unnamed/bootstrap frames and modules with no registered hash", () => {
    registerModuleSourceHash("a.agency", "aaa");
    const out = collectModuleSourceHashes(
      stack([frame("a.agency", "main"), frame("", ""), frame(null, "runPrompt")]) as any,
    );
    expect(out).toEqual({ "a.agency": "aaa" });
  });

  it("recurses into fork/parallel branch stacks", () => {
    registerModuleSourceHash("a.agency", "aaa");
    registerModuleSourceHash("w.agency", "ccc");
    const branchy = frame("a.agency", "main", {
      fork_1_0: { stack: stack([frame("w.agency", "worker")]) },
    });
    const out = collectModuleSourceHashes(stack([branchy]) as any);
    expect(out).toEqual({ "a.agency": "aaa", "w.agency": "ccc" });
  });
});

describe("assertCodeUnchanged", () => {
  it("throws when a referenced module changed or is missing", () => {
    registerModuleSourceHash("a.agency", "NEW");
    expect(() => assertCodeUnchanged({ "a.agency": "OLD" })).toThrow(CheckpointCodeChangedError);
    expect(() => assertCodeUnchanged({ "gone.agency": "OLD" })).toThrow(CheckpointCodeChangedError);
  });

  it("passes when all match, and on an undefined field", () => {
    registerModuleSourceHash("a.agency", "SAME");
    expect(() => assertCodeUnchanged({ "a.agency": "SAME" })).not.toThrow();
    expect(() => assertCodeUnchanged(undefined)).not.toThrow();
  });
});
