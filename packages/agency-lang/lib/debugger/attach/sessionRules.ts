// The rules of a debug session on a running program, as one pure
// function: a state and an event in, the new state and the effects out.
// Who may join, who is refused, what a joining party is sent, which
// reply answers which of the driver's requests, when the lease fires,
// and when the session ends are all rows of `step`, and the test for
// this file is a table of them. Nothing here touches a socket, a timer,
// or a promise; `sessionChannel.ts` applies the effects.
//
// The one idea: the run holds the session, and a connection is a party on
// it. A terminal debugger's connection is its session, as before. A CLI
// visit connects, is shown where the program is, answers or reads, and
// disconnects, and the session stays, with the driver's requests pending,
// until the next visit or the lease.
import type {
  AttachMessage,
  ClientKind,
  FinishedMessage,
  Hello,
  NoticeMessage,
  RequestMessage,
  StatusMessage,
} from "./protocol.js";

/** A number the adapter gives each connection. */
export type PartyId = number;

/** The CLI's hold on the session: the visit connected now, if any, and
 *  when the last one closed. */
export type CliHold = {
  visit: PartyId | null;
  lastVisit: number | null;
};

export type SessionState = {
  /** The run's `hello`, sent to every party as it joins. */
  hello: Hello | null;
  /** When the first party joined, for the refusal a later one gets. */
  attachedSince: number | null;
  terminal: PartyId | null;
  cli: CliHold | null;
  /** The driver's requests no party has answered, oldest first. The
   *  driver has more than one in flight at a time: its callbacks redraw
   *  without waiting, so two renders can be out before the first is
   *  acknowledged. */
  pending: RequestMessage[];
  /** The last `render`, so a joining party sees the stop. A render the
   *  driver sends without a checkpoint means "the same stop, redrawn",
   *  so the checkpoint of the render before is carried into it. */
  lastRender: RequestMessage | null;
  /** The notices whose latest value is the whole truth (`setMode`,
   *  `setOverrides`, `setBusy`), by method, replayed to a joiner. */
  settings: Record<string, NoticeMessage>;
  /** Whether the driver's spinner is on: the program is running under
   *  the debugger, and a joining terminal starts its own. */
  spinning: boolean;
  /** The last activity lines, so a visit sees what happened since. */
  recent: string[];
  /** The program's end, kept for a visit that comes after it. */
  finished: FinishedMessage | null;
};

export function emptySession(): SessionState {
  return {
    hello: null,
    attachedSince: null,
    terminal: null,
    cli: null,
    pending: [],
    lastRender: null,
    settings: {},
    spinning: false,
    recent: [],
    finished: null,
  };
}

export type SessionEvent =
  | { type: "connect"; party: PartyId; kind: ClientKind; now: number }
  | { type: "disconnect"; party: PartyId; now: number }
  | { type: "fromDriver"; message: AttachMessage }
  | { type: "fromParty"; party: PartyId; message: AttachMessage }
  | { type: "leaseExpired" };

export type Effect =
  | { type: "send"; to: PartyId; message: AttachMessage }
  | { type: "close"; party: PartyId }
  | { type: "toDriver"; message: AttachMessage }
  | { type: "startLease" }
  | { type: "clearLease" }
  | { type: "log"; line: string }
  /** The program has ended with no party to tell: nothing waits on a
   *  debugger now, so the session must stop keeping the process alive
   *  while it holds the news for the next visit. */
  | { type: "release" }
  | { type: "end" };

export type Stepped = { state: SessionState; effects: Effect[] };

/** How long the CLI's hold outlives its last visit. A program must never
 *  wait on a debugger that is not there, and an agent can crash or
 *  forget. */
export const LEASE_MS = 10 * 60 * 1000;
export const RECENT_LINES = 20;

/** The notices a joiner is sent the latest of. */
const SETTING_METHODS = ["setMode", "setOverrides", "setBusy"];

