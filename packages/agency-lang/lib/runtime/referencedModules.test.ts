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
    registerModuleSourceHash("a.agency", "aaa", "T1");
    registerModuleSourceHash("b.agency", "bbb", "T1");
    const out = collectModuleSourceHashes(
      stack([frame("a.agency", "main"), frame("b.agency", "double")]) as any,
    );
    expect(out).toEqual({
      "a.agency": { hash: "aaa", compiledAt: "T1" },
      "b.agency": { hash: "bbb", compiledAt: "T1" },
    });
  });

  it("skips unnamed/bootstrap frames and modules with no registered hash", () => {
    registerModuleSourceHash("a.agency", "aaa", "T1");
    const out = collectModuleSourceHashes(
      stack([frame("a.agency", "main"), frame("", ""), frame(null, "runPrompt")]) as any,
    );
    expect(out).toEqual({ "a.agency": { hash: "aaa", compiledAt: "T1" } });
  });

  it("recurses into fork/parallel branch stacks", () => {
    registerModuleSourceHash("a.agency", "aaa", "T1");
    registerModuleSourceHash("w.agency", "ccc", "T1");
    const branchy = frame("a.agency", "main", {
      fork_1_0: { stack: stack([frame("w.agency", "worker")]) },
    });
    const out = collectModuleSourceHashes(stack([branchy]) as any);
    expect(out).toEqual({
      "a.agency": { hash: "aaa", compiledAt: "T1" },
      "w.agency": { hash: "ccc", compiledAt: "T1" },
    });
  });
});

describe("assertCodeUnchanged", () => {
  it("throws when a referenced module changed or is missing", () => {
    registerModuleSourceHash("a.agency", "NEW", "T2");
    expect(() => assertCodeUnchanged({ "a.agency": { hash: "OLD", compiledAt: "T1" } })).toThrow(
      CheckpointCodeChangedError,
    );
    expect(() => assertCodeUnchanged({ "gone.agency": { hash: "OLD", compiledAt: "T1" } })).toThrow(
      CheckpointCodeChangedError,
    );
  });

  it("passes when all match, and on an undefined field", () => {
    registerModuleSourceHash("a.agency", "SAME", "T1");
    expect(() =>
      assertCodeUnchanged({ "a.agency": { hash: "SAME", compiledAt: "T1" } }),
    ).not.toThrow();
    expect(() => assertCodeUnchanged(undefined)).not.toThrow();
  });
});
