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

const parties = (terminal: boolean, cli: boolean): AttachMessage => ({
  type: "parties",
  terminal,
  cli,
});
const mode: AttachMessage = { type: "notice", method: "setMode", args: ["step"] };
const busy: AttachMessage = { type: "notice", method: "setBusy", args: [[]] };
const ack: AttachMessage = { type: "reply", id: 7, result: undefined };

function sendsTo(effects: Effect[], party: number): unknown[] {
  return effects
    .filter((effect) => effect.type === "send" && effect.to === party)
    .map((effect) => (effect as { message: unknown }).message);
}

function kinds(effects: Effect[]): string[] {
  return effects.map((effect) => effect.type);
}

describe("joining", () => {
  it("the first terminal is sent hello and who is on the run, and the session remembers since when", () => {
    const { state, effects } = step(withHello(), {
      type: "connect",
      party: 1,
      kind: "terminal",
      now: NOW,
    });
    expect(sendsTo(effects, 1)).toEqual([hello, { type: "parties", terminal: true, cli: false }]);
    expect(kinds(effects)).toEqual(["send", "send"]);
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
    expect(kinds(effects)).toEqual(["clearLease", "send", "send"]);
    expect(state.cli).toEqual({ visit: 1, lastVisit: null });
  });

  it("a party joining at a stop is sent hello, the recent lines, then the stop; the request waits for its acknowledgement", () => {
    const held = { ...heldAtStop(), recent: ["Program stopped", "cli: step"] };
    const joined = step(held, { type: "connect", party: 2, kind: "cli", now: NOW + 5 });
    expect(sendsTo(joined.effects, 2)).toEqual([
      hello,
      parties(false, true),
      { type: "notice", method: "log", args: ["Program stopped"] },
      { type: "notice", method: "log", args: ["cli: step"] },
      render,
    ]);
    expect(joined.state.drawing).toEqual([2]);
    const drawn = step(joined.state, { type: "fromParty", party: 2, message: ack });
    expect(drawn.effects).toEqual([{ type: "send", to: 2, message: ask }]);
    expect(drawn.state.drawing).toEqual([]);
    expect(drawn.state.pending).toEqual([ask]);
  });

  it("a request arriving while a joiner still draws the stop reaches it once it has", () => {
    const joined = step(heldAtStop(), { type: "connect", party: 2, kind: "cli", now: NOW });
    const panel: RequestMessage = {
      type: "request",
      id: 9,
      method: "showCheckpointsPanel",
      args: [[]],
    };
    const asked = step(joined.state, { type: "fromDriver", message: panel });
    expect(asked.effects).toEqual([]);
    const drawn = step(asked.state, { type: "fromParty", party: 2, message: ack });
    expect(sendsTo(drawn.effects, 2)).toEqual([ask, panel]);
  });

  it("a joiner during a render still pending is one more party it waits for", () => {
    const mid = { ...terminalAtStop(), pending: [render], awaiting: { 7: [1] } };
    const joined = step(mid, { type: "connect", party: 2, kind: "cli", now: NOW });
    expect(sendsTo(joined.effects, 2)).toEqual([hello, parties(true, true), render]);
    expect(joined.state.awaiting).toEqual({ 7: [1, 2] });
    const first = step(joined.state, { type: "fromParty", party: 1, message: ack });
    expect(first.effects).toEqual([]);
    const second = step(first.state, { type: "fromParty", party: 2, message: ack });
    expect(second.effects).toEqual([{ type: "toDriver", message: ack }]);
    expect(second.state.pending).toEqual([]);
    expect(second.state.drawing).toEqual([]);
  });

  it("with nothing pending the program is running: the last stop is not shown", () => {
    const running = { ...heldAtStop(), pending: [] };
    const { state, effects } = step(running, { type: "connect", party: 2, kind: "cli", now: NOW });
    expect(sendsTo(effects, 2)).toEqual([hello, parties(false, true)]);
    expect(state.drawing).toEqual([]);
  });

  it("the settings and the spinner as they stand come right after who is on the run", () => {
    const busyRun = {
      ...heldAtStop(),
      pending: [],
      settings: { setMode: mode, setBusy: busy },
      spinning: true,
    } as SessionState;
    const { effects } = step(busyRun, { type: "connect", party: 2, kind: "terminal", now: NOW });
    expect(sendsTo(effects, 2)).toEqual([
      hello,
      parties(true, true),
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

  it("the program's end outranks a refusal: a second terminal after it is told", () => {
    const after = { ...terminalAtStop(), pending: [], finished } as SessionState;
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

  it("a CLI visit while a terminal is attached joins, and both are told who is on the run", () => {
    const { state, effects } = step(terminalAtStop(), {
      type: "connect",
      party: 2,
      kind: "cli",
      now: NOW,
    });
    const both = parties(true, true);
    expect(sendsTo(effects, 2)).toEqual([hello, both, render]);
    expect(sendsTo(effects, 1)).toEqual([both]);
    expect(state.terminal).toBe(1);
    expect(state.cli).toEqual({ visit: 2, lastVisit: null });
  });

  it("a terminal while the CLI holds the session joins and sees the stop", () => {
    const { state, effects } = step(heldAtStop(), {
      type: "connect",
      party: 2,
      kind: "terminal",
      now: NOW,
    });
    expect(sendsTo(effects, 2)).toEqual([hello, parties(true, true), render]);
    expect(state.terminal).toBe(2);
    expect(state.cli).toEqual({ visit: null, lastVisit: NOW });
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

  it("a request goes to every connected party and joins the pending ones; a render is also the last render, waited on from each", () => {
    const both = { ...terminalAtStop(), cli: { visit: 2, lastVisit: null } };
    const { state, effects } = step(both, { type: "fromDriver", message: render });
    expect(effects).toEqual([
      { type: "send", to: 1, message: render },
      { type: "send", to: 2, message: render },
    ]);
    expect(state.pending).toEqual([ask, render]);
    expect(state.lastRender).toBe(render);
    expect(state.awaiting).toEqual({ 7: [1, 2] });
  });

  it("a render without a checkpoint is the same stop redrawn: it keeps the checkpoint before it", () => {
    const redraw: RequestMessage = { type: "request", id: 12, method: "render", args: [] };
    const { state, effects } = step(terminalAtStop(), { type: "fromDriver", message: redraw });
    expect(effects).toEqual([{ type: "send", to: 1, message: redraw }]);
    expect(state.lastRender).toEqual({ ...redraw, args: [{ id: 1 }, { line: 4 }, undefined] });
  });

  it("a request with no party connected is kept and sent to no one", () => {
    const running = { ...heldAtStop(), pending: [] };
    const { state, effects } = step(running, { type: "fromDriver", message: ask });
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
    expect(state).toEqual(terminalAtStop());
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
  it("the reply to the pending request reaches the driver, clears it, and is logged as the party's", () => {
    const reply: AttachMessage = { type: "reply", id: 8, result: { type: "step" } };
    const { state, effects } = step(terminalAtStop(), {
      type: "fromParty",
      party: 1,
      message: reply,
    });
    expect(effects).toEqual([
      { type: "toDriver", message: reply },
      { type: "send", to: 1, message: { type: "notice", method: "log", args: ["terminal: step"] } },
    ]);
    expect(state.pending).toEqual([]);
    expect(state.recent).toEqual(["terminal: step"]);
    expect(state.answered).toEqual([{ id: 8, by: "terminal", command: "step" }]);
  });

  it("with two parties, the first reply wins and the other is told who answered and how", () => {
    const both = { ...terminalAtStop(), cli: { visit: 2, lastVisit: null } };
    const reply: AttachMessage = {
      type: "reply",
      id: 8,
      result: { type: "set", varName: "x", value: 5 },
    };
    const { state, effects } = step(both, { type: "fromParty", party: 2, message: reply });
    const line = { type: "notice", method: "log", args: ["cli: set x = 5"] };
    expect(effects).toEqual([
      { type: "toDriver", message: reply },
      { type: "send", to: 1, message: line },
      { type: "send", to: 2, message: line },
      {
        type: "send",
        to: 1,
        message: { type: "answered", id: 8, by: "cli", command: "set x = 5" },
      },
    ]);
    expect(state.pending).toEqual([]);
  });

  it("with two requests in flight, each reply answers its own", () => {
    const both = { ...terminalAtStop(), pending: [render, ask], awaiting: { 7: [1] } };
    const first = step(both, { type: "fromParty", party: 1, message: ack });
    expect(first.effects).toEqual([{ type: "toDriver", message: ack }]);
    expect(first.state.pending).toEqual([ask]);
    const command: AttachMessage = { type: "reply", id: 8, result: { type: "step" } };
    const second = step(first.state, { type: "fromParty", party: 1, message: command });
    expect(second.effects[0]).toEqual({ type: "toDriver", message: command });
    expect(second.state.pending).toEqual([]);
  });

  it("a reply carrying the party's error drops that party; the request stays for the rest", () => {
    const both = { ...terminalAtStop(), cli: { visit: 2, lastVisit: null } };
    const failed: AttachMessage = { type: "reply", id: 8, error: "the picker threw" };
    const { state, effects } = step(both, { type: "fromParty", party: 2, message: failed });
    expect(effects).toEqual([
      {
        type: "log",
        line: "[agency debug] the cli failed to answer waitForCommand: the picker threw; dropping it",
      },
      { type: "close", party: 2 },
      { type: "startLease" },
      { type: "send", to: 1, message: parties(true, true) },
    ]);
    expect(state.cli).toEqual({ visit: null, lastVisit: null });
    expect(state.pending).toEqual([ask]);
  });

  it("an answer of the wrong shape drops the party the same way; alone, that ends the session", () => {
    const wrong: AttachMessage = { type: "reply", id: 8, result: { nonsense: true } };
    const { state, effects } = step(terminalAtStop(), {
      type: "fromParty",
      party: 1,
      message: wrong,
    });
    expect(kinds(effects)).toEqual(["log", "close", "end"]);
    expect(state.terminal).toBeNull();
  });

  it("a failed render is not an acknowledgement: the party is dropped and the render waits on the rest", () => {
    const both = {
      ...terminalAtStop(),
      cli: { visit: 2, lastVisit: null },
      pending: [render],
      awaiting: { 7: [1, 2] },
    };
    const failed: AttachMessage = { type: "reply", id: 7, error: "no source map" };
    const { state, effects } = step(both, { type: "fromParty", party: 1, message: failed });
    expect(kinds(effects)).toEqual(["log", "close", "send"]);
    expect(state.terminal).toBeNull();
    expect(state.awaiting).toEqual({ 7: [2] });
    expect(state.pending).toEqual([render]);
  });

  it("a late reply to a request another party answered is told so", () => {
    const answered = {
      ...terminalAtStop(),
      cli: { visit: 2, lastVisit: null },
      pending: [],
      answered: [{ id: 8, by: "cli" as const, command: "step" }],
    };
    const reply: AttachMessage = { type: "reply", id: 8, result: { type: "continue" } };
    const { state, effects } = step(answered, { type: "fromParty", party: 1, message: reply });
    expect(effects).toEqual([
      { type: "send", to: 1, message: { type: "answered", id: 8, by: "cli", command: "step" } },
    ]);
    expect(state).toBe(answered);
  });

  it("a render waits for every party it went to, then the driver gets one acknowledgement", () => {
    const both = {
      ...terminalAtStop(),
      cli: { visit: 2, lastVisit: null },
      pending: [render],
      awaiting: { 7: [1, 2] },
    };
    const first = step(both, { type: "fromParty", party: 2, message: ack });
    expect(first.effects).toEqual([]);
    expect(first.state.awaiting).toEqual({ 7: [1] });
    const second = step(first.state, { type: "fromParty", party: 1, message: ack });
    expect(second.effects).toEqual([
      { type: "toDriver", message: { type: "reply", id: 7, result: undefined } },
    ]);
    expect(second.state.pending).toEqual([]);
    expect(second.state.awaiting).toEqual({});
  });

  it("a party leaving mid-render is no longer waited on", () => {
    const both = {
      ...terminalAtStop(),
      cli: { visit: 2, lastVisit: null },
      pending: [render],
      awaiting: { 7: [1, 2] },
    };
    const acked = step(both, { type: "fromParty", party: 1, message: ack });
    const { state, effects } = step(acked.state, { type: "disconnect", party: 2, now: NOW });
    expect(effects).toEqual([
      { type: "startLease" },
      { type: "toDriver", message: { type: "reply", id: 7, result: undefined } },
      { type: "send", to: 1, message: parties(true, true) },
    ]);
    expect(state.pending).toEqual([]);
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
  it("a terminal closing with no CLI hold ends the session", () => {
    const { state, effects } = step(terminalAtStop(), { type: "disconnect", party: 1, now: NOW });
    expect(effects).toEqual([{ type: "end" }]);
    expect(state.terminal).toBeNull();
  });

  it("a terminal closing while the CLI holds the session ends nothing", () => {
    const both = { ...terminalAtStop(), cli: { visit: null, lastVisit: NOW } };
    const { state, effects } = step(both, { type: "disconnect", party: 1, now: NOW });
    expect(effects).toEqual([]);
    expect(state.terminal).toBeNull();
    expect(state.pending).toEqual([ask]);
  });

  it("a visit closing while a terminal is attached tells the terminal", () => {
    const both = { ...terminalAtStop(), cli: { visit: 2, lastVisit: null } };
    const { effects } = step(both, { type: "disconnect", party: 2, now: NOW + 9 });
    expect(effects).toEqual([
      { type: "startLease" },
      { type: "send", to: 1, message: { type: "parties", terminal: true, cli: true } },
    ]);
  });

  it("the lease running out with a terminal attached releases the hold and tells the terminal", () => {
    const both = { ...terminalAtStop(), cli: { visit: null, lastVisit: NOW } };
    const { state, effects } = step(both, { type: "leaseExpired" });
    expect(effects).toEqual([
      {
        type: "log",
        line: `[agency debug] no visit for ${LEASE_MS / 60_000} minutes; released the CLI's hold`,
      },
      { type: "send", to: 1, message: { type: "parties", terminal: true, cli: false } },
    ]);
    expect(state.cli).toBeNull();
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
