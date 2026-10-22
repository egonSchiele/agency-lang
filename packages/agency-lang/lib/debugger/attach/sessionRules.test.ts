// The session rules as a table: a state and an event in, the effects and
// the new state out. No socket, no timer, no driver. Every row of `step`
// has a case here; a new rule is a new case.
import { describe, it, expect } from "vitest";
import type { AttachMessage, Hello, RequestMessage } from "./protocol.js";
import {
  emptySession,
  LEASE_MS,
  statusOf,
  step,
  type Effect,
  type SessionState,
} from "./sessionRules.js";

const NOW = 1_700_000_000_000;
const hello: Hello = { type: "hello", program: "agent.agency", node: "main", pid: 42 };
const render: RequestMessage = {
  type: "request",
  id: 7,
  method: "render",
  args: [{ id: 1 }, { line: 4 }],
};
const ask: RequestMessage = { type: "request", id: 8, method: "waitForCommand", args: [] };
const finished: AttachMessage = { type: "finished", value: 3 };

function withHello(state: SessionState = emptySession()): SessionState {
  return { ...state, hello };
}

/** A session a terminal joined, at the stop `render` and `ask` describe. */
function terminalAtStop(): SessionState {
  return { ...withHello(), attachedSince: NOW, terminal: 1, pending: [ask], lastRender: render };
}

/** A session the CLI holds with no visit connected, at the same stop. */
function heldAtStop(): SessionState {
  return {
    ...withHello(),
    attachedSince: NOW,
    cli: { visit: null, lastVisit: NOW },
    pending: [ask],
    lastRender: render,
  };
}

const mode: AttachMessage = { type: "notice", method: "setMode", args: ["step"] };
const busy: AttachMessage = { type: "notice", method: "setBusy", args: [[]] };

function sendsTo(effects: Effect[], party: number): unknown[] {
  return effects
    .filter((effect) => effect.type === "send" && effect.to === party)
    .map((effect) => (effect as { message: unknown }).message);
}

function kinds(effects: Effect[]): string[] {
  return effects.map((effect) => effect.type);
}

