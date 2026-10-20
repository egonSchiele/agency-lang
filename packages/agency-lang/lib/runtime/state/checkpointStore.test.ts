import { describe, it, expect, afterEach } from "vitest";
import { Checkpoint, CheckpointStore } from "./checkpointStore.js";
import { verifyCheckpointChecksum } from "../checkpointChecksum.js";
import { type StateStackJSON, type StateJSON } from "./stateStack.js";
import { type GlobalStoreJSON } from "./globalStore.js";
import { CheckpointError } from "../errors.js";
import { makeMockCtx } from "../__tests__/testHelpers.js";

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

describe("Checkpoint", () => {
  describe("constructor defaults", () => {
    it("should default moduleId, scopeName, stepPath to empty string", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "start",
      });
      expect(cp!.moduleId).toBe("");
      expect(cp!.scopeName).toBe("");
      expect(cp!.stepPath).toBe("");
    });

    it("should default label to null and pinned to false", () => {
      const cp = new Checkpoint({
        id: 1,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "start",
      });
      expect(cp!.label).toBeNull();
      expect(cp!.pinned).toBe(false);
    });

    it("should use provided values", () => {
      const cp = new Checkpoint({
        id: 5,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        moduleId: "mod.agency",
        scopeName: "myFunc",
        stepPath: "1.2",
        label: "before-llm",
        pinned: true,
      });
      expect(cp!.id).toBe(5);
      expect(cp!.nodeId).toBe("n1");
      expect(cp!.moduleId).toBe("mod.agency");
      expect(cp!.scopeName).toBe("myFunc");
      expect(cp!.stepPath).toBe("1.2");
      expect(cp!.label).toBe("before-llm");
      expect(cp!.pinned).toBe(true);
    });
  });

  describe("getScopeKey", () => {
    it("should return moduleId:scopeName", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        moduleId: "foo.agency",
        scopeName: "bar",
      });
      expect(cp!.getScopeKey()).toBe("foo.agency:bar");
    });

    it("should return : when both are empty", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp!.getScopeKey()).toBe(":");
    });
  });

  describe("getCurrentFrame", () => {
    it("should return the last frame in the stack", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          { args: { a: 1 }, step: 0 },
          { args: { b: 2 }, step: 1 },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      const frame = cp!.getCurrentFrame()!;
      expect(frame.args).toEqual({ b: 2 });
      expect(frame.step).toBe(1);
    });

    it("should return undefined for empty stack", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp!.getCurrentFrame()).toBeUndefined();
    });

    it("should return undefined when stack is undefined", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: { nodesTraversed: [] } as any,
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp!.getCurrentFrame()).toBeUndefined();
    });

    // A step inside a tool call runs on a branch stack under the runPrompt
    // frame, and a fork inside the tool one level further down. The
    // checkpoint's branch path leads to the frame the step ran in.
    it("follows the branch path to the frame the step ran in", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          { scopeName: "main", locals: { answer: null } },
          {
            scopeName: "runPrompt",
            branches: {
              tool_0_abc: {
                stack: makeStackJSON([
                  {
                    scopeName: "search",
                    locals: { url: "https://example.test/grant" },
                    branches: {
                      fork_1: {
                        stack: makeStackJSON([{ scopeName: "fork", locals: { item: 2 } }]),
                      },
                    },
                  },
                ]),
              },
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        branchPath: ["tool_0_abc", "fork_1"],
      });
      expect(cp.getCurrentFrame()!.locals).toEqual({ item: 2 });
      expect(cp.frameAt(["tool_0_abc"])!.locals).toEqual({ url: "https://example.test/grant" });
      expect(cp.frameAt([])!.scopeName).toBe("runPrompt");
      expect(cp.frameAt(["tool_0_missing"])).toBeUndefined();
    });

    it("shows the frame under the loop's at one of the loop's own stops", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          { scopeName: "main", locals: { task: "research" } },
          {
            scopeName: "runPrompt",
            branches: {
              tool_0_abc: {
                stack: makeStackJSON([
                  { scopeName: "search", locals: { url: "u" } },
                  { scopeName: "runPrompt", locals: {} },
                ]),
              },
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.shownFrame({ branchPath: [] })!.scopeName).toBe("runPrompt");
      expect(cp.shownFrame({ branchPath: [], loopStop: "round" })!.locals).toEqual({
        task: "research",
      });
      expect(cp.shownFrame({ branchPath: ["tool_0_abc"], loopStop: "tool" })!.locals).toEqual({
        url: "u",
      });
      expect(cp.stackAt(["tool_0_missing"])).toBeUndefined();
    });

    it("reads the globals of the nearest branch with its own copy", () => {
      const rootGlobals = makeGlobalsJSON({ m: { counter: 0 } });
      const forkGlobals = makeGlobalsJSON({ m: { counter: 1 } });
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            scopeName: "runPrompt",
            branches: {
              // A tool call shares the globals: no copy of its own.
              tool_0_abc: {
                stack: makeStackJSON([
                  {
                    scopeName: "search",
                    branches: {
                      fork_1: {
                        stack: makeStackJSON([{ scopeName: "fork", locals: {} }]),
                        globalsJSON: forkGlobals,
                      },
                    },
                  },
                ]),
              },
            },
          },
        ]),
        globals: rootGlobals,
        nodeId: "n1",
      });
      expect(cp.globalsAt([])).toBe(rootGlobals);
      expect(cp.globalsAt(["tool_0_abc"])).toBe(rootGlobals);
      expect(cp.globalsAt(["tool_0_abc", "fork_1"])).toBe(forkGlobals);
    });

    it("writes the branch path to JSON only when it is not empty", () => {
      const root = new Checkpoint({
        id: 0,
        stack: makeStackJSON([{}]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect("branchPath" in root.toJSON()).toBe(false);
      const inTool = new Checkpoint({
        id: 1,
        stack: makeStackJSON([{}]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        branchPath: ["tool_0_abc"],
      });
      expect(inTool.toJSON().branchPath).toEqual(["tool_0_abc"]);
      expect(Checkpoint.fromJSON(inTool.toJSON())!.branchPath).toEqual(["tool_0_abc"]);
      expect(Checkpoint.fromJSON(root.toJSON())!.branchPath).toEqual([]);
    });
  });

  describe("listThreads", () => {
    it("lists every thread with its label, parent, count, and the active mark", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            threads: {
              threads: {
                "0": { messages: [{ role: "user", content: "Hello" }], label: "main" },
                "1": { messages: [], parentId: "0", label: "research", hidden: true },
              },
              counter: 2,
              activeStack: ["0", "1"],
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.listThreads()).toEqual([
        { id: "0", label: "main", parentId: null, messageCount: 1, active: false, hidden: false },
        { id: "1", label: "research", parentId: "0", messageCount: 0, active: true, hidden: true },
      ]);
    });

    it("inside a fork branch, the branch's own active stack marks the active thread", () => {
      // A fork branch runs on a view of the node's store: its subthread
      // is in the store, but the view's active stack is serialized with
      // the branch, not the store.
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            scopeName: "main",
            threads: {
              threads: {
                "0": { messages: [{ role: "user", content: "outer" }] },
                "1": { messages: [{ role: "user", content: "inner" }], parentId: "0" },
              },
              counter: 2,
              activeStack: ["0"],
            },
            branches: {
              fork_0_abc: {
                activeStack: ["0", "1"],
                stack: makeStackJSON([{ scopeName: "__block_0" }]),
              },
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.listThreads().map((t) => [t.id, t.active])).toEqual([
        ["0", true],
        ["1", false],
      ]);
      expect(cp.listThreads(["fork_0_abc"]).map((t) => [t.id, t.active])).toEqual([
        ["0", false],
        ["1", true],
      ]);
      expect(cp.getThreadMessages("0", ["fork_0_abc"])!.messages[0].content).toBe("outer");
      expect(cp.getThreadMessages(undefined, ["fork_0_abc"])!.threadId).toBe("1");
    });

    it("shows the tool loop's newer copy of the active thread", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            threads: {
              threads: { "0": { id: "t-abc", messages: [{ role: "user", content: "Hello" }] } },
              counter: 1,
              activeStack: ["0"],
            },
          },
          {
            scopeName: "runPrompt",
            locals: {
              messagesJSON: {
                id: "t-abc",
                messages: [
                  { role: "user", content: "Hello" },
                  { role: "assistant", content: "Hi" },
                ],
              },
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.getThreadMessages()!.messages.map((m) => m.content)).toEqual(["Hello", "Hi"]);
      expect(cp.listThreads()[0].messageCount).toBe(2);
    });

    it("shows the loop's copy when the ids match, even when it is the shorter one", () => {
      // A resume continues from the loop's copy, so after compaction
      // the shorter list is the conversation the program will go on with.
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            threads: {
              threads: {
                "0": {
                  id: "t-abc",
                  messages: [
                    { role: "user", content: "Hello" },
                    { role: "assistant", content: "Hi" },
                    { role: "user", content: "More" },
                  ],
                },
              },
              counter: 1,
              activeStack: ["0"],
            },
          },
          {
            scopeName: "runPrompt",
            locals: {
              messagesJSON: { id: "t-abc", messages: [{ role: "user", content: "Summary" }] },
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.getThreadMessages()!.messages.map((m) => m.content)).toEqual(["Summary"]);
    });

    it("an older checkpoint's bare message list is shown when it is the longer one", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            threads: {
              threads: { "0": { messages: [{ role: "user", content: "Hello" }] } },
              counter: 1,
              activeStack: ["0"],
            },
          },
          {
            scopeName: "runPrompt",
            locals: {
              messagesJSON: [
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Hi" },
              ],
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.getThreadMessages()!.messages.map((m) => m.content)).toEqual(["Hello", "Hi"]);
    });

    it("a local named messagesJSON in user code is not a thread", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            scopeName: "main",
            threads: {
              threads: { "0": { messages: [{ role: "user", content: "Hello" }] } },
              counter: 1,
              activeStack: ["0"],
            },
          },
          {
            scopeName: "helper",
            locals: { messagesJSON: [null, 1, { id: "x", messages: [null] }] },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.listThreads().map((t) => t.id)).toEqual(["0"]);
      expect(cp.getThreadMessages()!.messages.map((m) => m.content)).toEqual(["Hello"]);
    });

    it("lists a tool's own loop thread, which only its frame records", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            scopeName: "main",
            threads: {
              threads: { "0": { id: "t-outer", messages: [{ role: "user", content: "task" }] } },
              counter: 1,
              activeStack: ["0"],
            },
          },
          {
            scopeName: "runPrompt",
            locals: {
              messagesJSON: { id: "t-outer", messages: [{ role: "user", content: "task" }] },
            },
            branches: {
              tool_0_abc: {
                stack: makeStackJSON([
                  { scopeName: "search" },
                  {
                    scopeName: "runPrompt",
                    locals: {
                      // parentId names a thread of the tool's own store,
                      // which is not serialized, so it is not shown.
                      messagesJSON: {
                        id: "t-inner",
                        parentId: "0",
                        messages: [{ role: "user", content: "summarize" }, null],
                      },
                    },
                  },
                ]),
              },
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.listThreads().map((t) => [t.id, t.active])).toEqual([["0", true]]);
      expect(
        cp.listThreads(["tool_0_abc"]).map((t) => [t.id, t.label, t.parentId, t.active]),
      ).toEqual([
        ["0", null, null, false],
        ["t-inner", "search", null, true],
      ]);
      expect(cp.getThreadMessages(undefined, ["tool_0_abc"])!.messages).toHaveLength(1);
      expect(cp.getThreadMessages(undefined, ["tool_0_abc"])!.messages[0].content).toBe(
        "summarize",
      );
    });
  });

  describe("getThreadMessages", () => {
    it("should return null when frame has no threads", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([{ args: {}, locals: {} }]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.getThreadMessages()).toBeNull();
    });

    it("should return null when threads object has no threads", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            args: {},
            locals: {},
            threads: { threads: {}, counter: 0, activeStack: [] },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(cp.getThreadMessages()).toBeNull();
    });

    it("should return active thread messages", () => {
      const cp = new Checkpoint({
        id: 0,
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
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      const result = cp.getThreadMessages();
      expect(result).not.toBeNull();
      expect(result!.threadId).toBe("0");
      expect(result!.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]);
    });

    it("should fall back to first thread when activeStack is empty", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            args: {},
            locals: {},
            threads: {
              threads: {
                "0": {
                  messages: [{ role: "user", content: "First" }],
                },
              },
              counter: 1,
              activeStack: [],
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      const result = cp.getThreadMessages();
      expect(result).not.toBeNull();
      expect(result!.threadId).toBe("0");
    });

    it("should skip stale activeStack IDs and find an existing thread", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            args: {},
            locals: {},
            threads: {
              threads: {
                "0": {
                  messages: [{ role: "user", content: "Still here" }],
                },
              },
              counter: 2,
              activeStack: ["0", "deleted-id"],
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      const result = cp.getThreadMessages();
      expect(result).not.toBeNull();
      expect(result!.threadId).toBe("0");
    });

    it("should handle null message content as empty string", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            args: {},
            locals: {},
            threads: {
              threads: {
                "0": {
                  messages: [{ role: "assistant", content: null }],
                },
              },
              counter: 1,
              activeStack: ["0"],
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      const result = cp.getThreadMessages();
      expect(result!.messages).toEqual([{ role: "assistant", content: "(no content)" }]);
    });

    it("should concatenate TextPart[] content", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON([
          {
            args: {},
            locals: {},
            threads: {
              threads: {
                "0": {
                  messages: [
                    {
                      role: "assistant",
                      content: [
                        { type: "text", text: "Hello " },
                        { type: "text", text: "world" },
                      ],
                    },
                  ],
                },
              },
              counter: 1,
              activeStack: ["0"],
            },
          },
        ]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      const result = cp.getThreadMessages();
      expect(result!.messages).toEqual([{ role: "assistant", content: "Hello world" }]);
    });
  });

  describe("getGlobalsForModule", () => {
    it("should return globals for the checkpoint moduleId", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON({ "mod.agency": { count: 10 } }),
        nodeId: "n1",
        moduleId: "mod.agency",
      });
      expect(cp!.getGlobalsForModule()).toEqual({ count: 10 });
    });

    it("should return null when module not found in globals", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON({ "other.agency": { x: 1 } }),
        nodeId: "n1",
        moduleId: "mod.agency",
      });
      expect(cp!.getGlobalsForModule()).toBeNull();
    });

    it("should return null when globals is empty", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        moduleId: "mod.agency",
      });
      expect(cp!.getGlobalsForModule()).toBeNull();
    });
  });

  describe("fromJSON", () => {
    it("should return the same instance if already a Checkpoint", () => {
      const cp = new Checkpoint({
        id: 0,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      });
      expect(Checkpoint.fromJSON(cp)).toBe(cp);
    });

    it("should create a Checkpoint from a plain object", () => {
      const plain = {
        id: 3,
        stack: makeStackJSON([{ args: {} }]),
        globals: makeGlobalsJSON({ m: { x: 1 } }),
        nodeId: "n2",
        moduleId: "m",
        scopeName: "fn",
        stepPath: "0.1",
        label: "test",
        pinned: true,
      };
      const cp = Checkpoint.fromJSON(plain);
      expect(cp).toBeInstanceOf(Checkpoint);
      expect(cp!.id).toBe(3);
      expect(cp!.nodeId).toBe("n2");
      expect(cp!.moduleId).toBe("m");
      expect(cp!.scopeName).toBe("fn");
      expect(cp!.stepPath).toBe("0.1");
      expect(cp!.label).toBe("test");
      expect(cp!.pinned).toBe(true);
    });

    it("should handle missing optional fields", () => {
      const plain = {
        id: 1,
        stack: makeStackJSON(),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      };
      const cp = Checkpoint.fromJSON(plain);
      expect(cp!.moduleId).toBe("");
      expect(cp!.scopeName).toBe("");
      expect(cp!.stepPath).toBe("");
      expect(cp!.label).toBeNull();
      expect(cp!.pinned).toBe(false);
    });

    it("keeps every thread field and the sessions map through a JSON round trip", () => {
      // A checkpoint written to disk with JSON.stringify(getCheckpoint(id))
      // and read back must reopen `thread(session: "main")` on the same
      // thread. Before the schema named these fields, zod stripped them.
      const threads = {
        threads: {
          "1": {
            messages: [{ role: "user" as const, content: "hi" }],
            messageLabels: ["greeting"],
            parentId: null,
            hidden: false,
            label: "main",
            summary: "a chat",
            queuedMessages: [],
            repairs: 2,
          },
        },
        counter: 2,
        activeStack: ["1"],
        sessions: { main: "1" },
      };
      const plain = {
        id: 4,
        stack: makeStackJSON([{ args: {}, threads }]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
      };
      const cp = Checkpoint.fromJSON(JSON.parse(JSON.stringify(plain)));
      expect(cp!.stack.stack[0].threads).toEqual(threads);
    });
  });
});

