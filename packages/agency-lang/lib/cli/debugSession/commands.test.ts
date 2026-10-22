// The verbs on a scripted visit: the refusals, the stale answer, the
// running program, and the exit codes. The readers on a real checkpoint
// are in where.test.ts; the whole path over a socket in index.test.ts.
import { describe, it, expect } from "vitest";
import type { AttachRecord } from "@/debugger/attach/registry.js";
import { Checkpoint } from "@/runtime/state/checkpointStore.js";
import { agentShapedCheckpoint } from "@/runtime/state/checkpointPatch/testCheckpoints.js";
import {
  EXIT,
  answer,
  checkpoint,
  checkpoints,
  detach,
  edit,
  moveVerb,
  pause,
  rewind,
  saveOrLoad,
  set,
  wait,
  where,
  type CommandDeps,
} from "./commands.js";
import { resolveTarget, sessionWords } from "./target.js";
import type { Next, Shown, Visit } from "./visit.js";

/** The smallest checkpoint a reader can print: one frame, one local. */
function smallCheckpoint(id: number, locals: Record<string, unknown> = { x: 1 }): Checkpoint {
  return new Checkpoint({
    id,
    stack: {
      stack: [{ args: {}, locals, threads: null, step: 1, scopeName: "main" }],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: [],
    },
    globals: { store: {}, initializedModules: [] },
    nodeId: "main",
    moduleId: "mod.agency",
    scopeName: "main",
    stepPath: "0",
  });
}

function shownAt(id: number, locals?: Record<string, unknown>): Shown {
  return { checkpoint: smallCheckpoint(id, locals), stop: undefined, interruptId: undefined };
}

/** The next stop, as a scripted visit reports it. */
function stopAfter(id: number, recent: string[] = [], locals?: Record<string, unknown>): Next {
  return {
    kind: "request",
    request: { type: "request", id: 20 + id, method: "waitForCommand", args: [] },
    shown: shownAt(id, locals),
    recent,
  };
}

const record: AttachRecord = { pid: 4242, program: "agent.js", node: "main", startedAt: 0 };
const parties = { type: "parties" as const, terminal: false, cli: true };

const deps: CommandDeps = {
  cwd: "/nowhere",
  readSourceMap: () => null,
  sourcePathFor: () => null,
  sourceAround: () => null,
  moveWaitMs: 1_000,
};

/** A visit whose answers come from `script`, in order. */
function scripted(
  pending: Visit["pending"],
  script: Next[],
  overrides: Partial<Visit> = {},
): Visit & { sent: unknown[]; paused: number; detached: number } {
  const visit = {
    hello: { type: "hello" as const, program: "agent.js", node: "main", pid: 4242 },
    parties,
    recent: [],
    shown: null,
    pending,
    finished: null,
    queuedEdits: { edits: [], applied: [] },
    sent: [] as unknown[],
    paused: 0,
    detached: 0,
    answer: (result: unknown) => {
      visit.sent.push(result);
      return Promise.resolve(script.shift() ?? { kind: "timeout" as const });
    },
    reply: () => Promise.resolve(script.shift() ?? { kind: "timeout" as const }),
    next: () => Promise.resolve(script.shift() ?? { kind: "timeout" as const }),
    pause: () => {
      visit.paused++;
    },
    detach: () => {
      visit.detached++;
    },
    close: () => {},
    ...overrides,
  };
  return visit;
}

const ask = { type: "request" as const, id: 8, method: "waitForCommand" as const, args: [] };

