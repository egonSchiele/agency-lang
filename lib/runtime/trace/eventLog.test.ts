import { describe, it, expect } from "vitest";
import { Checkpoint } from "../state/checkpointStore.js";
import {
  makeBaseEvent,
  detectNodeTransitions,
  detectStackChanges,
  detectVariableChanges,
  detectLlmCalls,
  detectInterrupts,
  detectBranches,
  generateEventLog,
} from "./eventLog.js";

function makeCheckpoint(overrides: Record<string, any> = {}): Checkpoint {
  return new Checkpoint({
    id: 0,
    nodeId: "main",
    moduleId: "test.agency",
    scopeName: "main",
    stepPath: "0",
    label: null,
    pinned: false,
    stack: {
      stack: [{ args: {}, locals: {}, threads: null, step: 0 }],
      mode: "serialize" as const,
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: ["main"],
    },
    globals: {
      store: { "test.agency": {} },
      initializedModules: ["test.agency"],
    },
    ...overrides,
  });
}

describe("makeBaseEvent", () => {
  it("extracts base fields from a checkpoint", () => {
    const cp = makeCheckpoint({
      nodeId: "start",
      moduleId: "foo.agency",
      scopeName: "myNode",
      stepPath: "3",
    });
    const base = makeBaseEvent(cp, 5);
    expect(base).toEqual({
      step: 5,
      nodeId: "start",
      scopeName: "myNode",
      moduleId: "foo.agency",
      stepPath: "3",
    });
  });
});

describe("detectNodeTransitions", () => {
  it("emits node-enter for the first checkpoint", () => {
    const curr = makeCheckpoint({ nodeId: "main" });
    const events = detectNodeTransitions(null, curr, 0);
    expect(events).toEqual([
      {
        step: 0,
        nodeId: "main",
        scopeName: "main",
        moduleId: "test.agency",
        stepPath: "0",
        type: "node-enter",
        nodeName: "main",
      },
    ]);
  });

  it("emits node-exit and node-enter when nodeId changes", () => {
    const prev = makeCheckpoint({ nodeId: "main", stepPath: "1" });
    const curr = makeCheckpoint({ nodeId: "categorize", stepPath: "0" });
    const events = detectNodeTransitions(prev, curr, 2);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("node-exit");
    expect((events[0] as any).nodeName).toBe("main");
    expect(events[1].type).toBe("node-enter");
    expect((events[1] as any).nodeName).toBe("categorize");
  });

  it("returns empty when nodeId unchanged", () => {
    const prev = makeCheckpoint({ nodeId: "main", stepPath: "0" });
    const curr = makeCheckpoint({ nodeId: "main", stepPath: "1" });
    const events = detectNodeTransitions(prev, curr, 1);
    expect(events).toEqual([]);
  });
});

