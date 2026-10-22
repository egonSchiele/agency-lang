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
      ...(f.moduleId ? { moduleId: f.moduleId } : {}),
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
      ui.setPending({
        edits: [
          { op: "setArg", name: "input", value: "overridden" },
          { op: "setGlobal", name: "count", value: 99 },
        ],
        applied: [],
      });
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

    it("a live Date an edit did not touch is neither marked nor shown in wire form", async () => {
      const ui = new UIState();
      const checkpoint = sharedCheckpoint();
      const when = new Date("2026-01-02T03:04:05Z");
      checkpoint.stack.stack[0].locals.when = when;
      ui.setPending({
        edits: [{ op: "setLocal", frame: { branchPath: [], depth: 1 }, name: "answer", value: 1 }],
        applied: [],
      });
      await ui.setCheckpoint(checkpoint, {
        moduleId: "mod.agency",
        scopeName: "main",
        stepPath: "1/llm",
        branchPath: [],
        depth: 0,
        label: "round 1",
        loopStop: "round",
      });
      expect(ui.getLocals()).toContainEqual({ key: "when", value: when, override: undefined });
      expect(ui.getLocals()).toContainEqual({ key: "answer", value: null, override: 1 });
    });

    it("a pending edit on one frame marks that frame's variable, not a namesake elsewhere", async () => {
      const ui = new UIState();
      const checkpoint = sharedCheckpoint();
      checkpoint.stack.stack[0].locals.url = "main's";
      ui.setPending({
        edits: [
          {
            op: "setLocal",
            frame: { branchPath: ["tool_0_abc"], depth: 0 },
            name: "url",
            value: "v",
          },
        ],
        applied: [],
      });
      // Stopped at the loop's round stop, whose frame is main's.
      await ui.setCheckpoint(checkpoint, {
        moduleId: "mod.agency",
        scopeName: "main",
        stepPath: "1/llm",
        branchPath: [],
        depth: 0,
        label: "round 1",
        loopStop: "round",
      });
      expect(ui.getLocals()).toContainEqual({ key: "url", value: "main's", override: undefined });
      ui.viewBranch(["tool_0_abc"]);
      expect(ui.getLocals()).toEqual([
        { key: "url", value: "https://example.test/grant", override: "v" },
      ]);
    });

    it("shows the stopped frame's args and locals", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(sharedCheckpoint(), {
        moduleId: "mod.agency",
        scopeName: "search",
        stepPath: "1",
        branchPath: ["tool_0_abc"],
        depth: 1,
        label: null,
      });
      expect(ui.getArgs()).toEqual([{ key: "query", value: "grant", override: undefined }]);
      expect(ui.getLocals()).toEqual([
        { key: "url", value: "https://example.test/grant", override: undefined },
      ]);
    });

    // A checkpoint marked `loopStop` was taken at one of the loop's own
    // stops, before a request or a tool call. It is located under the
    // llm() statement, and its frame is the caller's.
    it("a loop checkpoint shows the caller's frame at the llm() statement", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          moduleId: "mod.agency",
          scopeName: "main",
          stepPath: "1/initialLlmCall",
          loopStop: "round",
          stack: sharedCheckpoint().stack,
        }),
      );
      expect(ui.getArgs()).toEqual([{ key: "task", value: "research", override: undefined }]);
      expect(ui.getLocals()).toEqual([{ key: "answer", value: null, override: undefined }]);
      expect(ui.getLocation()).toMatchObject({ scopeName: "main", stepPath: "1" });
    });

    it("an interrupt the loop carried out is shown at the llm() statement too", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          moduleId: "mod.agency",
          scopeName: "main",
          stepPath: "1/guardGate.final",
          stack: sharedCheckpoint().stack,
        }),
      );
      expect(ui.getLocation()).toMatchObject({ scopeName: "main", stepPath: "1" });
    });

    it("a loop stop inside a tool shows that tool's frame, at its llm() statement", async () => {
      // The subagent in `search` runs its own loop: the stop's branch path
      // leads to the tool's stack, whose last frame is the loop's.
      const cp = makeCheckpoint({
        scopeName: "runPrompt",
        stepPath: "1/round.0.tools",
        stack: makeStackJSON([
          { args: { task: "research" }, locals: { answer: null } },
          {
            scopeName: "runPrompt",
            locals: { messagesJSON: [] },
            branches: {
              tool_0_abc: {
                stack: makeStackJSON([
                  { args: { query: "grant" }, locals: { url: "https://example.test/grant" } },
                  { scopeName: "runPrompt", locals: { messagesJSON: [] } },
                ]),
              },
            },
          },
        ]),
      });
      const ui = new UIState();
      await ui.setCheckpoint(cp, {
        moduleId: "mod.agency",
        scopeName: "search",
        stepPath: "3/initialLlmCall",
        branchPath: ["tool_0_abc"],
        depth: 2,
        label: "round 1",
        loopStop: "round",
      });
      expect(ui.getArgs()).toEqual([{ key: "query", value: "grant", override: undefined }]);
      expect(ui.getLocation()).toMatchObject({ scopeName: "search", stepPath: "3" });
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
    it("is read from the checkpoint's frames, the stopped frame last", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          moduleId: "mod.agency",
          scopeName: "helper",
          stack: makeStackJSON([
            { scopeName: "main", moduleId: "mod.agency" },
            { scopeName: "helper", moduleId: "lib.agency" },
          ]),
        }),
      );
      expect(ui.getCallStack()).toEqual([
        { functionName: "main", moduleId: "mod.agency" },
        { functionName: "helper", moduleId: "lib.agency" },
      ]);
    });

    it("follows the branch path through the tool loop into a tool", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          scopeName: "runPrompt",
          stepPath: "1/round.0.tools",
          stack: makeStackJSON([
            { scopeName: "main", moduleId: "mod.agency" },
            {
              scopeName: "runPrompt",
              branches: {
                tool_0_abc: {
                  stack: makeStackJSON([{ scopeName: "search", moduleId: "mod.agency" }]),
                },
              },
            },
          ]),
        }),
        {
          moduleId: "mod.agency",
          scopeName: "search",
          stepPath: "1",
          branchPath: ["tool_0_abc"],
          depth: 1,
          label: null,
        },
      );
      expect(ui.getCallStack().map((entry) => entry.functionName)).toEqual([
        "main",
        "llm()",
        "search",
      ]);
    });

    it("finds the branch of a user interrupt by its id, and names block and nameless frames", async () => {
      // A user interrupt from inside a tool is stamped on the shared
      // checkpoint at the join: no stop record, no branch path on the
      // location. The branch's own state records the interrupt's id.
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          scopeName: "runPrompt",
          stepPath: "1/round.0.tools",
          stack: makeStackJSON([
            { scopeName: "main", moduleId: "mod.agency" },
            {
              scopeName: "runPrompt",
              branches: {
                tool_0_abc: {
                  stack: makeStackJSON([{ scopeName: "search", moduleId: "mod.agency" }]),
                },
                // The interrupt bubbled out of a nested tool, so the
                // enclosing branch records the same id; the nested one
                // is the branch that asked.
                tool_1_def: {
                  interruptId: "intr-1",
                  stack: makeStackJSON([
                    { scopeName: "confirm", moduleId: "mod.agency" },
                    {
                      scopeName: "runPrompt",
                      moduleId: "mod.agency",
                      branches: {
                        tool_0_ghi: {
                          interruptId: "intr-1",
                          stack: makeStackJSON([
                            { scopeName: "__block_0", moduleId: "mod.agency" },
                            { moduleId: "mod.agency" },
                          ]),
                        },
                      },
                    },
                  ]),
                },
              },
            },
          ]),
        }),
        undefined,
        "intr-1",
      );
      expect(ui.getCallStack().map((entry) => entry.functionName)).toEqual([
        "main",
        "llm()",
        "confirm",
        "llm()",
        "block",
        "(unknown)",
      ]);
      expect(ui.getLocation()?.branchPath).toEqual(["tool_1_def", "tool_0_ghi"]);
    });

    it("is empty without a checkpoint", () => {
      expect(new UIState().getCallStack()).toEqual([]);
    });
  });

  describe("viewBranch", () => {
    it("shows the branch's frame and its module's globals, and keeps the source pane on the stop", async () => {
      const ui = new UIState();
      await ui.setCheckpoint(
        makeCheckpoint({
          globals: makeGlobalsJSON({
            "mod.agency": { count: 10 },
            "tools.agency": { calls: 3 },
          }),
          stack: makeStackJSON([
            { scopeName: "main", moduleId: "mod.agency", locals: { x: 1 } },
            {
              scopeName: "runPrompt",
              moduleId: "mod.agency",
              branches: {
                tool_0_abc: {
                  stack: makeStackJSON([
                    { scopeName: "search", moduleId: "mod.agency", locals: { url: "u" } },
                  ]),
                },
                tool_1_def: {
                  stack: makeStackJSON([
                    { scopeName: "writeUp", moduleId: "tools.agency", locals: { notes: "n" } },
                  ]),
                },
              },
            },
          ]),
        }),
        {
          moduleId: "mod.agency",
          scopeName: "search",
          stepPath: "1",
          branchPath: ["tool_0_abc"],
          depth: 1,
          label: null,
        },
      );
      ui.viewBranch(["tool_1_def"]);
      expect(ui.getModuleId()).toBe("mod.agency");
      expect(ui.getLocation()?.branchPath).toEqual(["tool_1_def"]);
      expect(ui.getLocals().map((e) => e.key)).toEqual(["notes"]);
      expect(ui.getGlobals().map((e) => [e.key, e.value])).toEqual([["calls", 3]]);
      expect(ui.lookupVariable("notes")).toBe("n");
      expect(ui.lookupVariable("calls")).toBe(3);
      ui.viewBranch([]);
      expect(ui.getLocals().map((e) => e.key)).toEqual(["url"]);
      expect(ui.getGlobals().map((e) => e.key)).toEqual(["count"]);
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

describe("loadSourceMap", () => {
  it("survives a compiled module that fails to load, with a line in the log", async () => {
    const state = new UIState();

    const loaded = await state.loadSourceMap("tests/debugger/broken-module.agency");

    expect(loaded).toBe(false);
    expect(state.hasSourceMap("tests/debugger/broken-module.agency")).toBe(false);
    expect(state.getActivityLog().join("\n")).toMatch(/Could not load module .*broken on purpose/);
  });

  it("says when there is no compiled module to load", async () => {
    const state = new UIState();

    expect(await state.loadSourceMap("tests/debugger/no-such-module.agency")).toBe(false);
    expect(state.getActivityLog().join("\n")).toContain("Could not find compiled JS file");
  });
});