describe("CheckpointStore", () => {
  describe("create", () => {
    it("should create a checkpoint and return an id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      expect(typeof id).toBe("number");
    });

    it("should increment ids for successive checkpoints", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id1 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id2 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      expect(id2).toBe(id1 + 1);
    });

    it("should deep-clone the state (mutations don't affect checkpoint)", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      // Mutate original context
      ctx.stateStack.nodesTraversed.push("mutated");
      ctx.globals.set("mod1", "count", 999);

      const checkpoint = store.get(id);
      expect(checkpoint).toBeDefined();
      // The checkpoint should not reflect the mutation
      expect(checkpoint!.stack.nodesTraversed).toEqual(["start", "process"]);
      expect(checkpoint!.globals.store["mod1"]["count"]).toBe(10);
    });

    it("should capture the current nodeId", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const checkpoint = store.get(id);
      expect(checkpoint!.nodeId).toBe("process");
    });

    it("should store moduleId, scopeName, stepPath, label, and pinned from opts", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "myModule.agency",
        scopeName: "myNode",
        stepPath: "1.2.3",
        label: "before-llm-call",
        pinned: true,
      });
      const checkpoint = store.get(id);
      expect(checkpoint!.moduleId).toBe("myModule.agency");
      expect(checkpoint!.scopeName).toBe("myNode");
      expect(checkpoint!.stepPath).toBe("1.2.3");
      expect(checkpoint!.label).toBe("before-llm-call");
      expect(checkpoint!.pinned).toBe(true);
    });

    it("should default label to null and pinned to false when not provided", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "mod.agency",
        scopeName: "fn",
        stepPath: "0",
      });
      const checkpoint = store.get(id);
      expect(checkpoint!.label).toBeNull();
      expect(checkpoint!.pinned).toBe(false);
    });

    it("should store moduleId, scopeName, stepPath, label, and pinned when provided via ctx.checkpoints", () => {
      const store = new CheckpointStore();
      const ctx = { ...makeMockCtx(), checkpoints: store };
      const id = ctx.checkpoints.create(ctx.stateStack, ctx, {
        moduleId: "foo.agency",
        scopeName: "main",
        stepPath: "3",
        label: "my label",
        pinned: true,
      });
      const cp = ctx.checkpoints.get(id);
      expect(cp!.moduleId).toBe("foo.agency");
      expect(cp!.scopeName).toBe("main");
      expect(cp!.stepPath).toBe("3");
      expect(cp!.label).toBe("my label");
      expect(cp!.pinned).toBe(true);
    });
  });

  describe("get", () => {
    it("should return undefined for non-existent id", () => {
      const store = new CheckpointStore();
      expect(store.get(999)).toBeUndefined();
    });

    it("should return the checkpoint for a valid id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const checkpoint = store.get(id);
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.id).toBe(id);
    });
  });

  describe("delete", () => {
    it("should remove a checkpoint", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      expect(store.get(id)).toBeDefined();
      store.delete(id);
      expect(store.get(id)).toBeUndefined();
    });

    it("should not throw for non-existent id", () => {
      const store = new CheckpointStore();
      expect(() => store.delete(999)).not.toThrow();
    });
  });

  describe("invalidateAfter", () => {
    it("should remove all checkpoints with id > the given id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id0 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id1 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id2 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id3 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      store.deleteAfterCheckpoint(id1);

      expect(store.get(id0)).toBeDefined();
      expect(store.get(id1)).toBeDefined();
      expect(store.get(id2)).toBeUndefined();
      expect(store.get(id3)).toBeUndefined();
    });

    it("should not remove any if all ids are <= the given id", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id0 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id1 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      store.deleteAfterCheckpoint(id1);

      expect(store.get(id0)).toBeDefined();
      expect(store.get(id1)).toBeDefined();
    });
  });

  describe("trackRestore", () => {
    it("should track restore count without error for counts within limit", () => {
      const store = new CheckpointStore(5);
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      expect(() => store.trackRestore(id)).not.toThrow();
      expect(() => store.trackRestore(id)).not.toThrow();
      expect(() => store.trackRestore(id)).not.toThrow();
    });

    it("should throw CheckpointError when max restores exceeded", () => {
      const store = new CheckpointStore(3);
      const ctx = makeMockCtx();
      const id = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      store.trackRestore(id);
      store.trackRestore(id);
      store.trackRestore(id);

      expect(() => store.trackRestore(id)).toThrow(CheckpointError);
      expect(() => store.trackRestore(id)).toThrow(/Possible infinite loop/);
    });
  });

  describe("toJSON / fromJSON", () => {
    it("should serialize and deserialize correctly", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id0 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      const id1 = store.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });

      const json = store.toJSON();
      const restored = CheckpointStore.fromJSON(json);

      expect(restored.get(id0)).toBeDefined();
      expect(restored.get(id0)!.id).toBe(id0);
      expect(restored.get(id1)).toBeDefined();
      expect(restored.get(id1)!.id).toBe(id1);
    });

    it("should preserve counter across serialization", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      const id1 = store.create(ctx.stateStack, ctx, { moduleId: "", scopeName: "", stepPath: "" });
      const id2 = store.create(ctx.stateStack, ctx, { moduleId: "", scopeName: "", stepPath: "" });

      const json = store.toJSON();
      const restored = CheckpointStore.fromJSON(json);

      // Next id should continue from where we left off
      const id = restored.create(ctx.stateStack, ctx, {
        moduleId: "",
        scopeName: "",
        stepPath: "",
      });
      expect(id).toBe(id2 + 1);
    });

    it("toJSON should deep-clone so mutations don't affect serialized data", () => {
      const store = new CheckpointStore();
      const ctx = makeMockCtx();
      store.create(ctx.stateStack, ctx, { moduleId: "", scopeName: "", stepPath: "" });

      const json = store.toJSON();

      // Mutate the original store
      store.create(ctx.stateStack, ctx, { moduleId: "", scopeName: "", stepPath: "" });

      // The JSON should only have 1 checkpoint
      expect(Object.keys(json.checkpoints)).toHaveLength(1);
    });
  });
});

