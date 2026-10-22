import { describe, expect, it } from "vitest";
import { guardWrites, resolve } from "./lower.js";
import { agentShapedCheckpoint, ROOT, TOOL } from "./testCheckpoints.js";

const AT_ROUND = { branchPath: [], loopStop: "round" as const };
const IN_SEARCH = { branchPath: ["tool_0_abc"], loopStop: undefined };
const LOOP = [...ROOT, "1", "locals"];

describe("resolve: appendMessage", () => {
  it("queues behind an unanswered tool call, appends otherwise", () => {
    const cp = agentShapedCheckpoint();
    // The root loop's thread ends in an unanswered call to search.
    expect(resolve({ op: "appendMessage", text: "stop" }, cp, AT_ROUND)).toEqual([
      {
        jsonPath: [...LOOP, "messagesJSON", "queuedMessages"],
        value: [{ role: "user", content: "stop", label: null }],
        applied: "queued on thread main, delivered after 1 pending tool result",
      },
    ]);
    // The tool's own thread ends in a user message.
    expect(resolve({ op: "appendMessage", text: "hi", role: "assistant" }, cp, IN_SEARCH)).toEqual([
      {
        jsonPath: [...TOOL, "1", "locals", "messagesJSON", "messages"],
        value: [
          { role: "user", content: "summarize" },
          { role: "assistant", content: "hi" },
        ],
        applied: "appended to thread search (2 messages)",
      },
    ]);
  });
});

describe("resolve: removeTool", () => {
  it("adds to the loop's removed list once, from the next round", () => {
    const cp = agentShapedCheckpoint();
    expect(resolve({ op: "removeTool", tool: "search" }, cp, AT_ROUND)).toEqual([
      {
        jsonPath: [...LOOP, "removedTools"],
        value: ["search"],
        applied: "removed search from the next round",
      },
    ]);
    expect(resolve({ op: "removeTool", tool: "nope" }, cp, AT_ROUND)).toEqual({
      refused: "no tool nope in this loop (search, writeUp)",
    });
    // The tool's loop recorded no tool names, so any name is taken.
    expect(resolve({ op: "removeTool", tool: "anything" }, cp, IN_SEARCH)).toMatchObject([
      { value: ["anything"] },
    ]);
  });
});

describe("guardWrites and resolve: setGuard", () => {
  const owner = {
    jsonPath: ["g", "0"],
    owner: true,
    json: { kind: "time" as const, timeLimit: 60000 },
  };
  const clone = {
    jsonPath: ["c", "0"],
    owner: false,
    json: { kind: "time" as const, timeLimit: 50000 },
  };

  it("disarmed writes every copy; a time limit moves each clone by the difference", () => {
    expect(guardWrites([owner, clone], { disarmed: true })).toEqual([
      { jsonPath: ["g", "0", "disarmed"], value: true, applied: "disarmed" },
      { jsonPath: ["c", "0", "disarmed"], value: true, applied: "disarmed" },
    ]);
    expect(guardWrites([owner, clone], { limit: 90000 })).toEqual([
      { jsonPath: ["g", "0", "timeLimit"], value: 90000, applied: "limit 60000 → 90000" },
      { jsonPath: ["c", "0", "timeLimit"], value: 80000, applied: "limit 60000 → 90000" },
    ]);
  });

  it("a cost limit writes the owner only", () => {
    const cost = {
      jsonPath: ["g", "1"],
      owner: true,
      json: { kind: "cost" as const, costLimit: 1 },
    };
    const costClone = {
      jsonPath: ["c", "1"],
      owner: false,
      json: { kind: "cost" as const, costLimit: 1 },
    };
    expect(guardWrites([cost, costClone], { limit: 2 })).toEqual([
      { jsonPath: ["g", "1", "costLimit"], value: 2, applied: "limit 1 → 2" },
    ]);
  });

  it("resolves the guard's copies and refuses the root budget", () => {
    const cp = agentShapedCheckpoint();
    expect(
      resolve({ op: "setGuard", guard: { label: "research" }, limit: 90000 }, cp, IN_SEARCH),
    ).toEqual([
      {
        jsonPath: ["stack", "guards", "0", "timeLimit"],
        value: 90000,
        applied: "limit 60000 → 90000",
      },
      {
        jsonPath: [
          ...ROOT,
          "1",
          "branches",
          "tool_0_abc",
          "stack",
          "inheritedTimeGuards",
          "0",
          "timeLimit",
        ],
        value: 80000,
        applied: "limit 60000 → 90000",
      },
    ]);
    expect(resolve({ op: "setGuard", guard: { index: 1 }, disarmed: true }, cp, AT_ROUND)).toEqual({
      refused: "guard 1 is the root budget; the host sets its ceiling",
    });
  });
});

describe("resolve: setLocal, setArg, setGlobal", () => {
  it("writes the named field on the resolved frame or store", () => {
    const cp = agentShapedCheckpoint();
    expect(resolve({ op: "setLocal", name: "answer", value: "x" }, cp, AT_ROUND)).toEqual([
      { jsonPath: [...ROOT, "0", "locals", "answer"], value: "x", applied: 'answer = "x"' },
    ]);
    expect(
      resolve(
        {
          op: "setArg",
          frame: { branchPath: ["tool_0_abc"], scope: "search" },
          name: "query",
          value: "other",
        },
        cp,
        AT_ROUND,
      ),
    ).toEqual([
      { jsonPath: [...TOOL, "0", "args", "query"], value: "other", applied: 'query = "other"' },
    ]);
    expect(resolve({ op: "setGlobal", name: "x", value: 3 }, cp, IN_SEARCH)).toEqual([
      {
        jsonPath: [...ROOT, "1", "branches", "tool_0_abc", "globalsJSON", "store", "mod", "x"],
        value: 3,
        applied: "mod.x = 3",
      },
    ]);
  });
});

describe("resolve: setBranchResult", () => {
  it("gives a fork branch a result, and refuses a tool call", () => {
    const cp = agentShapedCheckpoint();
    expect(
      resolve({ op: "setBranchResult", branch: { key: "fork_1" }, value: 7 }, cp, IN_SEARCH),
    ).toEqual([
      {
        jsonPath: [...TOOL, "1", "branches", "fork_1", "result"],
        value: { result: 7 },
        applied: "branch fork_1 finished with 7",
      },
    ]);
    expect(
      resolve({ op: "setBranchResult", branch: { key: "tool_0_abc" }, value: 7 }, cp, AT_ROUND),
    ).toEqual({
      refused: "a tool call's result is loop bookkeeping; see the spec's not goals",
    });
    // A branch stopped on an interrupt takes a result too: the resume
    // skips it, and the interrupt's answer goes unread.
    expect(
      resolve({ op: "setBranchResult", branch: { key: "fork_2" }, value: 7 }, cp, AT_ROUND),
    ).toMatchObject([{ value: { result: 7 } }]);
  });
});
