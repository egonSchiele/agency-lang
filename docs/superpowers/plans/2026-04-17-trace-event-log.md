# Trace Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agency trace log` CLI command that derives a structured JSON event log from an existing trace file by diffing consecutive checkpoints.

**Architecture:** A pure post-hoc diffing approach -- walk consecutive checkpoint pairs, detect what changed (stack frames, variables, messages, node transitions), and emit typed event objects. No changes to the trace format or runtime. The diffing logic lives in `lib/runtime/trace/eventLog.ts`, the CLI wiring in `lib/cli/events.ts`.

**Tech Stack:** TypeScript, vitest, commander (CLI)

**Spec:** `docs/superpowers/specs/2026-04-17-trace-event-log-design.md`

---

### Task 1: Event type definitions

**Files:**
- Create: `lib/runtime/trace/eventLog.ts`
- Test: `lib/runtime/trace/eventLog.test.ts`

- [ ] **Step 1: Write the event type definitions**

Create `lib/runtime/trace/eventLog.ts` with the base event type and all specific event types:

```typescript
import type { Checkpoint } from "../state/checkpointStore.js";
import { GlobalStore } from "../state/globalStore.js";

type BaseEvent = {
  step: number;
  nodeId: string;
  scopeName: string;
  moduleId: string;
  stepPath: string;
};

export type NodeEnterEvent = BaseEvent & {
  type: "node-enter";
  nodeName: string;
};

export type NodeExitEvent = BaseEvent & {
  type: "node-exit";
  nodeName: string;
};

export type FunctionEnterEvent = BaseEvent & {
  type: "function-enter";
  functionName: string;
  args: Record<string, any>;
};

export type FunctionExitEvent = BaseEvent & {
  type: "function-exit";
  functionName: string;
  returnValue?: any;
};

export type VariableSetEvent = BaseEvent & {
  type: "variable-set";
  variable: string;
  value: any;
  previousValue: any;
  scope: "local" | "global";
};

export type LlmCallEvent = BaseEvent & {
  type: "llm-call";
  prompt: string;
  response: string;
  toolCalls: Array<{ name: string; arguments: any; result?: any }>;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
  } | null;
};

export type ToolCallEvent = BaseEvent & {
  type: "tool-call";
  toolName: string;
  args: any;
  result: any;
};

export type InterruptThrownEvent = BaseEvent & {
  type: "interrupt-thrown";
  message: string;
};

export type InterruptResolvedEvent = BaseEvent & {
  type: "interrupt-resolved";
  outcome: "approved" | "rejected" | "resolved";
  data?: any;
};

export type BranchEvent = BaseEvent & {
  type: "branch";
  condition: "if" | "else" | "while" | "for";
  iteration?: number;
};

export type TraceEvent =
  | NodeEnterEvent
  | NodeExitEvent
  | FunctionEnterEvent
  | FunctionExitEvent
  | VariableSetEvent
  | LlmCallEvent
  | ToolCallEvent
  | InterruptThrownEvent
  | InterruptResolvedEvent
  | BranchEvent;
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm run build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add lib/runtime/trace/eventLog.ts
git commit -m "feat: add trace event log type definitions"
```

---

### Task 2: Helper — `makeBaseEvent`

**Files:**
- Modify: `lib/runtime/trace/eventLog.ts`
- Test: `lib/runtime/trace/eventLog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/trace/eventLog.test.ts`:

