import { describe, expect, it } from "vitest";
import {
  resolveBranch,
  resolveFrame,
  resolveGuard,
  resolveLoopFrame,
  resolveModule,
  resolveThread,
} from "./addresses.js";
import { Checkpoint } from "../checkpointStore.js";
import {
  agentShapedCheckpoint,
  makeGlobalsJSON,
  makeStackJSON,
  ROOT,
  TOOL,
} from "./testCheckpoints.js";

const AT_ROUND = { branchPath: [], loopStop: "round" as const };
const IN_SEARCH = { branchPath: ["tool_0_abc"], loopStop: undefined };

describe("resolveFrame", () => {
  it("an omitted address is the frame the stop shows", () => {
    const cp = agentShapedCheckpoint();
    // At the loop's own stop the frame shown is the caller's, under the loop's.
    expect(resolveFrame(undefined, cp, AT_ROUND)).toMatchObject({
      jsonPath: [...ROOT, "0"],
      found: { scopeName: "main" },
    });
    expect(resolveFrame(undefined, cp, IN_SEARCH)).toMatchObject({
      jsonPath: [...TOOL, "1"],
      found: { scopeName: "runPrompt" },
    });
  });

  it("depth counts from the end of the named stack, scope finds the nearest frame", () => {
    const cp = agentShapedCheckpoint();
    expect(resolveFrame({ branchPath: ["tool_0_abc"], depth: 1 }, cp, AT_ROUND)).toMatchObject({
      jsonPath: [...TOOL, "0"],
      found: { scopeName: "search" },
    });
    expect(
      resolveFrame({ branchPath: ["tool_0_abc"], scope: "search" }, cp, AT_ROUND),
    ).toMatchObject({
      jsonPath: [...TOOL, "0"],
    });
    expect(resolveFrame({ scope: "nowhere" }, cp, AT_ROUND)).toEqual({
      refused: "no frame of scope nowhere on this stack",
    });
    expect(resolveFrame({ branchPath: ["tool_9_zzz"] }, cp, AT_ROUND)).toEqual({
      refused: "no branch at tool_9_zzz",
    });
  });

  it("a finished branch, whose stack is empty, has no frame to address", () => {
    const cp = agentShapedCheckpoint();
    const json = cp.toJSON();
    const loop = json.stack.stack[1].branches!.tool_0_abc.stack.stack[1];
    loop.branches!.fork_1 = { stack: makeStackJSON([]), result: { result: 1 } };
    const finished = new Checkpoint(json);
    const address = { branchPath: ["tool_0_abc", "fork_1"] };
    expect(resolveFrame(address, finished, IN_SEARCH)).toEqual({
      refused: "no frames on the stack at tool_0_abc/fork_1",
    });
  });
});

describe("resolveLoopFrame", () => {
  it("finds the nearest loop above the stop, on a parent stack if need be", () => {
    const cp = agentShapedCheckpoint();
    expect(resolveLoopFrame(undefined, cp, AT_ROUND)).toMatchObject({ jsonPath: [...ROOT, "1"] });
    // Inside the tool, the tool's own loop is the nearest.
    expect(resolveLoopFrame(undefined, cp, IN_SEARCH)).toMatchObject({ jsonPath: [...TOOL, "1"] });
    // A stack with no loop of its own: the one above.
    const inFork = { branchPath: ["tool_0_abc", "fork_1"], loopStop: undefined };
    expect(resolveLoopFrame(undefined, cp, inFork)).toMatchObject({ jsonPath: [...TOOL, "1"] });
  });

  it("refuses when no loop is above the stop", () => {
    const cp = new Checkpoint({
      id: 0,
      stack: makeStackJSON([{ scopeName: "main" }]),
      globals: makeGlobalsJSON(),
      nodeId: "main",
    });
    expect(resolveLoopFrame(undefined, cp, { branchPath: [], loopStop: undefined })).toEqual({
      refused: "no tool loop above this stop",
    });
  });
});

describe("resolveThread", () => {
  it("by label, by id, or the active one, with the path a resume reads", () => {
    const cp = agentShapedCheckpoint();
    const loopCopy = [...ROOT, "1", "locals", "messagesJSON", "messages"];
    expect(resolveThread({ label: "main" }, cp, AT_ROUND)).toMatchObject({ jsonPath: loopCopy });
    expect(resolveThread({ id: "m" }, cp, AT_ROUND)).toMatchObject({ jsonPath: loopCopy });
    expect(resolveThread(undefined, cp, AT_ROUND)).toMatchObject({ jsonPath: loopCopy });
    expect(resolveThread(undefined, cp, IN_SEARCH)).toMatchObject({
      jsonPath: [...TOOL, "1", "locals", "messagesJSON", "messages"],
    });
    expect(resolveThread({ label: "nope" }, cp, AT_ROUND)).toEqual({
      refused: "no thread labelled nope",
    });
  });

  it("a label on two threads refuses with both ids", () => {
    const cp = new Checkpoint({
      id: 0,
      stack: makeStackJSON([
        {
          scopeName: "main",
          threads: {
            threads: {
              a: { id: "a", messages: [], label: "search" },
              b: { id: "b", messages: [], label: "search" },
            },
            counter: 2,
            activeStack: ["a"],
          },
        },
      ]),
      globals: makeGlobalsJSON(),
      nodeId: "main",
    });
    expect(resolveThread({ label: "search" }, cp, { branchPath: [], loopStop: undefined })).toEqual(
      {
        refused: "two threads are labelled search: a, b; name one by id",
      },
    );
  });
});

describe("resolveBranch", () => {
  it("by key path or by a unique key", () => {
    const cp = agentShapedCheckpoint();
    const forkPath = [...TOOL, "1", "branches", "fork_1"];
    expect(resolveBranch({ path: ["tool_0_abc", "fork_1"] }, cp)).toMatchObject({
      jsonPath: forkPath,
    });
    expect(resolveBranch({ key: "fork_1" }, cp)).toMatchObject({ jsonPath: forkPath });
    expect(resolveBranch({ key: "fork_9" }, cp)).toEqual({ refused: "no branch fork_9" });
  });
});

describe("resolveGuard", () => {
  it("by label or index, with every copy's path", () => {
    const cp = agentShapedCheckpoint();
    const owner = ["stack", "guards", "0"];
    const clone = [...ROOT, "1", "branches", "tool_0_abc", "stack", "inheritedTimeGuards", "0"];
    expect(resolveGuard({ label: "research" }, undefined, cp, IN_SEARCH)).toMatchObject({
      jsonPath: owner,
      found: { jsonPaths: [owner, clone] },
    });
    expect(resolveGuard({ index: 0 }, undefined, cp, AT_ROUND)).toMatchObject({
      found: { jsonPaths: [owner] },
    });
    expect(resolveGuard({ label: "nope" }, undefined, cp, AT_ROUND)).toEqual({
      refused: "no guard labelled nope",
    });
  });
});

describe("resolveModule", () => {
  it("the stop's module in the store the stop reads", () => {
    const cp = agentShapedCheckpoint();
    expect(resolveModule(undefined, undefined, cp, AT_ROUND)).toEqual({
      jsonPath: ["globals", "store", "mod"],
      found: { x: 1 },
    });
    expect(resolveModule(undefined, undefined, cp, IN_SEARCH)).toEqual({
      jsonPath: [...ROOT, "1", "branches", "tool_0_abc", "globalsJSON", "store", "mod"],
      found: { x: 2 },
    });
    expect(resolveModule("other", undefined, cp, AT_ROUND)).toEqual({
      refused: "no globals for module other",
    });
  });
});
