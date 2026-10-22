import { Checkpoint } from "../checkpointStore.js";
import type { GlobalStoreJSON } from "../globalStore.js";
import type { StateJSON, StateStackJSON } from "../stateStack.js";

/** A stack as a run serializes it, from partial frames. */
export function makeStackJSON(frames: Partial<StateJSON>[] = []): StateStackJSON {
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
    nodesTraversed: ["main"],
  };
}

export function makeGlobalsJSON(store: Record<string, Record<string, any>> = {}): GlobalStoreJSON {
  return { store, initializedModules: Object.keys(store) };
}

export const ROOT = ["stack", "stack"];
export const TOOL = [...ROOT, "1", "branches", "tool_0_abc", "stack", "stack"];

/** An agent-shaped checkpoint built by hand: a node frame holding the
 *  store's thread `m`, a tool loop holding its newer copy of `m` with
 *  one unanswered call to `search`, and that call's branch, whose own
 *  loop holds a thread `sub` no store serializes and a fork branch
 *  below it. A labelled time guard on the root stack has a clone on the
 *  tool's stack. The root also carries a root cost budget. */
export function agentShapedCheckpoint(): Checkpoint {
  const stack = makeStackJSON([
    {
      scopeName: "main",
      args: { task: "research" },
      locals: { answer: null },
      threads: {
        threads: { m: { id: "m", messages: [{ role: "user", content: "task" }], label: "main" } },
        counter: 1,
        activeStack: ["m"],
      },
    },
    {
      scopeName: "runPrompt",
      locals: {
        toolCallRound: 0,
        removedTools: [],
        toolNames: ["search", "writeUp"],
        messagesJSON: {
          id: "m",
          messages: [
            { role: "user", content: "task" },
            { role: "assistant", toolCalls: [{ id: "abc", name: "search" }] },
          ],
        },
      },
      branches: {
        tool_0_abc: {
          stack: makeStackJSON([
            { scopeName: "search", args: { query: "grant" }, locals: { url: "u" } },
            {
              scopeName: "runPrompt",
              locals: {
                toolCallRound: 0,
                removedTools: [],
                messagesJSON: { id: "sub", messages: [{ role: "user", content: "summarize" }] },
              },
              branches: {
                fork_1: { stack: makeStackJSON([{ scopeName: "__block_0", locals: { item: 1 } }]) },
                fork_2: {
                  stack: makeStackJSON([{ scopeName: "__block_0", locals: { item: 2 } }]),
                  interruptId: "i-2",
                },
              },
            },
          ]),
          globalsJSON: makeGlobalsJSON({ mod: { x: 2 } }),
        },
      },
    },
  ]);
  stack.guards = [
    { kind: "time", timeLimit: 60000, elapsedMs: 10000, guardId: "g-time", label: "research" },
    { kind: "cost", costLimit: 1, spent: 0.1, guardId: "g-root", isRootBudget: true },
  ];
  stack.stack[1].branches!.tool_0_abc.stack.inheritedTimeGuards = [
    { kind: "time", timeLimit: 50000, elapsedMs: 1500, guardId: "g-time", label: "research" },
  ];
  return new Checkpoint({
    id: 0,
    stack,
    globals: makeGlobalsJSON({ mod: { x: 1 } }),
    nodeId: "main",
    moduleId: "mod",
    scopeName: "runPrompt",
    stepPath: "0/llm",
    loopStop: "round",
  });
}