export function step(state: SessionState, event: SessionEvent): Stepped {
  switch (event.type) {
    case "connect":
      return connect(state, event.party, event.kind, event.now);
    case "disconnect":
      return disconnect(state, event.party, event.now);
    case "fromDriver":
      return fromDriver(state, event.message);
    case "fromParty":
      return fromParty(state, event.party, event.message);
    case "leaseExpired":
      return leaseExpired(state);
  }
}

/** What a probe is told, and what the server tells one when no session
 *  is open. */
export function statusOf(state: SessionState): StatusMessage {
  const cli =
    state.cli === null
      ? null
      : { visiting: state.cli.visit !== null, lastVisit: state.cli.lastVisit };
  return {
    type: "status",
    terminal: state.terminal !== null,
    cli,
    stopped: state.pending.length > 0,
    finished: state.finished !== null,
  };
}

/** The parties a message from the driver goes to. */
function connected(state: SessionState): PartyId[] {
  const parties = [state.terminal, state.cli?.visit ?? null];
  return parties.filter((party): party is PartyId => party !== null);
}

function sendTo(parties: PartyId[], message: AttachMessage): Effect[] {
  return parties.map((to) => ({ type: "send", to, message }));
}

function sinceText(state: SessionState, now: number): string {
  return new Date(state.attachedSince ?? now).toLocaleTimeString();
}

function refuse(party: PartyId, reason: string): Effect[] {
  return [
    { type: "send", to: party, message: { type: "refused", reason } },
    { type: "close", party },
  ];
}

function connect(state: SessionState, party: PartyId, kind: ClientKind, now: number): Stepped {
  if (kind === "probe") {
    return {
      state,
      effects: [
        { type: "send", to: party, message: statusOf(state) },
        { type: "close", party },
      ],
    };
  }
  // The program's end comes before any refusal: the driver is off the
  // program already, so nothing is attached in the way that matters, and
  // the party that learns it ends the session for the next one.
  if (state.finished !== null) {
    const hello: Effect[] = state.hello === null ? [] : sendTo([party], state.hello);
    return {
      state,
      effects: [
        ...hello,
        { type: "send", to: party, message: state.finished },
        { type: "close", party },
        { type: "end" },
      ],
    };
  }
  if (state.terminal !== null) {
    return {
      state,
      effects: refuse(
        party,
        `already attached since ${sinceText(state, now)}, by a terminal debugger`,
      ),
    };
  }
  if (kind === "terminal" && state.cli !== null) {
    return {
      state,
      effects: refuse(
        party,
        `already attached since ${sinceText(state, now)}, by agency debug session`,
      ),
    };
  }
  if (kind === "cli" && state.cli?.visit != null) {
    return { state, effects: refuse(party, "another visit is in progress") };
  }
  const joined: SessionState =
    kind === "terminal"
      ? { ...state, terminal: party }
      : { ...state, cli: { visit: party, lastVisit: state.cli?.lastVisit ?? null } };
  const lease: Effect[] = kind === "cli" ? [{ type: "clearLease" }] : [];
  return {
    state: { ...joined, attachedSince: state.attachedSince ?? now },
    effects: [...lease, ...shown(joined, party)],
  };
}

/** What a party is sent as it joins: the run's hello, the settings and
 *  the spinner as they stand, the recent activity, then, when the driver
 *  is waiting on an answer, the stop and every request waiting. With
 *  nothing pending the program is running, and the last stop is not
 *  shown: it is where the program was, not where it is. */
function shown(state: SessionState, party: PartyId): Effect[] {
  const hello: AttachMessage[] = state.hello === null ? [] : [state.hello];
  const settings = Object.values(state.settings);
  const spinner: AttachMessage[] = state.spinning
    ? [{ type: "notice", method: "startSpinner", args: [] }]
    : [];
  const recent: AttachMessage[] = state.recent.map((line) => ({
    type: "notice",
    method: "log",
    args: [line],
  }));
  const stopped = state.pending.length > 0;
  const render: AttachMessage[] = stopped && state.lastRender !== null ? [state.lastRender] : [];
  const pending = state.pending.filter((request) => request !== state.lastRender);
  return [...hello, ...settings, ...spinner, ...recent, ...render, ...pending].map((message) => ({
    type: "send",
    to: party,
    message,
  }));
}