describe("a moving verb", () => {
  it("is refused on a running program, with the way forward", async () => {
    const visit = scripted(null, []);
    const result = await moveVerb(visit, record, "step", deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(result.text).toContain("`wait` stops here");
    expect(visit.sent).toEqual([]);
  });

  it("is refused when another party answered the stop first, naming them", async () => {
    const visit = scripted(ask, [
      {
        kind: "answered",
        answered: { type: "answered", id: 8, by: "terminal", command: "continue" },
      },
    ]);
    const result = await moveVerb(visit, record, "step", deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(result.text).toBe(
      "the stop you saw was answered by the terminal (continue); run `where` and decide again",
    );
    expect(visit.sent).toEqual([{ type: "step" }]);
  });

  it("reports the program's end with exit code 2", async () => {
    const visit = scripted(ask, [{ kind: "finished", finished: { type: "finished", value: 7 } }]);
    const result = await moveVerb(visit, record, "continue", deps);
    expect(result.exitCode).toBe(EXIT.ended);
    expect(result.text).toBe("Program finished. Return value: 7");
  });

  it("continue says the program is running when no stop follows", async () => {
    const visit = scripted(ask, [{ kind: "timeout" }]);
    const result = await moveVerb(visit, record, "continue", deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("is running");
    expect(visit.sent).toEqual([{ type: "continue" }]);
  });

  it("is refused when the program is waiting on a question, naming the verb that answers it", async () => {
    const visit = scripted({ ...ask, method: "promptForInput" }, []);
    const result = await moveVerb(visit, record, "step", deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(result.text).toContain("promptForInput");
    expect(result.text).toContain("`answer <json>`");
  });

  it("prints where at the stop that follows", async () => {
    const visit = scripted(ask, [stopAfter(2, ["terminal: continue"])]);
    const result = await moveVerb(visit, record, "step", deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("stopped (no statement to show)");
    expect(result.text).toContain("terminal: continue");
  });

  it("continue sees a refusal that came with its reply, before reporting the program running", async () => {
    const visit = scripted(ask, [
      { kind: "answered", answered: { type: "answered", id: 8, by: "terminal", command: "step" } },
    ]);
    const result = await moveVerb(visit, record, "continue", deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(result.text).toContain("answered by the terminal (step)");
  });

  it("the driver's line that a command could not be done is a refusal, not the stop after it", async () => {
    const visit = scripted(ask, [stopAfter(1, ["Already at earliest checkpoint"])]);
    const result = await moveVerb(visit, record, "back", deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(result.text).toBe("Already at earliest checkpoint");
    const saving = scripted(ask, [stopAfter(1, ["Failed to save: EACCES"])]);
    expect((await saveOrLoad(saving, record, "save", "/nowhere/cp", deps)).exitCode).toBe(
      EXIT.refused,
    );
  });
});

describe("the same-stop commands", () => {
  it("set prints the frame of the stop the set redrew", async () => {
    const visit = scripted(ask, [stopAfter(1, ["Set x = 5"], { x: 1 })], { shown: shownAt(0) });
    const result = await set(visit, record, "x", 5, deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("queued x = 5 for the next resume");
    expect(result.text).toContain("#0 main");
    expect(visit.sent).toEqual([{ type: "set", varName: "x", value: 5 }]);
  });

  it("checkpoint says it pinned one", async () => {
    const visit = scripted(ask, [stopAfter(1)]);
    const result = await checkpoint(visit, record, "before", deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toBe('pinned a checkpoint "before"');
  });
});

describe("the two-step commands", () => {
  const picker = (id: number, cps: Checkpoint[]): Next => ({
    kind: "request",
    request: {
      type: "request",
      id,
      method: "showRewindSelector",
      args: [cps.map((cp) => cp.toJSON())],
    },
    shown: null,
    recent: [],
  });

  it("rewind picks by the checkpoint's id, not its place in the list", async () => {
    const replies: unknown[] = [];
    const visit = scripted(
      ask,
      [picker(9, [smallCheckpoint(4), smallCheckpoint(7)]), stopAfter(4)],
      {
        reply: (id: number, result: unknown) => {
          replies.push([id, result]);
          return Promise.resolve(stopAfter(4));
        },
      },
    );
    const result = await rewind(visit, record, 7, deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(replies).toEqual([[9, 7]]);
  });

  it("rewind to a checkpoint that is not there closes the picker and refuses", async () => {
    const replies: unknown[] = [];
    const visit = scripted(ask, [picker(9, [smallCheckpoint(4)])], {
      reply: (id: number, result: unknown) => {
        replies.push([id, result]);
        return Promise.resolve({ kind: "timeout" as const });
      },
    });
    const result = await rewind(visit, record, 7, deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(replies).toEqual([[9, null]]);
  });

  it("checkpoints lists them and closes the panel", async () => {
    const panel: Next = {
      kind: "request",
      request: {
        type: "request",
        id: 9,
        method: "showCheckpointsPanel",
        args: [[smallCheckpoint(4).toJSON()]],
      },
      shown: null,
      recent: [],
    };
    const visit = scripted(ask, [panel], { shown: shownAt(4) });
    const result = await checkpoints(visit, record, deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toBe("> #4 main · mod.agency · step 0");
  });

  it("are refused, like a move, when the program waits on something else", async () => {
    const visit = scripted({ ...ask, method: "showRewindSelector" }, []);
    const result = await checkpoints(visit, record, deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(visit.sent).toEqual([]);
  });
});

describe("answer", () => {
  it("replies to the question with the value, and prints the stop after", async () => {
    const visit = scripted({ ...ask, method: "promptForInput" }, [stopAfter(2)]);
    const result = await answer(visit, record, "yes", deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(visit.sent).toEqual(["yes"]);
  });

  it("checks the answer's shape before sending it", async () => {
    const visit = scripted({ ...ask, method: "answerGuardTrip" }, []);
    const result = await answer(visit, record, "yes", deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(result.text).toContain("not a answerGuardTrip answer");
    expect(visit.sent).toEqual([]);
  });

  it("is refused at a statement stop and on a running program", async () => {
    expect((await answer(scripted(ask, []), record, "yes", deps)).text).toContain("`step`");
    expect((await answer(scripted(null, []), record, "yes", deps)).exitCode).toBe(EXIT.refused);
  });
});

describe("wait", () => {
  it("runs out with exit code 3", async () => {
    const visit = scripted(null, [{ kind: "timeout" }]);
    const result = await wait(visit, record, 30_000, deps);
    expect(result.exitCode).toBe(EXIT.stillRunning);
    expect(result.text).toBe("agent.js is still running after 30s");
  });
});

describe("pause and detach", () => {
  it("pause sends the pause message on a running program, and does nothing on a stopped one", () => {
    const running = scripted(null, []);
    expect(pause(running, record).exitCode).toBe(EXIT.ok);
    expect(running.paused).toBe(1);
    const stopped = scripted(ask, []);
    expect(pause(stopped, record).text).toContain("already stopped");
    expect(stopped.paused).toBe(0);
  });

  it("detach releases the hold, and says whether the program runs on or a terminal keeps it", () => {
    const visit = scripted(ask, []);
    const alone = detach(visit, record);
    expect(alone.exitCode).toBe(EXIT.ok);
    expect(alone.text).toContain("runs on with no debugger");
    expect(visit.detached).toBe(1);
    const shared = scripted(ask, [], { parties: { ...parties, terminal: true } });
    expect(detach(shared, record).text).toContain("the terminal debugger stays on it");
  });
});

describe("where", () => {
  it("on a program that ended before the visit, says so with exit code 2", () => {
    const visit = scripted(null, [], { finished: { type: "finished", error: "boom" } });
    const result = where(visit, record, deps);
    expect(result.exitCode).toBe(EXIT.ended);
    expect(result.text).toBe("Program threw: boom");
  });

  it("on a running program, says so and exits 0", () => {
    const result = where(scripted(null, []), record, deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toBe("agent.js · pid 4242 is running; wait stops here at its next stop");
  });
});

describe("the target", () => {
  const held = {
    type: "status" as const,
    terminal: false,
    cli: { visiting: false, lastVisit: 5 },
    stopped: true,
    finished: false,
  };
  const none = {
    type: "status" as const,
    terminal: false,
    cli: null,
    stopped: false,
    finished: false,
  };
  const other: AttachRecord = { ...record, pid: 1 };

  it("a pid names the program, through the record check", () => {
    const target = resolveTarget(4242, [], () => record);
    expect(target).toEqual({ kind: "program", record });
    expect(resolveTarget(4242, [], () => ({ refused: "gone" }))).toEqual({
      kind: "refused",
      reason: "gone",
    });
  });

  it("with no pid, the one held session is meant", () => {
    const target = resolveTarget(
      undefined,
      [
        { record: other, status: none },
        { record, status: held },
      ],
      () => record,
    );
    expect(target).toEqual({ kind: "program", record });
  });

  it("with no pid and no held session, or more than one, the refusal says what to do", () => {
    expect(resolveTarget(undefined, [], () => record)).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("no Agency program is registered"),
    });
    expect(resolveTarget(undefined, [{ record, status: none }], () => record)).toMatchObject({
      reason: expect.stringContaining("attach <pid>"),
    });
    expect(
      resolveTarget(
        undefined,
        [
          { record: other, status: held },
          { record, status: held },
        ],
        () => record,
      ),
    ).toMatchObject({ reason: "sessions are held on pids 1, 4242; say which with --pid" });
  });

  it("the session column", () => {
    expect(sessionWords(null, 10_000)).toBe("none");
    expect(sessionWords(none, 10_000)).toBe("none");
    expect(sessionWords(held, 10_000)).toBe("held, last visit 10s ago");
    expect(sessionWords({ ...held, terminal: true }, 10_000)).toBe(
      "terminal + held, last visit 10s ago",
    );
    expect(sessionWords({ ...held, cli: { visiting: true, lastVisit: null } }, 10_000)).toBe(
      "visiting",
    );
    expect(sessionWords({ ...held, finished: true }, 10_000)).toBe(
      "finished, held for the next visit",
    );
  });
});

describe("edit", () => {
  const none = { values: {}, drop: false };

  it("with no action lists the edits this stop takes, with the choices and defaults", async () => {
    const visit = scripted(ask, [], { shown: shownAt(0) });
    const result = await edit(visit, record, none, deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("set-local");
    expect(result.text).toContain("--name <x>");
    expect(result.text).toContain("--value <json>");
    expect(result.text).not.toContain("append-message");
    expect(result.json).toEqual({
      edits: [
        {
          name: "set-local",
          flags: [
            { flag: "name", choices: ["x"], default: null },
            { flag: "value", kind: "json" },
          ],
        },
      ],
    });
    expect(visit.sent).toEqual([]);
  });

  it("queues the edit, and prints what the driver applied", async () => {
    const visit = scripted(ask, [stopAfter(1, ["x = 5"], { x: 1 })], { shown: shownAt(0) });
    const result = await edit(
      visit,
      record,
      { action: "set-local", values: { name: "x", value: 5 }, drop: false },
      deps,
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("x = 5");
    expect(visit.sent).toEqual([
      {
        type: "edit",
        edits: [{ op: "setLocal", frame: { branchPath: [], depth: 0 }, name: "x", value: 5 }],
      },
    ]);
  });

  it("a refusal from the driver is a refusal here", async () => {
    const visit = scripted(ask, [stopAfter(1, ["refused: no tool nope in this loop (search)"])], {
      shown: shownAt(0),
    });
    const result = await edit(
      visit,
      record,
      { action: "set-local", values: { name: "x", value: 5 }, drop: false },
      deps,
    );
    expect(result.exitCode).toBe(EXIT.refused);
    expect(result.text).toContain("no tool nope");
  });

  it("refuses a row the stop does not have, naming the choices, and a missing value", async () => {
    const visit = scripted(ask, [], { shown: shownAt(0) });
    const missing = await edit(
      visit,
      record,
      { action: "set-local", values: { name: "y", value: 1 }, drop: false },
      deps,
    );
    expect(missing.exitCode).toBe(EXIT.refused);
    expect(missing.text).toContain("no local y at this stop; the locals are x");
    const noValue = await edit(
      visit,
      record,
      { action: "set-local", values: { name: "x" }, drop: false },
      deps,
    );
    expect(noValue.exitCode).toBe(EXIT.refused);
    expect(noValue.text).toContain("needs --value");
    const noThread = await edit(
      visit,
      record,
      { action: "append-message", values: { text: "stop" }, drop: false },
      deps,
    );
    expect(noThread.exitCode).toBe(EXIT.refused);
    expect(noThread.text).toContain("no thread at this stop");
    expect(visit.sent).toEqual([]);
  });

  it("--drop sends dropEdits", async () => {
    const visit = scripted(ask, [stopAfter(1, ["dropped 1 pending edits"])], { shown: shownAt(0) });
    const result = await edit(visit, record, { values: {}, drop: true }, deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("dropped 1 pending edits");
    expect(visit.sent).toEqual([{ type: "dropEdits" }]);
  });
});

describe("edit on an agent-shaped stop", () => {
  const shown = () => ({
    checkpoint: agentShapedCheckpoint(),
    stop: undefined,
    interruptId: undefined,
  });

  it("lists the guard, tool, and branch verbs with their choices", async () => {
    const visit = scripted(ask, [], { shown: shown() });
    const result = await edit(visit, record, { values: {}, drop: false }, deps);
    expect(result.text).toContain("disarm-guard       --guard <research>");
    expect(result.text).toContain("set-guard-limit    --guard <research>  --amount <amount>");
    expect(result.text).toContain("remove-tool        --tool <search|writeUp>");
    expect(result.text).toContain("set-branch-result  --branch <fork_1|fork_2>  --value <json>");
  });

  it("a tool two loops offer is named with its loop, and a bare name is refused", async () => {
    const checkpoint = agentShapedCheckpoint();
    const inner = checkpoint.stack.stack[1].branches!.tool_0_abc.stack.stack[1];
    inner.locals.toolNames = ["search"];
    const stop = {
      moduleId: "mod",
      scopeName: "search",
      stepPath: "1/llm",
      branchPath: ["tool_0_abc"],
      depth: 0,
      label: "round 1",
      loopStop: "round" as const,
    };
    const visit = scripted(ask, [stopAfter(1, ["removed search from the next round"])], {
      shown: { checkpoint, stop, interruptId: undefined },
    });
    const listing = await edit(visit, record, { values: {}, drop: false }, deps);
    expect(listing.text).toContain(
      "remove-tool        --tool <search@root|writeUp|search@tool_0_abc>",
    );
    const bare = await edit(
      visit,
      record,
      { action: "remove-tool", values: { tool: "search" }, drop: false },
      deps,
    );
    expect(bare.exitCode).toBe(EXIT.refused);
    expect(bare.text).toContain("search names 2 tools; say which: search@root, search@tool_0_abc");
    const qualified = await edit(
      visit,
      record,
      { action: "remove-tool", values: { tool: "search@tool_0_abc" }, drop: false },
      deps,
    );
    expect(qualified.exitCode).toBe(EXIT.ok);
    expect(visit.sent).toEqual([
      {
        type: "edit",
        edits: [{ op: "removeTool", loop: { branchPath: ["tool_0_abc"] }, tool: "search" }],
      },
    ]);
  });

  it("parses an amount with the guard's dimension and refuses one it cannot", async () => {
    const visit = scripted(ask, [stopAfter(1, ["limit 60000 → 120000"])], { shown: shown() });
    const bad = await edit(
      visit,
      record,
      { action: "set-guard-limit", values: { guard: "research", amount: "lots" }, drop: false },
      deps,
    );
    expect(bad.exitCode).toBe(EXIT.refused);
    expect(bad.text).toContain("takes a duration");
    const good = await edit(
      visit,
      record,
      { action: "set-guard-limit", values: { guard: "research", amount: "2m" }, drop: false },
      deps,
    );
    expect(good.exitCode).toBe(EXIT.ok);
    expect(visit.sent).toEqual([
      {
        type: "edit",
        edits: [{ op: "setGuard", guard: { index: 0 }, branchPath: [], limit: 120000 }],
      },
    ]);
  });
});