describe("joining", () => {
  it("the first terminal is sent hello and nothing else, and the session remembers since when", () => {
    const { state, effects } = step(withHello(), {
      type: "connect",
      party: 1,
      kind: "terminal",
      now: NOW,
    });
    expect(sendsTo(effects, 1)).toEqual([hello]);
    expect(kinds(effects)).toEqual(["send"]);
    expect(state.terminal).toBe(1);
    expect(state.attachedSince).toBe(NOW);
  });

  it("the first CLI visit opens the hold and clears any lease", () => {
    const { state, effects } = step(withHello(), {
      type: "connect",
      party: 1,
      kind: "cli",
      now: NOW,
    });
    expect(kinds(effects)).toEqual(["clearLease", "send"]);
    expect(state.cli).toEqual({ visit: 1, lastVisit: null });
  });

  it("a party joining at a stop is sent hello, the recent lines, the render, then the request", () => {
    const held = { ...heldAtStop(), recent: ["Program stopped", "cli: step"] };
    const { effects } = step(held, { type: "connect", party: 2, kind: "cli", now: NOW + 5 });
    expect(sendsTo(effects, 2)).toEqual([
      hello,
      { type: "notice", method: "log", args: ["Program stopped"] },
      { type: "notice", method: "log", args: ["cli: step"] },
      render,
      ask,
    ]);
  });

  it("a request that is the render itself is sent once", () => {
    const held = { ...heldAtStop(), pending: [render] };
    const { effects } = step(held, { type: "connect", party: 2, kind: "cli", now: NOW });
    expect(sendsTo(effects, 2)).toEqual([hello, render]);
  });

  it("every request waiting is sent, after the stop", () => {
    const panel: RequestMessage = {
      type: "request",
      id: 9,
      method: "showCheckpointsPanel",
      args: [[]],
    };
    const held = { ...heldAtStop(), pending: [ask, panel] };
    const { effects } = step(held, { type: "connect", party: 2, kind: "cli", now: NOW });
    expect(sendsTo(effects, 2)).toEqual([hello, render, ask, panel]);
  });

  it("with nothing pending the program is running: the last stop is not shown", () => {
    const running = { ...heldAtStop(), pending: [] };
    const { effects } = step(running, { type: "connect", party: 2, kind: "cli", now: NOW });
    expect(sendsTo(effects, 2)).toEqual([hello]);
  });

  it("the settings and the spinner as they stand come right after hello", () => {
    const busyRun = {
      ...heldAtStop(),
      pending: [],
      settings: { setMode: mode, setBusy: busy },
      spinning: true,
    } as SessionState;
    const { effects } = step(busyRun, { type: "connect", party: 2, kind: "terminal", now: NOW });
    expect(sendsTo(effects, 2)).toEqual([
      hello,
      mode,
      busy,
      { type: "notice", method: "startSpinner", args: [] },
    ]);
  });

  it("a later visit keeps the hold's last visit time until it closes", () => {
    const { state } = step(heldAtStop(), { type: "connect", party: 2, kind: "cli", now: NOW + 5 });
    expect(state.cli).toEqual({ visit: 2, lastVisit: NOW });
    expect(state.attachedSince).toBe(NOW);
  });

  it("a probe is sent the status and closed, and nothing changes", () => {
    const held = heldAtStop();
    const { state, effects } = step(held, { type: "connect", party: 9, kind: "probe", now: NOW });
    expect(effects).toEqual([
      {
        type: "send",
        to: 9,
        message: {
          type: "status",
          terminal: false,
          cli: { visiting: false, lastVisit: NOW },
          stopped: true,
          finished: false,
        },
      },
      { type: "close", party: 9 },
    ]);
    expect(state).toBe(held);
  });

  it("the status of an empty session says nobody is on it", () => {
    expect(statusOf(emptySession())).toEqual({
      type: "status",
      terminal: false,
      cli: null,
      stopped: false,
      finished: false,
    });
  });

  it("a party joining after the program ended is sent hello and finished, closed, and the session ends", () => {
    const after = { ...heldAtStop(), pending: [], finished } as SessionState;
    const { effects } = step(after, { type: "connect", party: 2, kind: "cli", now: NOW });
    expect(effects).toEqual([
      { type: "send", to: 2, message: hello },
      { type: "send", to: 2, message: finished },
      { type: "close", party: 2 },
      { type: "end" },
    ]);
  });

  it("the program's end outranks a refusal: a terminal after it, while the hold lasts, is told", () => {
    const after = { ...heldAtStop(), pending: [], finished } as SessionState;
    const { effects } = step(after, { type: "connect", party: 2, kind: "terminal", now: NOW });
    expect(sendsTo(effects, 2)).toEqual([hello, finished]);
    expect(kinds(effects)).toContain("end");
  });
});

describe("refusing", () => {
  it("a second terminal, naming the first", () => {
    const { state, effects } = step(terminalAtStop(), {
      type: "connect",
      party: 2,
      kind: "terminal",
      now: NOW,
    });
    expect(sendsTo(effects, 2)).toEqual([
      {
        type: "refused",
        reason: expect.stringMatching(/^already attached since .*, by a terminal debugger$/),
      },
    ]);
    expect(kinds(effects)).toEqual(["send", "close"]);
    expect(state.terminal).toBe(1);
  });

  it("a CLI visit while a terminal is attached", () => {
    const { effects } = step(terminalAtStop(), {
      type: "connect",
      party: 2,
      kind: "cli",
      now: NOW,
    });
    expect(sendsTo(effects, 2)).toEqual([
      { type: "refused", reason: expect.stringMatching(/by a terminal debugger$/) },
    ]);
  });

  it("a terminal while the CLI holds the session", () => {
    const { effects } = step(heldAtStop(), {
      type: "connect",
      party: 2,
      kind: "terminal",
      now: NOW,
    });
    expect(sendsTo(effects, 2)).toEqual([
      { type: "refused", reason: expect.stringMatching(/by agency debug session$/) },
    ]);
  });

  it("a second CLI visit during one", () => {
    const visiting = { ...heldAtStop(), cli: { visit: 2, lastVisit: NOW } };
    const { effects } = step(visiting, { type: "connect", party: 3, kind: "cli", now: NOW });
    expect(sendsTo(effects, 3)).toEqual([
      { type: "refused", reason: "another visit is in progress" },
    ]);
  });
});