function disconnect(state: SessionState, party: PartyId, now: number): Stepped {
  if (party === state.terminal) {
    const left = { ...state, terminal: null };
    return { state: left, effects: left.cli === null ? [{ type: "end" }] : [] };
  }
  if (state.cli !== null && party === state.cli.visit) {
    return {
      state: { ...state, cli: { visit: null, lastVisit: now } },
      effects: [{ type: "startLease" }],
    };
  }
  return { state, effects: [] };
}

/** `message` as the last render: with its own checkpoint, as it is; with
 *  none, the stop redrawn, so the checkpoint and location of the render
 *  before are kept under the new id. */
function asLastRender(state: SessionState, message: RequestMessage): RequestMessage {
  const before = state.lastRender;
  if (message.args[0] != null || before === null) {
    return message;
  }
  return { ...message, args: [before.args[0], message.args[1] ?? before.args[1], message.args[2]] };
}

function fromDriver(state: SessionState, message: AttachMessage): Stepped {
  switch (message.type) {
    case "hello":
      return { state: { ...state, hello: message }, effects: [] };
    case "request": {
      const isRender = message.method === "render";
      const kept = isRender ? asLastRender(state, message) : message;
      return {
        state: {
          ...state,
          pending: [...state.pending, kept],
          lastRender: isRender ? kept : state.lastRender,
        },
        effects: sendTo(connected(state), message),
      };
    }
    case "notice":
      return { state: noted(state, message), effects: sendTo(connected(state), message) };
    case "finished": {
      const parties = connected(state);
      if (parties.length === 0) {
        return {
          state: { ...state, finished: message, pending: [] },
          effects: [{ type: "release" }],
        };
      }
      return { state, effects: [...sendTo(parties, message), { type: "end" }] };
    }
    default:
      return { state, effects: [] };
  }
}

/** The state after a notice: a log line joins the recent lines, a
 *  setting replaces the one before it, the spinner turns on or off. */
function noted(state: SessionState, notice: NoticeMessage): SessionState {
  switch (notice.method) {
    case "log":
      return {
        ...state,
        recent: [...state.recent, String(notice.args[0])].slice(-RECENT_LINES),
      };
    case "startSpinner":
      return { ...state, spinning: true };
    case "stopSpinner":
      return { ...state, spinning: false };
    default:
      if (SETTING_METHODS.includes(notice.method)) {
        return { ...state, settings: { ...state.settings, [notice.method]: notice } };
      }
      return state;
  }
}

function fromParty(state: SessionState, party: PartyId, message: AttachMessage): Stepped {
  if (!connected(state).includes(party)) {
    return { state, effects: [] };
  }
  switch (message.type) {
    case "reply": {
      if (!state.pending.some((request) => request.id === message.id)) {
        return { state, effects: [] };
      }
      const pending = state.pending.filter((request) => request.id !== message.id);
      return { state: { ...state, pending }, effects: [{ type: "toDriver", message }] };
    }
    case "pause":
      return { state, effects: [{ type: "toDriver", message }] };
    default:
      return { state, effects: [] };
  }
}

function leaseExpired(state: SessionState): Stepped {
  if (state.cli === null || state.cli.visit !== null) {
    return { state, effects: [] };
  }
  const released = { ...state, cli: null };
  const minutes = Math.round(LEASE_MS / 60_000);
  if (released.terminal === null) {
    return {
      state: released,
      effects: [
        { type: "log", line: `[agency debug] no visit for ${minutes} minutes; detaching` },
        { type: "end" },
      ],
    };
  }
  return {
    state: released,
    effects: [
      {
        type: "log",
        line: `[agency debug] no visit for ${minutes} minutes; released the CLI's hold`,
      },
    ],
  };
}