describe("checkpoint signing at creation", () => {
  afterEach(() => {
    delete process.env.AGENCY_CHECKPOINT_KEY;
  });

  it("signs a created checkpoint when a key is configured", () => {
    process.env.AGENCY_CHECKPOINT_KEY = "0123456789abcdef0123456789abcdef";
    const ctx = makeMockCtx();
    const cp = Checkpoint.fromStateStack(ctx.stateStack, ctx, {
      moduleId: "m",
      scopeName: "main",
      stepPath: "0",
    });
    expect(cp.signature).toBeDefined();
    expect(verifyCheckpointChecksum(cp)).toBe(true);
  });

  it("does not sign when no key is configured", () => {
    const ctx = makeMockCtx();
    const cp = Checkpoint.fromStateStack(ctx.stateStack, ctx, {
      moduleId: "m",
      scopeName: "main",
      stepPath: "0",
    });
    expect(cp.signature).toBeUndefined();
  });
});

describe("CheckpointStore inside a tool call", () => {
  function stackWithToolBranch(): StateStackJSON {
    return makeStackJSON([
      { scopeName: "main", locals: { __dbg_1: true } },
      {
        scopeName: "runPrompt",
        locals: { __dbg_round: true },
        branches: {
          tool_0_abc: {
            stack: makeStackJSON([{ scopeName: "search", locals: { __dbg_0: true, url: "u" } }]),
          },
          tool_1_def: {
            stack: makeStackJSON([{ scopeName: "writeUp", locals: { __dbg_0: true } }]),
          },
        },
      },
    ]);
  }

  it("removeDebugFlagsFor strips the flags of the stopped frame only", () => {
    const store = new CheckpointStore();
    const cp = new Checkpoint({
      id: 7,
      stack: stackWithToolBranch(),
      globals: makeGlobalsJSON(),
      nodeId: "n1",
      branchPath: ["tool_0_abc"],
    });
    store.add(cp);
    store.removeDebugFlagsFor(7);
    // The stopped frame loses its flag and keeps its locals.
    expect(cp.frameAt(["tool_0_abc"])!.locals).toEqual({ url: "u" });
    // Ancestors keep theirs, so a replay passes through the llm() call.
    expect(cp.frameAt([])!.locals).toEqual({ __dbg_round: true });
    expect(cp.stack.stack[0].locals).toEqual({ __dbg_1: true });
    // A sibling branch keeps its flag, so it replays past its own stop.
    expect(cp.frameAt(["tool_1_def"])!.locals).toEqual({ __dbg_0: true });
  });

  it("a rolling checkpoint at the same step of another call of the tool is kept", () => {
    const ctx = makeMockCtx();
    const store = new CheckpointStore();
    const location = { moduleId: "m.agency", scopeName: "search", stepPath: "0" };
    const first = store.createRolling(ctx, { ...location, branchPath: ["tool_0_abc"] });
    const second = store.createRolling(ctx, { ...location, branchPath: ["tool_0_xyz"] });
    const again = store.createRolling(ctx, { ...location, branchPath: ["tool_0_abc"] });
    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)).toBeDefined();
    expect(store.get(again)).toBeDefined();
  });

  it("findBefore skips the stopped location, not the checkpoint's own", () => {
    const store = new CheckpointStore();
    const inTool = (id: number, stepPath: string) =>
      new Checkpoint({
        id,
        stack: makeStackJSON([{}]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        moduleId: "m.agency",
        scopeName: "search",
        stepPath,
        branchPath: ["tool_0_abc"],
      });
    store.add(inTool(1, "0"));
    store.add(inTool(2, "1"));
    // The checkpoint on the stop is the shared one from the join, at the
    // loop's location, with a later id.
    const shared = new Checkpoint({
      id: 3,
      stack: makeStackJSON([{}]),
      globals: makeGlobalsJSON(),
      nodeId: "n1",
      scopeName: "runPrompt",
      stepPath: "round.1",
    });
    const stop = {
      moduleId: "m.agency",
      scopeName: "search",
      stepPath: "1",
      branchPath: ["tool_0_abc"],
    };
    expect(store.findBefore(shared.id, stop)!.id).toBe(1);
  });

  it("findBefore passes over a sibling branch's steps and reaches the stack above", () => {
    const store = new CheckpointStore();
    const at = (id: number, scopeName: string, stepPath: string, branchPath?: string[]) =>
      new Checkpoint({
        id,
        stack: makeStackJSON([{}]),
        globals: makeGlobalsJSON(),
        nodeId: "n1",
        moduleId: "m.agency",
        scopeName,
        stepPath,
        branchPath,
      });
    // The node's llm() step, then the two tools of a round stepping in turn.
    store.add(at(1, "main", "0"));
    store.add(at(2, "search", "0", ["tool_0_abc"]));
    store.add(at(3, "writeUp", "0", ["tool_1_def"]));
    store.add(at(4, "search", "1", ["tool_0_abc"]));
    store.add(at(5, "writeUp", "1", ["tool_1_def"]));
    const stoppedInSearch = {
      moduleId: "m.agency",
      scopeName: "search",
      stepPath: "1",
      branchPath: ["tool_0_abc"],
    };
    // From search's second statement: its first, not writeUp's.
    expect(store.findBefore(6, stoppedInSearch)!.id).toBe(2);
    // From search's first statement, before the later steps existed: the
    // llm() line on the stack above, not writeUp's first statement.
    const atSearchStart = { ...stoppedInSearch, stepPath: "0" };
    expect(store.findBefore(4, atSearchStart)!.id).toBe(1);
  });
});
