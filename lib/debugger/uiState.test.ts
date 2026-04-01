import { describe, it, expect } from "vitest";
import { UIState } from "./uiState.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { StateStackJSON, StateJSON } from "../runtime/state/stateStack.js";
import type { GlobalStoreJSON } from "../runtime/state/globalStore.js";
import type { SourceMap } from "@/backends/sourceMap.js";

function makeStackJSON(frames: Partial<StateJSON>[] = []): StateStackJSON {
  return {
    stack: frames.map((f) => ({
      args: f.args ?? {},
      locals: f.locals ?? {},
      threads: f.threads ?? null,
      step: f.step ?? 0,
      ...(f.branches ? { branches: f.branches } : {}),
    })),
    mode: "serialize",
    other: {},
    deserializeStackLength: 0,
    nodesTraversed: [],
  };
}

// getGlobalsForModule uses @ts-ignore and indexes globals directly by moduleId,
// so we pass globals shaped as Record<moduleId, vars> rather than GlobalStoreJSON.
function makeCheckpoint(
  overrides: Partial<ConstructorParameters<typeof Checkpoint>[0]> = {},
) {
  return new Checkpoint({
    id: 0,
    stack: makeStackJSON([
      { args: { input: "hello" }, locals: { x: 42 }, step: 2 },
    ]),
    globals: {
      "mod.agency": { count: 10, name: "test" },
    } as unknown as GlobalStoreJSON,
    nodeId: "start",
    moduleId: "mod.agency",
    scopeName: "main",
    stepPath: "0.1",
    ...overrides,
  });
}

describe("UIState", () => {
  describe("initial state", () => {
    it("should start with empty collections", () => {
      const ui = new UIState();
      expect(ui.getArgs()).toEqual([]);
      expect(ui.getLocals()).toEqual([]);
      expect(ui.getGlobals()).toEqual([]);
      expect(ui.getCallStack()).toEqual([]);
      expect(ui.getActivityLog()).toEqual([]);
      expect(ui.getOverrides()).toEqual({});
    });
  });

  describe("log", () => {
    it("should append messages to the activity log", () => {
      const ui = new UIState();
      ui.log("first");
      ui.log("second");
      expect(ui.getActivityLog()).toEqual(["first", "second"]);
    });
  });

  describe("setCheckpoint", () => {
    it("should populate args, locals, and globals from checkpoint frame", () => {
      const ui = new UIState();
      ui.setCheckpoint(makeCheckpoint());

      expect(ui.getArgs()).toEqual([
        { key: "input", value: "hello", override: undefined },
      ]);
      expect(ui.getLocals()).toEqual([
        { key: "x", value: 42, override: undefined },
      ]);
      expect(ui.getGlobals()).toEqual([
        { key: "count", value: 10, override: undefined },
        { key: "name", value: "test", override: undefined },
      ]);
    });

    it("should skip internal variables (starting with __)", () => {
      const ui = new UIState();
      ui.setCheckpoint(
        makeCheckpoint({
          stack: makeStackJSON([
            {
              args: { __internal: "skip", visible: "keep" },
              locals: { __step: 0, y: 1 },
            },
          ]),
        }),
      );

      expect(ui.getArgs()).toEqual([
        { key: "visible", value: "keep", override: undefined },
      ]);
      expect(ui.getLocals()).toEqual([
        { key: "y", value: 1, override: undefined },
      ]);
    });

    it("should include pending overrides in populated values", () => {
      const ui = new UIState();
      ui.setOverride("input", "overridden");
      ui.setOverride("count", 99);
      ui.setCheckpoint(makeCheckpoint());

      expect(ui.getArgs()).toEqual([
        { key: "input", value: "hello", override: "overridden" },
      ]);
      expect(ui.getGlobals()).toContainEqual({
        key: "count",
        value: 10,
        override: 99,
      });
    });

    it("should log when checkpoint has no current frame", () => {
      const ui = new UIState();
      ui.setCheckpoint(
        makeCheckpoint({
          stack: makeStackJSON(),
        }),
      );
      expect(ui.getActivityLog()).toContainEqual(
        "No current frame available in checkpoint",
      );
    });

    it("should log when globals for module are not found", () => {
      const ui = new UIState();
      ui.setCheckpoint(
        makeCheckpoint({
          globals: {} as unknown as GlobalStoreJSON,
        }),
      );
      expect(ui.getActivityLog()).toContainEqual(
        expect.stringContaining("No globals available for module"),
      );
    });
  });

  describe("getCurrentLine", () => {
    it("should return -1 and log when line is not set", () => {
      const ui = new UIState();
      expect(ui.getCurrentLine()).toBe(-1);
      expect(ui.getActivityLog()).toContainEqual(
        expect.stringContaining("Current line not available"),
      );
    });
  });

  describe("getModuleId", () => {
    it("should return 'unknown module' when no checkpoint is set", () => {
      const ui = new UIState();
      expect(ui.getModuleId()).toBe("unknown module");
    });

    it("should return the checkpoint moduleId", () => {
      const ui = new UIState();
      ui.setCheckpoint(makeCheckpoint({ moduleId: "my.agency" }));
      expect(ui.getModuleId()).toBe("my.agency");
    });
  });

  describe("call stack", () => {
    it("should push and retrieve call stack entries", () => {
      const ui = new UIState();
      ui.pushCallStackEntry({ functionName: "main", moduleId: "mod", line: 1 });
      ui.pushCallStackEntry({
        functionName: "helper",
        moduleId: "mod",
        line: 10,
      });
      expect(ui.getCallStack()).toEqual([
        { functionName: "main", moduleId: "mod", line: 1 },
        { functionName: "helper", moduleId: "mod", line: 10 },
      ]);
    });

    it("should remove entries by function name", () => {
      const ui = new UIState();
      ui.pushCallStackEntry({ functionName: "main", moduleId: "mod", line: 1 });
      ui.pushCallStackEntry({
        functionName: "helper",
        moduleId: "mod",
        line: 10,
      });
      ui.removeWithFuncName("main");
      expect(ui.getCallStack()).toEqual([
        { functionName: "helper", moduleId: "mod", line: 10 },
      ]);
    });

    it("should reset call stack", () => {
      const ui = new UIState();
      ui.pushCallStackEntry({ functionName: "main", moduleId: "mod", line: 1 });
      ui.resetCallStack();
      expect(ui.getCallStack()).toEqual([]);
    });
  });

  describe("overrides", () => {
    it("should set and get overrides", () => {
      const ui = new UIState();
      ui.setOverride("x", 10);
      ui.setOverride("y", "hello");
      expect(ui.getOverrides()).toEqual({ x: 10, y: "hello" });
    });

    it("should reset overrides", () => {
      const ui = new UIState();
      ui.setOverride("x", 10);
      ui.resetOverrides();
      expect(ui.getOverrides()).toEqual({});
    });
  });

  describe("mode", () => {
    it("should set mode via setMode", () => {
      const ui = new UIState();
      ui.setMode("running");
      // No direct getter for mode, but stepping() should change it back
      ui.stepping();
      // Just verifying no errors
    });

    it("should switch to stepping mode", () => {
      const ui = new UIState();
      ui.setMode("running");
      ui.stepping();
      // No error means success
    });
  });
});
