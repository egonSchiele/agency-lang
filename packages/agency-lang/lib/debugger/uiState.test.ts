import { describe, it, expect } from "vitest";
import { UIState } from "./uiState.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { StateStackJSON, StateJSON } from "../runtime/state/stateStack.js";
import type { GlobalStoreJSON } from "../runtime/state/globalStore.js";

function makeStackJSON(frames: Partial<StateJSON>[] = []): StateStackJSON {
  return {
    stack: frames.map((f) => ({
      args: f.args ?? {},
      locals: f.locals ?? {},
      threads: f.threads ?? null,
      step: f.step ?? 0,
      scopeName: f.scopeName ?? null,
      ...(f.branches ? { branches: f.branches } : {}),
    })),
    mode: "serialize",
    other: {},
    deserializeStackLength: 0,
    nodesTraversed: [],
  };
}

function makeGlobalsJSON(store: Record<string, Record<string, any>> = {}): GlobalStoreJSON {
  return { store, initializedModules: Object.keys(store) };
}

function makeCheckpoint(overrides: Partial<ConstructorParameters<typeof Checkpoint>[0]> = {}) {
  return new Checkpoint({
    id: 0,
    stack: makeStackJSON([{ args: { input: "hello" }, locals: { x: 42 }, step: 2 }]),
    globals: makeGlobalsJSON({
      "mod.agency": { count: 10, name: "test" },
    }),
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
    it("should populate args, locals, and globals from checkpoint frame", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(makeCheckpoint());

      expect(ui.getArgs()).toEqual([{ key: "input", value: "hello", override: undefined }]);
      expect(ui.getLocals()).toEqual([{ key: "x", value: 42, override: undefined }]);
      expect(ui.getGlobals()).toEqual([
        { key: "count", value: 10, override: undefined },
        { key: "name", value: "test", override: undefined },
      ]);
    });

    it("should skip internal variables (starting with __)", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          stack: makeStackJSON([
            {
              args: { __internal: "skip", visible: "keep" },
              locals: { __step: 0, y: 1 },
            },
          ]),
        }),
      );

      expect(ui.getArgs()).toEqual([{ key: "visible", value: "keep", override: undefined }]);
      expect(ui.getLocals()).toEqual([{ key: "y", value: 1, override: undefined }]);
    });

    it("should include pending overrides in populated values", async () => {
      const ui = new UIState();
      ui.setOverride("input", "overridden");
      ui.setOverride("count", 99);
      await ui.setCheckpoint(makeCheckpoint());

      expect(ui.getArgs()).toEqual([{ key: "input", value: "hello", override: "overridden" }]);
      expect(ui.getGlobals()).toContainEqual({
        key: "count",
        value: 10,
        override: 99,
      });
    });

    it("should not populate globals when module not found in globals store", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          globals: makeGlobalsJSON(),
        }),
      );
      expect(ui.getGlobals()).toEqual([]);
    });
  });

  describe("setCheckpoint at a stop inside a tool call", () => {
    // The checkpoint on such a stop is the shared one stamped at the join:
    // its last root frame is runPrompt's and its location is the loop's.
    // The stop record says where the program really is.
    function sharedCheckpoint() {
      return makeCheckpoint({
        scopeName: "runPrompt",
        stepPath: "round.1",
        stack: makeStackJSON([
          { args: { task: "research" }, locals: { answer: null } },
          {
            scopeName: "runPrompt",
            locals: { messagesJSON: [] },
            branches: {
              tool_0_abc: {
                stack: makeStackJSON([
                  { args: { query: "grant" }, locals: { url: "https://example.test/grant" } },
                ]),
              },
            },
          },
        ]),
      });
    }

    it("shows the stopped frame's args and locals", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(sharedCheckpoint(), {
        moduleId: "mod.agency",
        scopeName: "search",
        stepPath: "1",
        branchPath: ["tool_0_abc"],
        label: null,
        kind: "step",
      });
      expect(ui.getArgs()).toEqual([{ key: "query", value: "grant", override: undefined }]);
      expect(ui.getLocals()).toEqual([
        { key: "url", value: "https://example.test/grant", override: undefined },
      ]);
    });

    // A checkpoint whose own location is the tool loop's (scope runPrompt)
    // is one of the loop's stops, before a request or a tool call. It has
    // no source line, and its locals are the caller's.
    it("without a stop record, a loop checkpoint shows the caller's frame", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(sharedCheckpoint());
      expect(ui.getArgs()).toEqual([{ key: "task", value: "research", override: undefined }]);
      expect(ui.getLocals()).toEqual([{ key: "answer", value: null, override: undefined }]);
    });

    it("a loop stop keeps the caller's frame and asks for no source line", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(sharedCheckpoint(), {
        moduleId: "",
        scopeName: "runPrompt",
        stepPath: "1/round.0.tool.0_abc.before",
        branchPath: [],
        label: 'search(query: "grant")',
        kind: "tool",
      });
      expect(ui.getLocals()).toEqual([{ key: "answer", value: null, override: undefined }]);
      expect(ui.getActivityLog()).toEqual([]);
    });
  });

  describe("getThreadMessages", () => {
    it("should return null for getThreadMessages when no threads in frame", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(makeCheckpoint());
      expect(ui.getThreadMessages()).toBeNull();
    });

    it("should return active thread messages from getThreadMessages", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          stack: makeStackJSON([
            {
              args: {},
              locals: {},
              threads: {
                threads: {
                  "0": {
                    messages: [
                      { role: "user", content: "Hello" },
                      { role: "assistant", content: "Hi there" },
                    ],
                  },
                  "1": {
                    messages: [{ role: "user", content: "Other thread" }],
                  },
                },
                counter: 2,
                activeStack: ["0"],
              },
            },
          ]),
        }),
      );
      const result = ui.getThreadMessages();
      expect(result).not.toBeNull();
      expect(result!.threadId).toBe("0");
      expect(result!.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]);
    });

    it("should return null for getThreadMessages when threads object has no threads", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          stack: makeStackJSON([
            {
              args: {},
              locals: {},
              threads: {
                threads: {},
                counter: 0,
                activeStack: [],
              },
            },
          ]),
        }),
      );
      expect(ui.getThreadMessages()).toBeNull();
    });
  });

  describe("getCurrentLine", () => {
    it("should return -1 when line is not set", () => {
      const ui = new UIState();
      expect(ui.getCurrentLine()).toBe(-1);
    });
  });

  describe("getModuleId", () => {
    it("should return 'unknown module' when no checkpoint is set", () => {
      const ui = new UIState();
      expect(ui.getModuleId()).toBe("unknown module");
    });

    it("should return the checkpoint moduleId", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(makeCheckpoint({ moduleId: "my.agency" }));
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
      expect(ui.getCallStack()).toEqual([{ functionName: "helper", moduleId: "mod", line: 10 }]);
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
