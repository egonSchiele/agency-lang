// The verbs on a scripted visit: the refusals, the stale answer, the
// running program, and the exit codes. The readers on a real checkpoint
// are in where.test.ts; the whole path over a socket in index.test.ts.
import { describe, it, expect } from "vitest";
import type { AttachRecord } from "@/debugger/attach/registry.js";
import { EXIT, detach, moveVerb, pause, wait, where, type CommandDeps } from "./commands.js";
import { resolveTarget, sessionWords } from "./target.js";
import type { Next, Visit } from "./visit.js";

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

  it("is refused when the program is waiting on something a command cannot answer", async () => {
    const visit = scripted({ ...ask, method: "promptForInput" }, []);
    const result = await moveVerb(visit, record, "step", deps);
    expect(result.exitCode).toBe(EXIT.refused);
    expect(result.text).toContain("promptForInput");
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

  it("detach releases the hold", () => {
    const visit = scripted(ask, []);
    expect(detach(visit, record).exitCode).toBe(EXIT.ok);
    expect(visit.detached).toBe(1);
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
  };
  const none = { type: "status" as const, terminal: false, cli: null, stopped: false };
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
  });
});