describe("detectStackChanges", () => {
  it("emits function-enter when a new frame is pushed", () => {
    const prev = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 1 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      scopeName: "greet",
      stepPath: "0",
      stack: {
        stack: [
          { args: {}, locals: {}, threads: null, step: 1 },
          {
            args: { name: "Alice" },
            locals: { name: "Alice" },
            threads: null,
            step: 0,
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectStackChanges(prev, curr, 2);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("function-enter");
    expect((events[0] as any).functionName).toBe("greet");
    expect((events[0] as any).args).toEqual({ name: "Alice" });
  });

  it("emits function-exit when a frame is popped", () => {
    const prev = makeCheckpoint({
      scopeName: "greet",
      stepPath: "2",
      stack: {
        stack: [
          { args: {}, locals: {}, threads: null, step: 1 },
          {
            args: { name: "Alice" },
            locals: { name: "Alice" },
            threads: null,
            step: 2,
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      scopeName: "main",
      stepPath: "2",
      stack: {
        stack: [
          {
            args: {},
            locals: { result: "Hello!" },
            threads: null,
            step: 2,
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectStackChanges(prev, curr, 3);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("function-exit");
    expect((events[0] as any).functionName).toBe("greet");
    expect((events[0] as any).returnValue).toBe("Hello!");
  });

  it("returns empty when stack depth unchanged", () => {
    const prev = makeCheckpoint({ stepPath: "0" });
    const curr = makeCheckpoint({ stepPath: "1" });
    const events = detectStackChanges(prev, curr, 1);
    expect(events).toEqual([]);
  });
});

describe("detectVariableChanges", () => {
  it("emits variable-set for new local variable", () => {
    const prev = makeCheckpoint({
      stepPath: "0",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 0 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [
          { args: {}, locals: { name: "Alice" }, threads: null, step: 1 },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectVariableChanges(prev, curr, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "variable-set",
      variable: "name",
      value: "Alice",
      previousValue: null,
      scope: "local",
    });
  });

  it("emits variable-set for changed local variable", () => {
    const prev = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: { x: 1 }, threads: null, step: 1 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "2",
      stack: {
        stack: [{ args: {}, locals: { x: 2 }, threads: null, step: 2 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectVariableChanges(prev, curr, 2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "variable-set",
      variable: "x",
      value: 2,
      previousValue: 1,
      scope: "local",
    });
  });

  it("emits variable-set for changed global variable", () => {
    const prev = makeCheckpoint({
      stepPath: "0",
      globals: {
        store: { "test.agency": { count: 0 } },
        initializedModules: ["test.agency"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      globals: {
        store: { "test.agency": { count: 1 } },
        initializedModules: ["test.agency"],
      },
    });
    const events = detectVariableChanges(prev, curr, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "variable-set",
      variable: "count",
      value: 1,
      previousValue: 0,
      scope: "global",
    });
  });

  it("skips variables prefixed with __", () => {
    const prev = makeCheckpoint({
      stepPath: "0",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 0 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [
          {
            args: {},
            locals: { __substep_0: 1, name: "Bob" },
            threads: null,
            step: 1,
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectVariableChanges(prev, curr, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ variable: "name" });
  });
});

describe("detectLlmCalls", () => {
  function makeThreads(messages: any[]) {
    return {
      threads: {
        default: {
          messages,
          options: {},
        },
      },
      activeStack: ["default"],
    };
  }

  it("emits llm-call when new user+assistant messages appear", () => {
    const prev = makeCheckpoint({
      stepPath: "0",
      stack: {
        stack: [
          { args: {}, locals: {}, threads: makeThreads([]), step: 0 },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [
          {
            args: {},
            locals: {},
            step: 1,
            threads: makeThreads([
              { role: "user", content: "What is 2+2?" },
              { role: "assistant", content: "4" },
            ]),
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectLlmCalls(prev, curr, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "llm-call",
      prompt: "What is 2+2?",
      response: "4",
      toolCalls: [],
    });
  });

  it("emits tool-call events for tool_call messages", () => {
    const prev = makeCheckpoint({
      stepPath: "0",
      stack: {
        stack: [
          { args: {}, locals: {}, threads: makeThreads([]), step: 0 },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [
          {
            args: {},
            locals: {},
            step: 1,
            threads: makeThreads([
              { role: "user", content: "Add 4+5" },
              {
                role: "assistant",
                content: null,
                toolCalls: [
                  { name: "add", arguments: { a: 4, b: 5 } },
                ],
              },
              { role: "tool", content: "9", toolCallId: "1" },
              { role: "assistant", content: "The answer is 9" },
            ]),
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectLlmCalls(prev, curr, 1);
    const toolEvents = events.filter((e: any) => e.type === "tool-call");
    const llmEvents = events.filter((e: any) => e.type === "llm-call");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({
      type: "tool-call",
      toolName: "add",
      args: { a: 4, b: 5 },
      result: "9",
    });
    expect(llmEvents).toHaveLength(1);
    expect(llmEvents[0]).toMatchObject({
      type: "llm-call",
      response: "The answer is 9",
    });
  });

  it("returns empty when no new messages", () => {
    const threads = makeThreads([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    const prev = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: {}, threads, step: 1 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "2",
      stack: {
        stack: [{ args: {}, locals: {}, threads, step: 2 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectLlmCalls(prev, curr, 2);
    expect(events).toEqual([]);
  });
});

describe("detectInterrupts", () => {
  it("emits interrupt-thrown for interrupt-related label", () => {
    const prev = makeCheckpoint({ stepPath: "1", label: null });
    const curr = makeCheckpoint({ stepPath: "2", label: "result-entry" });
    const events = detectInterrupts(prev, curr, 2);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("interrupt-thrown");
  });

  it("emits interrupt-resolved when execution continues past interrupt", () => {
    const prev = makeCheckpoint({ stepPath: "2", label: "result-entry" });
    const curr = makeCheckpoint({ stepPath: "3", label: null });
    const events = detectInterrupts(prev, curr, 3);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("interrupt-resolved");
  });

  it("returns empty when no interrupt", () => {
    const prev = makeCheckpoint({ stepPath: "0", label: null });
    const curr = makeCheckpoint({ stepPath: "1", label: null });
    const events = detectInterrupts(prev, curr, 1);
    expect(events).toEqual([]);
  });
});

describe("detectBranches", () => {
  it("emits branch event for if condition from __condbranch_ variable", () => {
    const prev = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 1 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1.0",
      stack: {
        stack: [
          {
            args: {},
            locals: { __condbranch_1: true },
            threads: null,
            step: 1,
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectBranches(prev, curr, 2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "branch", condition: "if" });
  });

  it("emits branch event for else from __condbranch_ = false", () => {
    const prev = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 1 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1.0",
      stack: {
        stack: [
          {
            args: {},
            locals: { __condbranch_1: false },
            threads: null,
            step: 1,
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectBranches(prev, curr, 2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "branch", condition: "else" });
  });

  it("emits branch event for loop iteration from __iteration_ variable", () => {
    const prev = makeCheckpoint({
      stepPath: "2",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 2 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "2.0",
      stack: {
        stack: [
          {
            args: {},
            locals: { __iteration_2: 3 },
            threads: null,
            step: 2,
          },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = detectBranches(prev, curr, 3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "branch",
      condition: "for",
      iteration: 3,
    });
  });

  it("returns empty when no branch-related internal vars change", () => {
    const prev = makeCheckpoint({ stepPath: "0" });
    const curr = makeCheckpoint({ stepPath: "1" });
    const events = detectBranches(prev, curr, 1);
    expect(events).toEqual([]);
  });
});

describe("generateEventLog", () => {
  it("returns empty array for empty checkpoint list", () => {
    expect(generateEventLog([])).toEqual([]);
  });

  it("returns node-enter for single checkpoint", () => {
    const cp = makeCheckpoint({ nodeId: "main" });
    const events = generateEventLog([cp]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "node-enter",
      nodeName: "main",
      step: 0,
    });
  });

  it("produces correct sequence for multi-step trace", () => {
    const cp0 = makeCheckpoint({ nodeId: "main", stepPath: "0" });
    const cp1 = makeCheckpoint({
      nodeId: "main",
      stepPath: "1",
      stack: {
        stack: [
          { args: {}, locals: { x: 42 }, threads: null, step: 1 },
        ],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["main"],
      },
    });
    const events = generateEventLog([cp0, cp1]);
    const types = events.map((e: any) => e.type);
    expect(types).toContain("node-enter");
    expect(types).toContain("variable-set");
  });
});
