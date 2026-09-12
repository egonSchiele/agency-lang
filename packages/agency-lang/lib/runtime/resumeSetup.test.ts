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

  it("applies argument and checkpoint-module global overrides", () => {
    const checkpoint = makeCheckpoint({}, { name: "before" });
    checkpoint.moduleId = "fixture.agency";
    const stateStack = StateStack.fromJSON(checkpoint.stack);
    const globals = GlobalStore.fromJSON(checkpoint.globals);
    const target = {
      stateStack,
      globals,
      _pendingArgOverrides: undefined as Record<string, unknown> | undefined,
    };

    applyRestoreOverrides(target, checkpoint, {
      args: { name: "after" },
      globals: { enabled: true },
    });

    expect(target._pendingArgOverrides).toEqual({ name: "after" });
    expect(globals.get("fixture.agency", "enabled")).toBe(true);
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