```typescript
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

// Helper to create test checkpoints with minimal boilerplate.
// Override any field via the overrides param.
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: FAIL — `makeBaseEvent` is not exported

- [ ] **Step 3: Implement makeBaseEvent**

Add to `lib/runtime/trace/eventLog.ts`:

```typescript
export function makeBaseEvent(checkpoint: Checkpoint, step: number): BaseEvent {
  return {
    step,
    nodeId: checkpoint.nodeId,
    scopeName: checkpoint.scopeName,
    moduleId: checkpoint.moduleId,
    stepPath: checkpoint.stepPath,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/eventLog.ts lib/runtime/trace/eventLog.test.ts
git commit -m "feat: add makeBaseEvent helper for trace event log"
```

---

### Task 3: Node transition detector

**Files:**
- Modify: `lib/runtime/trace/eventLog.ts`
- Modify: `lib/runtime/trace/eventLog.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `eventLog.test.ts`:

```typescript
describe("detectNodeTransitions", () => {
  it("emits node-enter for the first checkpoint", () => {
    const curr = makeCheckpoint({ nodeId: "main" });
    const events = detectNodeTransitions(null, curr, 0);
    expect(events).toEqual([
      { step: 0, nodeId: "main", scopeName: "main", moduleId: "test.agency", stepPath: "0", type: "node-enter", nodeName: "main" },
    ]);
  });

  it("emits node-exit and node-enter when nodeId changes", () => {
    const prev = makeCheckpoint({ nodeId: "main", stepPath: "1" });
    const curr = makeCheckpoint({ nodeId: "categorize", stepPath: "0" });
    const events = detectNodeTransitions(prev, curr, 2);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("node-exit");
    expect(events[0].nodeName).toBe("main");
    expect(events[1].type).toBe("node-enter");
    expect(events[1].nodeName).toBe("categorize");
  });

  it("returns empty when nodeId unchanged", () => {
    const prev = makeCheckpoint({ nodeId: "main", stepPath: "0" });
    const curr = makeCheckpoint({ nodeId: "main", stepPath: "1" });
    const events = detectNodeTransitions(prev, curr, 1);
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement detectNodeTransitions**

Add to `eventLog.ts`:

```typescript
export function detectNodeTransitions(
  prev: Checkpoint | null,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];

  if (prev === null) {
    events.push({ ...makeBaseEvent(curr, step), type: "node-enter", nodeName: curr.nodeId });
    return events;
  }

  if (prev.nodeId !== curr.nodeId) {
    events.push({ ...makeBaseEvent(prev, step), type: "node-exit", nodeName: prev.nodeId });
    events.push({ ...makeBaseEvent(curr, step), type: "node-enter", nodeName: curr.nodeId });
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/eventLog.ts lib/runtime/trace/eventLog.test.ts
git commit -m "feat: add node transition detector for trace event log"
```

---

### Task 4: Stack frame change detector

**Files:**
- Modify: `lib/runtime/trace/eventLog.ts`
- Modify: `lib/runtime/trace/eventLog.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `eventLog.test.ts`:

```typescript
describe("detectStackChanges", () => {
  it("emits function-enter when a new frame is pushed", () => {
    const prev = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 1 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      scopeName: "greet",
      stepPath: "0",
      stack: {
        stack: [
          { args: {}, locals: {}, threads: null, step: 1 },
          { args: { name: "Alice" }, locals: { name: "Alice" }, threads: null, step: 0 },
        ],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
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
          { args: { name: "Alice" }, locals: { name: "Alice" }, threads: null, step: 2 },
        ],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      scopeName: "main",
      stepPath: "2",
      stack: {
        stack: [
          { args: {}, locals: { result: "Hello!" }, threads: null, step: 2 },
        ],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement detectStackChanges**

Add to `eventLog.ts`:

```typescript
// Note: isInternalVar is defined here but also used in Task 5.
// If implementing in order, this function will already exist.
function isInternalVar(name: string): boolean {
  return name.startsWith("__");
}

export function detectStackChanges(
  prev: Checkpoint,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];
  const prevDepth = prev.stack.stack.length;
  const currDepth = curr.stack.stack.length;

  if (currDepth > prevDepth) {
    // Frames were pushed — function entered
    for (let i = prevDepth; i < currDepth; i++) {
      const frame = curr.stack.stack[i];
      events.push({
        ...makeBaseEvent(curr, step),
        type: "function-enter",
        functionName: curr.scopeName,
        args: { ...frame.args },
      });
    }
  } else if (currDepth < prevDepth) {
    // Frames were popped — function exited
    // Look for a new variable in the caller's frame as the return value
    const callerFrame = curr.stack.stack.at(-1);
    const prevCallerFrame = prev.stack.stack[currDepth - 1];
    let returnValue: any = undefined;
    if (callerFrame && prevCallerFrame) {
      for (const key of Object.keys(callerFrame.locals)) {
        if (!isInternalVar(key) && !(key in prevCallerFrame.locals)) {
          returnValue = callerFrame.locals[key];
          break;
        }
      }
    }
    for (let i = prevDepth - 1; i >= currDepth; i--) {
      events.push({
        ...makeBaseEvent(prev, step),
        type: "function-exit",
        functionName: prev.scopeName,
        ...(returnValue !== undefined ? { returnValue } : {}),
      });
    }
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/eventLog.ts lib/runtime/trace/eventLog.test.ts
git commit -m "feat: add stack frame change detector for trace event log"
```

---

### Task 5: Variable change detector

**Files:**
- Modify: `lib/runtime/trace/eventLog.ts`
- Modify: `lib/runtime/trace/eventLog.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `eventLog.test.ts`:

```typescript
describe("detectVariableChanges", () => {
  it("emits variable-set for new local variable", () => {
    const prev = makeCheckpoint({
      stepPath: "0",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 0 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: { name: "Alice" }, threads: null, step: 1 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
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
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "2",
      stack: {
        stack: [{ args: {}, locals: { x: 2 }, threads: null, step: 2 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
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
      globals: { store: { "test.agency": { count: 0 } }, initializedModules: ["test.agency"] },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      globals: { store: { "test.agency": { count: 1 } }, initializedModules: ["test.agency"] },
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
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: { __substep_0: 1, name: "Bob" }, threads: null, step: 1 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const events = detectVariableChanges(prev, curr, 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ variable: "name" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement detectVariableChanges**

Add to `eventLog.ts`:

```typescript
function isInternalVar(name: string): boolean {
  return name.startsWith("__");
}

function diffObject(
  prev: Record<string, any>,
  curr: Record<string, any>,
): Array<{ key: string; value: any; previousValue: any }> {
  const changes: Array<{ key: string; value: any; previousValue: any }> = [];
  for (const key of Object.keys(curr)) {
    if (isInternalVar(key)) continue;
    const prevVal = prev[key];
    const currVal = curr[key];
    if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
      changes.push({ key, value: currVal, previousValue: prevVal ?? null });
    }
  }
  return changes;
}

export function detectVariableChanges(
  prev: Checkpoint,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];
  const base = makeBaseEvent(curr, step);

  // Diff locals in the top frame (only if stack depth is the same)
  const prevFrame = prev.stack.stack.at(-1);
  const currFrame = curr.stack.stack.at(-1);
  if (prevFrame && currFrame && prev.stack.stack.length === curr.stack.stack.length) {
    for (const change of diffObject(prevFrame.locals, currFrame.locals)) {
      events.push({
        ...base,
        type: "variable-set",
        variable: change.key,
        value: change.value,
        previousValue: change.previousValue,
        scope: "local",
      });
    }
  }

  // Diff globals for each module
  const prevStore = prev.globals.store ?? {};
  const currStore = curr.globals.store ?? {};
  for (const moduleId of Object.keys(currStore)) {
    if (moduleId === GlobalStore.INTERNAL_MODULE) continue;
    const prevMod = prevStore[moduleId] ?? {};
    const currMod = currStore[moduleId] ?? {};
    for (const change of diffObject(prevMod, currMod)) {
      events.push({
        ...base,
        type: "variable-set",
        variable: change.key,
        value: change.value,
        previousValue: change.previousValue,
        scope: "global",
      });
    }
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/eventLog.ts lib/runtime/trace/eventLog.test.ts
git commit -m "feat: add variable change detector for trace event log"
```

---

### Task 6: LLM call and tool call detector

**Files:**
- Modify: `lib/runtime/trace/eventLog.ts`
- Modify: `lib/runtime/trace/eventLog.test.ts`

**Reference:** Check `lib/runtime/state/checkpointStore.ts:78-117` for how thread messages are stored, and `lib/runtime/state/globalStore.ts` for the `__internal__` module and `__tokenStats` key structure.

- [ ] **Step 1: Write the failing tests**

Add to `eventLog.test.ts`:

```typescript
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
        stack: [{ args: {}, locals: {}, threads: makeThreads([]), step: 0 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{
          args: {}, locals: {}, step: 1,
          threads: makeThreads([
            { role: "user", content: "What is 2+2?" },
            { role: "assistant", content: "4" },
          ]),
        }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
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
        stack: [{ args: {}, locals: {}, threads: makeThreads([]), step: 0 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{
          args: {}, locals: {}, step: 1,
          threads: makeThreads([
            { role: "user", content: "Add 4+5" },
            { role: "assistant", content: null, toolCalls: [{ name: "add", arguments: { a: 4, b: 5 } }] },
            { role: "tool", content: "9", toolCallId: "1" },
            { role: "assistant", content: "The answer is 9" },
          ]),
        }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
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
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "2",
      stack: {
        stack: [{ args: {}, locals: {}, threads, step: 2 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const events = detectLlmCalls(prev, curr, 2);
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement detectLlmCalls**

Add to `eventLog.ts`:

```typescript
function getMessages(checkpoint: Checkpoint): any[] {
  const frame = checkpoint.stack.stack.at(-1);
  if (!frame?.threads) return [];
  const { threads, activeStack } = frame.threads;
  const threadIds = Object.keys(threads);
  if (threadIds.length === 0) return [];
  const activeId = activeStack.findLast((id: string) => threads[id] != null) ?? threadIds[0];
  return threads[activeId]?.messages ?? [];
}

function getMessageContent(message: any): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part: any) => part.text ?? "").join("");
  }
  if (message.content == null && message.toolCalls) {
    return message.toolCalls
      .map((tc: any) => `Tool call: ${tc.name}(${JSON.stringify(tc.arguments)})`)
      .join("\n");
  }
  return message.content == null ? "" : JSON.stringify(message.content);
}

function getTokenUsageDiff(
  prev: Checkpoint,
  curr: Checkpoint,
): LlmCallEvent["tokenUsage"] {
  const prevStats = prev.globals.store?.["__internal"]?.["__tokenStats"];
  const currStats = curr.globals.store?.["__internal"]?.["__tokenStats"];
  if (!currStats?.usage) return null;
  if (!prevStats?.usage) return { ...currStats.usage };
  return {
    inputTokens: (currStats.usage.inputTokens ?? 0) - (prevStats.usage.inputTokens ?? 0),
    outputTokens: (currStats.usage.outputTokens ?? 0) - (prevStats.usage.outputTokens ?? 0),
    cachedInputTokens: (currStats.usage.cachedInputTokens ?? 0) - (prevStats.usage.cachedInputTokens ?? 0),
    totalTokens: (currStats.usage.totalTokens ?? 0) - (prevStats.usage.totalTokens ?? 0),
  };
}

export function detectLlmCalls(
  prev: Checkpoint,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];
  const base = makeBaseEvent(curr, step);

  const prevMessages = getMessages(prev);
  const currMessages = getMessages(curr);

  if (currMessages.length <= prevMessages.length) return events;

  const newMessages = currMessages.slice(prevMessages.length);
  const toolCalls: Array<{ name: string; arguments: any; result?: any }> = [];

  let prompt = "";
  let response = "";

  for (const msg of newMessages) {
    if (msg.role === "user") {
      prompt = getMessageContent(msg);
    } else if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCalls.push({ name: tc.name, arguments: tc.arguments });
      }
    } else if (msg.role === "tool") {
      // Match to most recent tool call without a result
      const pending = toolCalls.findLast((tc) => tc.result === undefined);
      if (pending) {
        pending.result = getMessageContent(msg);
        events.push({
          ...base,
          type: "tool-call",
          toolName: pending.name,
          args: pending.arguments,
          result: pending.result,
        });
      }
    } else if (msg.role === "assistant") {
      response = getMessageContent(msg);
    }
  }

  events.push({
    ...base,
    type: "llm-call",
    prompt,
    response,
    toolCalls: toolCalls.map(({ name, arguments: args, result }) => ({ name, arguments: args, result })),
    tokenUsage: getTokenUsageDiff(prev, curr),
  });

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/eventLog.ts lib/runtime/trace/eventLog.test.ts
git commit -m "feat: add LLM call and tool call detector for trace event log"
```

---

### Task 7: Interrupt detector

**Files:**
- Modify: `lib/runtime/trace/eventLog.ts`
- Modify: `lib/runtime/trace/eventLog.test.ts`

**Reference:** Check `lib/runtime/state/checkpointStore.ts` for `RESULT_ENTRY_LABEL` and other interrupt-related labels.

- [ ] **Step 1: Write the failing tests**

Add to `eventLog.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement detectInterrupts**

Add to `eventLog.ts`:

```typescript
const INTERRUPT_LABELS = ["result-entry"];

function isInterruptLabel(label: string | null): boolean {
  if (!label) return false;
  return INTERRUPT_LABELS.some((il) => label.includes(il));
}

export function detectInterrupts(
  prev: Checkpoint,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];

  if (isInterruptLabel(curr.label)) {
    events.push({
      ...makeBaseEvent(curr, step),
      type: "interrupt-thrown",
      message: curr.label ?? "",
    });
  }

  if (isInterruptLabel(prev.label) && !isInterruptLabel(curr.label)) {
    events.push({
      ...makeBaseEvent(curr, step),
      type: "interrupt-resolved",
      outcome: "approved",
    });
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/eventLog.ts lib/runtime/trace/eventLog.test.ts
git commit -m "feat: add interrupt detector for trace event log"
```

---

### Task 8: Branch/control flow detector

**Files:**
- Modify: `lib/runtime/trace/eventLog.ts`
- Modify: `lib/runtime/trace/eventLog.test.ts`

**Reference:** Internal variables like `__condbranch_*` and `__iteration_*` in checkpoint locals indicate branch/loop state.

- [ ] **Step 1: Write the failing tests**

Add to `eventLog.test.ts`:

```typescript
describe("detectBranches", () => {
  it("emits branch event for if condition from __condbranch_ variable", () => {
    const prev = makeCheckpoint({
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: {}, threads: null, step: 1 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1.0",
      stack: {
        stack: [{ args: {}, locals: { __condbranch_1: true }, threads: null, step: 1 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
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
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "1.0",
      stack: {
        stack: [{ args: {}, locals: { __condbranch_1: false }, threads: null, step: 1 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
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
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const curr = makeCheckpoint({
      stepPath: "2.0",
      stack: {
        stack: [{ args: {}, locals: { __iteration_2: 3 }, threads: null, step: 2 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const events = detectBranches(prev, curr, 3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "branch", condition: "for", iteration: 3 });
  });

  it("returns empty when no branch-related internal vars change", () => {
    const prev = makeCheckpoint({ stepPath: "0" });
    const curr = makeCheckpoint({ stepPath: "1" });
    const events = detectBranches(prev, curr, 1);
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement detectBranches**

Add to `eventLog.ts`:

```typescript
export function detectBranches(
  prev: Checkpoint,
  curr: Checkpoint,
  step: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];
  const base = makeBaseEvent(curr, step);

  const prevLocals = prev.stack.stack.at(-1)?.locals ?? {};
  const currLocals = curr.stack.stack.at(-1)?.locals ?? {};

  // Check for new or changed __condbranch_ variables
  for (const key of Object.keys(currLocals)) {
    if (key.startsWith("__condbranch_")) {
      const prevVal = prevLocals[key];
      const currVal = currLocals[key];
      if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
        events.push({
          ...base,
          type: "branch",
          condition: currVal ? "if" : "else",
        });
      }
    }

    if (key.startsWith("__iteration_")) {
      const prevVal = prevLocals[key];
      const currVal = currLocals[key];
      if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
        events.push({
          ...base,
          type: "branch",
          condition: "for",
          iteration: currVal,
        });
      }
    }
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/eventLog.ts lib/runtime/trace/eventLog.test.ts
git commit -m "feat: add branch/control flow detector for trace event log"
```

---

### Task 9: Main `generateEventLog` function

**Files:**
- Modify: `lib/runtime/trace/eventLog.ts`
- Modify: `lib/runtime/trace/eventLog.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `eventLog.test.ts`:

```typescript
describe("generateEventLog", () => {
  it("returns empty array for empty checkpoint list", () => {
    expect(generateEventLog([])).toEqual([]);
  });

  it("returns node-enter for single checkpoint", () => {
    const cp = makeCheckpoint({ nodeId: "main" });
    const events = generateEventLog([cp]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "node-enter", nodeName: "main", step: 0 });
  });

  it("produces correct sequence for multi-step trace", () => {
    const cp0 = makeCheckpoint({ nodeId: "main", stepPath: "0" });
    const cp1 = makeCheckpoint({
      nodeId: "main",
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: { x: 42 }, threads: null, step: 1 }],
        mode: "serialize", other: {}, deserializeStackLength: 0, nodesTraversed: ["main"],
      },
    });
    const events = generateEventLog([cp0, cp1]);
    const types = events.map((e: any) => e.type);
    expect(types).toContain("node-enter");
    expect(types).toContain("variable-set");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement generateEventLog**

Add to `eventLog.ts`:

```typescript
export function generateEventLog(checkpoints: Checkpoint[]): TraceEvent[] {
  if (checkpoints.length === 0) return [];

  const events: TraceEvent[] = [];

  // First checkpoint: emit node-enter
  events.push(...detectNodeTransitions(null, checkpoints[0], 0));

  // Walk consecutive pairs
  for (let i = 1; i < checkpoints.length; i++) {
    const prev = checkpoints[i - 1];
    const curr = checkpoints[i];
    const step = i;

    events.push(...detectNodeTransitions(prev, curr, step));
    events.push(...detectStackChanges(prev, curr, step));
    events.push(...detectVariableChanges(prev, curr, step));
    events.push(...detectLlmCalls(prev, curr, step));
    events.push(...detectInterrupts(prev, curr, step));
    events.push(...detectBranches(prev, curr, step));
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run lib/runtime/trace/eventLog.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/eventLog.ts lib/runtime/trace/eventLog.test.ts
git commit -m "feat: add generateEventLog orchestrator for trace event log"
```

---

### Task 10: CLI command — `agency trace log`

**Files:**
- Create: `lib/cli/events.ts`
- Modify: `scripts/agency.ts`

**Reference:** Check `scripts/agency.ts:92-101` for the existing `trace` command. Check `lib/cli/bundle.ts` for the CLI pattern to follow.

- [ ] **Step 1: Create lib/cli/events.ts**

```typescript
import * as fs from "fs";
import { TraceReader } from "../runtime/trace/traceReader.js";
import { generateEventLog } from "../runtime/trace/eventLog.js";

export function traceLog(
  inputFile: string,
  outputFile?: string,
): void {
  const reader = TraceReader.fromFile(inputFile);
  const events = generateEventLog(reader.checkpoints);
  const json = JSON.stringify(events, null, 2);

  if (outputFile) {
    fs.writeFileSync(outputFile, json, "utf-8");
    console.log(`Event log written to ${outputFile} (${events.length} events)`);
  } else {
    console.log(json);
  }
}
```

- [ ] **Step 2: Convert the `trace` command to a command group in scripts/agency.ts**

In `scripts/agency.ts`, replace the existing `trace` command (lines 92-101):

```typescript
const traceCmd = program
  .command("trace")
  .description("Trace-related commands");

traceCmd
  .command("run", { isDefault: true })
  .description("Compile and run .agency file, generating a trace")
  .argument("<input>", "Path to .agency input file")
  .option("-o, --output <file>", "Output trace file path (default: <input>.trace)")
  .option("--resume <statefile>", "Resume execution from a saved state file")
  .action((input: string, options: { output?: string; resume?: string }) => {
    const traceFile = options.output || input.replace(/\.agency$/, ".trace");
    runWithOptions(input, { trace: traceFile, resume: options.resume });
  });

traceCmd
  .command("log")
  .description("Generate a JSON event log from a trace file")
  .argument("<file>", "Path to .agencytrace or .agencybundle file")
  .option("-o, --output <file>", "Output JSON file path (default: stdout)")
  .action((file: string, options: { output?: string }) => {
    traceLog(file, options.output);
  });
```

Add the import at the top of `scripts/agency.ts`:

```typescript
import { traceLog } from "@/cli/events.js";
```

- [ ] **Step 3: Build and verify**

Run: `make all`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add lib/cli/events.ts scripts/agency.ts
git commit -m "feat: add 'agency trace log' CLI command for event log generation"
```

---

### Task 11: Integration test with a real trace

**Files:**
- Create: `lib/cli/events.test.ts`

**Reference:** Check `lib/cli/bundle.test.ts` for the pattern of writing traces and reading them back.

- [ ] **Step 1: Write the integration test**

Create `lib/cli/events.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TraceWriter } from "../runtime/trace/traceWriter.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { traceLog } from "./events.js";

describe("traceLog integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "events-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates event log from trace file and writes to output", () => {
    const tracePath = path.join(tmpDir, "test.agencytrace");
    const outputPath = path.join(tmpDir, "events.json");

    const writer = new TraceWriter(tracePath, "test.agency");
    writer.writeCheckpoint(
      new Checkpoint({
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
      }),
    );
    writer.writeCheckpoint(
      new Checkpoint({
        id: 1,
        nodeId: "main",
        moduleId: "test.agency",
        scopeName: "main",
        stepPath: "1",
        label: null,
        pinned: false,
        stack: {
          stack: [{ args: {}, locals: { greeting: "hello" }, threads: null, step: 1 }],
          mode: "serialize" as const,
          other: {},
          deserializeStackLength: 0,
          nodesTraversed: ["main"],
        },
        globals: {
          store: { "test.agency": {} },
          initializedModules: ["test.agency"],
        },
      }),
    );

    traceLog(tracePath, outputPath);

    const output = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBeGreaterThan(0);

    // Should have node-enter and variable-set events
    const types = output.map((e: any) => e.type);
    expect(types).toContain("node-enter");
    expect(types).toContain("variable-set");

    const varEvent = output.find((e: any) => e.type === "variable-set");
    expect(varEvent.variable).toBe("greeting");
    expect(varEvent.value).toBe("hello");
  });

  it("handles empty trace (no checkpoints)", () => {
    const tracePath = path.join(tmpDir, "empty.agencytrace");
    const outputPath = path.join(tmpDir, "events.json");

    // Write only a header (no checkpoints)
    const writer = new TraceWriter(tracePath, "test.agency");
    // TraceWriter writes header on construction, so just close without checkpoints

    traceLog(tracePath, outputPath);

    const output = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    expect(output).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm test:run lib/cli/events.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add lib/cli/events.test.ts
git commit -m "test: add integration tests for trace event log CLI"
```
