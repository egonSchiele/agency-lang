import { describe, expect, it } from "vitest";
import { makeCheckpoint } from "./checkpointTestHelpers.js";
import { applyLocalOverrides, applyRestoreOverrides } from "./resumeSetup.js";
import { GlobalStore } from "./state/globalStore.js";
import { StateStack } from "./state/stateStack.js";

describe("resume setup", () => {
  it("applies local overrides without mutating the source checkpoint", () => {
    const source = makeCheckpoint({ mood: "sad", count: 1 });

    const changed = applyLocalOverrides(source, { mood: "happy" });

    expect(StateStack.lastFrameJSON(changed.stack).locals).toEqual({ mood: "happy", count: 1 });
    expect(StateStack.lastFrameJSON(source.stack).locals).toEqual({ mood: "sad", count: 1 });
  });

  it("rejects prototype-mutating local overrides from programmatic callers", () => {
    const source = makeCheckpoint({ mood: "sad" });
    const overrides = JSON.parse('{"__proto__":{"polluted":true}}');

    expect(() => applyLocalOverrides(source, overrides)).toThrow("invalid override name");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("applies argument and checkpoint-module global overrides", () => {
    const checkpoint = makeCheckpoint({}, { name: "before" });
    checkpoint.moduleId = "fixture.agency";
    checkpoint.nodeId = "main";
    StateStack.lastFrameJSON(checkpoint.stack).scopeName = "greet";
    const stateStack = StateStack.fromJSON(checkpoint.stack);
    const globals = GlobalStore.fromJSON(checkpoint.globals);
    const target = {
      stateStack,
      globals,
      _pendingArgOverrides: undefined,
    };

    applyRestoreOverrides(target, checkpoint, {
      args: { name: "after" },
      globals: { enabled: true },
    });

    expect(target._pendingArgOverrides).toEqual({
      moduleId: "",
      scopeName: "greet",
      values: { name: "after" },
    });
    expect(globals.get("fixture.agency", "enabled")).toBe(true);
  });

  it("queues argument overrides only for a paused function frame", () => {
    const nodeCheckpoint = makeCheckpoint({}, { name: "before" });
    nodeCheckpoint.nodeId = "main";
    StateStack.lastFrameJSON(nodeCheckpoint.stack).scopeName = "main";
    const nodeTarget = {
      stateStack: StateStack.fromJSON(nodeCheckpoint.stack),
      globals: GlobalStore.fromJSON(nodeCheckpoint.globals),
      _pendingArgOverrides: undefined,
    };

    applyRestoreOverrides(nodeTarget, nodeCheckpoint, { args: { name: "after" } });

    expect(nodeTarget._pendingArgOverrides).toBeUndefined();

    const functionCheckpoint = makeCheckpoint({}, { name: "before" });
    functionCheckpoint.nodeId = "main";
    StateStack.lastFrameJSON(functionCheckpoint.stack).scopeName = "greet";
    const functionTarget = {
      stateStack: StateStack.fromJSON(functionCheckpoint.stack),
      globals: GlobalStore.fromJSON(functionCheckpoint.globals),
      _pendingArgOverrides: undefined,
    };

    applyRestoreOverrides(functionTarget, functionCheckpoint, { args: { name: "after" } });

    expect(functionTarget._pendingArgOverrides).toEqual({
      moduleId: "",
      scopeName: "greet",
      values: { name: "after" },
    });
  });

  it("rejects prototype-mutating argument and global overrides", () => {
    const checkpoint = makeCheckpoint();
    checkpoint.moduleId = "fixture.agency";
    const target = {
      stateStack: StateStack.fromJSON(checkpoint.stack),
      globals: GlobalStore.fromJSON(checkpoint.globals),
      _pendingArgOverrides: undefined,
    };
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');

    expect(() => applyRestoreOverrides(target, checkpoint, { args: polluted })).toThrow(
      "invalid override name",
    );
    expect(() => applyRestoreOverrides(target, checkpoint, { globals: polluted })).toThrow(
      "invalid override name",
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects a prototype property as the global module id", () => {
    const checkpoint = makeCheckpoint();
    checkpoint.moduleId = "__proto__";
    const target = {
      stateStack: StateStack.fromJSON(checkpoint.stack),
      globals: GlobalStore.fromJSON(checkpoint.globals),
    };

    expect(() => applyRestoreOverrides(target, checkpoint, { globals: { enabled: true } })).toThrow(
      "invalid module id",
    );
  });

  it("does nothing when no overrides are supplied", () => {
    const checkpoint = makeCheckpoint();
    const stateStack = StateStack.fromJSON(checkpoint.stack);
    const globals = GlobalStore.fromJSON(checkpoint.globals);
    const target = { stateStack, globals, _pendingArgOverrides: undefined };

    applyRestoreOverrides(target, checkpoint);

    expect(target._pendingArgOverrides).toBeUndefined();
    expect(globals.toJSON()).toEqual(checkpoint.globals);
  });
});