describe("the driver's messages", () => {
  it("hello is kept for the parties to come", () => {
    const { state, effects } = step(emptySession(), { type: "fromDriver", message: hello });
    expect(effects).toEqual([]);
    expect(state.hello).toEqual(hello);
  });

  it("a request goes to the connected party and joins the pending ones; a render is also the last render", () => {
    const { state, effects } = step(terminalAtStop(), { type: "fromDriver", message: render });
    expect(effects).toEqual([{ type: "send", to: 1, message: render }]);
    expect(state.pending).toEqual([ask, render]);
    expect(state.lastRender).toBe(render);
  });

  it("a render without a checkpoint is the same stop redrawn: it keeps the checkpoint before it", () => {
    const redraw: RequestMessage = { type: "request", id: 12, method: "render", args: [] };
    const { state, effects } = step(terminalAtStop(), { type: "fromDriver", message: redraw });
    expect(effects).toEqual([{ type: "send", to: 1, message: redraw }]);
    expect(state.lastRender).toEqual({ ...redraw, args: [{ id: 1 }, { line: 4 }, undefined] });
  });

  it("a request with no party connected is kept and sent to no one", () => {
    const { state, effects } = step(
      { ...heldAtStop(), pending: [] },
      { type: "fromDriver", message: ask },
    );
    expect(effects).toEqual([]);
    expect(state.pending).toEqual([ask]);
  });

  it("a log notice is sent on and kept, the last twenty", () => {
    const full = { ...terminalAtStop(), recent: Array.from({ length: 20 }, (_, i) => `line ${i}`) };
    const notice: AttachMessage = { type: "notice", method: "log", args: ["line 20"] };
    const { state, effects } = step(full, { type: "fromDriver", message: notice });
    expect(effects).toEqual([{ type: "send", to: 1, message: notice }]);
    expect(state.recent).toHaveLength(20);
    expect(state.recent[0]).toBe("line 1");
    expect(state.recent[19]).toBe("line 20");
  });

  it("a setting is sent on and the latest one kept by method", () => {
    const later: AttachMessage = { type: "notice", method: "setMode", args: ["continue"] };
    const first = step(terminalAtStop(), { type: "fromDriver", message: mode });
    const { state, effects } = step(first.state, { type: "fromDriver", message: later });
    expect(effects).toEqual([{ type: "send", to: 1, message: later }]);
    expect(state.settings).toEqual({ setMode: later });
    expect(state.recent).toEqual([]);
  });

  it("the spinner notices are sent on and remembered as on or off", () => {
    const on: AttachMessage = { type: "notice", method: "startSpinner", args: [] };
    const off: AttachMessage = { type: "notice", method: "stopSpinner", args: [] };
    const started = step(terminalAtStop(), { type: "fromDriver", message: on });
    expect(started.state.spinning).toBe(true);
    expect(step(started.state, { type: "fromDriver", message: off }).state.spinning).toBe(false);
  });

  it("another notice is sent on and not kept", () => {
    const notice: AttachMessage = { type: "notice", method: "appendStdout", args: ["hi"] };
    const { state, effects } = step(terminalAtStop(), { type: "fromDriver", message: notice });
    expect(effects).toEqual([{ type: "send", to: 1, message: notice }]);
    expect(state).toEqual({ ...terminalAtStop() });
  });

  it("finished goes to the connected party and ends the session", () => {
    const { effects } = step(terminalAtStop(), { type: "fromDriver", message: finished });
    expect(effects).toEqual([{ type: "send", to: 1, message: finished }, { type: "end" }]);
  });

  it("finished with no party connected is kept for the next visit, and the process is let go", () => {
    const { state, effects } = step(heldAtStop(), { type: "fromDriver", message: finished });
    expect(effects).toEqual([{ type: "release" }]);
    expect(state.finished).toEqual(finished);
    expect(state.pending).toEqual([]);
    expect(statusOf(state)).toMatchObject({ stopped: false, finished: true });
  });
});

describe("a party's messages", () => {
  it("the reply to the pending request reaches the driver and clears it", () => {
    const reply: AttachMessage = { type: "reply", id: 8, result: { type: "step" } };
    const { state, effects } = step(terminalAtStop(), {
      type: "fromParty",
      party: 1,
      message: reply,
    });
    expect(effects).toEqual([{ type: "toDriver", message: reply }]);
    expect(state.pending).toEqual([]);
  });

  it("with two requests in flight, each reply answers its own", () => {
    const both = { ...terminalAtStop(), pending: [render, ask] };
    const ack: AttachMessage = { type: "reply", id: 7, result: undefined };
    const first = step(both, { type: "fromParty", party: 1, message: ack });
    expect(first.effects).toEqual([{ type: "toDriver", message: ack }]);
    expect(first.state.pending).toEqual([ask]);
    const command: AttachMessage = { type: "reply", id: 8, result: { type: "step" } };
    const second = step(first.state, { type: "fromParty", party: 1, message: command });
    expect(second.effects).toEqual([{ type: "toDriver", message: command }]);
    expect(second.state.pending).toEqual([]);
  });

  it("a reply to a request that is not pending is dropped", () => {
    const reply: AttachMessage = { type: "reply", id: 3, result: { type: "step" } };
    const { state, effects } = step(terminalAtStop(), {
      type: "fromParty",
      party: 1,
      message: reply,
    });
    expect(effects).toEqual([]);
    expect(state.pending).toEqual([ask]);
  });

  it("a message from a party that is not on the session is dropped", () => {
    const reply: AttachMessage = { type: "reply", id: 8, result: { type: "step" } };
    const { effects } = step(terminalAtStop(), { type: "fromParty", party: 5, message: reply });
    expect(effects).toEqual([]);
  });

  it("pause reaches the driver", () => {
    const pause: AttachMessage = { type: "pause" };
    const { effects } = step(terminalAtStop(), { type: "fromParty", party: 1, message: pause });
    expect(effects).toEqual([{ type: "toDriver", message: pause }]);
  });

  it("a client message after joining is ignored", () => {
    const client: AttachMessage = { type: "client", kind: "terminal" };
    const { effects } = step(terminalAtStop(), { type: "fromParty", party: 1, message: client });
    expect(effects).toEqual([]);
  });
});

describe("leaving", () => {
  it("a terminal closing ends the session", () => {
    const { state, effects } = step(terminalAtStop(), { type: "disconnect", party: 1, now: NOW });
    expect(effects).toEqual([{ type: "end" }]);
    expect(state.terminal).toBeNull();
  });

  it("a visit closing starts the lease and leaves the request pending", () => {
    const visiting = { ...heldAtStop(), cli: { visit: 2, lastVisit: NOW } };
    const { state, effects } = step(visiting, { type: "disconnect", party: 2, now: NOW + 9 });
    expect(effects).toEqual([{ type: "startLease" }]);
    expect(state.cli).toEqual({ visit: null, lastVisit: NOW + 9 });
    expect(state.pending).toEqual([ask]);
  });

  it("a refused party closing changes nothing", () => {
    const held = heldAtStop();
    const { state, effects } = step(held, { type: "disconnect", party: 9, now: NOW });
    expect(effects).toEqual([]);
    expect(state).toBe(held);
  });

  it("the lease running out with no one else on the session logs a line and ends it", () => {
    const { state, effects } = step(heldAtStop(), { type: "leaseExpired" });
    expect(effects).toEqual([
      { type: "log", line: `[agency debug] no visit for ${LEASE_MS / 60_000} minutes; detaching` },
      { type: "end" },
    ]);
    expect(state.cli).toBeNull();
  });

  it("the lease firing while a visit is connected does nothing", () => {
    const visiting = { ...heldAtStop(), cli: { visit: 2, lastVisit: NOW } };
    const { state, effects } = step(visiting, { type: "leaseExpired" });
    expect(effects).toEqual([]);
    expect(state).toBe(visiting);
  });
});
