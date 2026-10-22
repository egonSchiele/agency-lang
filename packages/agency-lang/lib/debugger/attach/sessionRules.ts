// The rules of a debug session on a running program, as one pure
// function: a state and an event in, the new state and the effects out.
// Who may join, who is refused, what a joining party is sent, which
// reply answers the driver's request, when the lease fires, and when the
// session ends are all rows of `step`, and the test for this file is a
// table of them. Nothing here touches a socket, a timer, or a promise;
// `sessionChannel.ts` applies the effects.
//
// The one idea: the run holds the session, and a connection is a party on
// it. A terminal debugger and a CLI visit can both be on the run at once,
// and either one drives: every request goes to every party, the first
// reply answers it, and the other party is told who answered and with
// what. A reply to a request that is no longer pending is refused, never
// reconciled; there is no merging anywhere here. A terminal's close is
// its detach, as before. A CLI visit connects, is shown where the program
// is, answers or reads, and disconnects, and the CLI's hold on the
// session stays, with the driver's request pending, until the next visit
// or the lease.
import { describeAnswer } from "./describe.js";
import type {
  AttachMessage,
  ClientKind,
  FinishedMessage,
  Hello,
  PartiesMessage,
  PartyKind,
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

/** An answer the session accepted, kept so a late reply to the same
 *  request can be told what happened. */
export type Answered = {
  id: number;
  by: PartyKind;
  command: string;
};

export type SessionState = {
  /** The run's `hello`, sent to every party as it joins. */
  hello: Hello | null;
  /** When the first party joined, for the refusal a later one gets. */
  attachedSince: number | null;
  terminal: PartyId | null;
  cli: CliHold | null;
  /** The driver's request no party has answered. */
  pending: RequestMessage | null;
  /** The parties a pending `render` is still waiting on. */
  awaitingRender: PartyId[];
  /** The last `render`, so a joining party sees the stop. */
  lastRender: RequestMessage | null;
  /** The last activity lines, so a visit sees what happened since. */
  recent: string[];
  /** The last answers, newest last. */
  answered: Answered[];
  /** The program's end, kept for a visit that comes after it. */
  finished: FinishedMessage | null;
};

export function emptySession(): SessionState {
  return {
    hello: null,
    attachedSince: null,
    terminal: null,
    cli: null,
    pending: null,
    awaitingRender: [],
    lastRender: null,
    recent: [],
    answered: [],
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
  | { type: "end" };

export type Stepped = { state: SessionState; effects: Effect[] };

/** How long the CLI's hold outlives its last visit. A program must never
 *  wait on a debugger that is not there, and an agent can crash or
 *  forget. */
export const LEASE_MS = 10 * 60 * 1000;
export const RECENT_LINES = 20;
export const ANSWERED_KEPT = 10;

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
    stopped: state.pending !== null,
  };
}

/** Who is on the run, as every party is told when that changes. */
export function partiesOf(state: SessionState): PartiesMessage {
  return { type: "parties", terminal: state.terminal !== null, cli: state.cli !== null };
}

/** The parties a message from the driver goes to. */
function connected(state: SessionState): PartyId[] {
  const parties = [state.terminal, state.cli?.visit ?? null];
  return parties.filter((party): party is PartyId => party !== null);
}

function kindOf(state: SessionState, party: PartyId): PartyKind {
  return party === state.terminal ? "terminal" : "cli";
}

function sendTo(parties: PartyId[], message: AttachMessage): Effect[] {
  return parties.map((to) => ({ type: "send", to, message }));
}

function logLine(line: string): AttachMessage {
  return { type: "notice", method: "log", args: [line] };
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
  if (kind === "terminal" && state.terminal !== null) {
    return {
      state,
      effects: refuse(
        party,
        `already attached since ${sinceText(state, now)}, by a terminal debugger`,
      ),
    };
  }
  if (kind === "cli" && state.cli?.visit != null) {
    return { state, effects: refuse(party, "another visit is in progress") };
  }
  if (state.finished !== null) {
    return {
      state,
      effects: [
        { type: "send", to: party, message: state.finished },
        { type: "close", party },
        { type: "end" },
      ],
    };
  }
  const joined: SessionState =
    kind === "terminal"
      ? { ...state, terminal: party, attachedSince: state.attachedSince ?? now }
      : {
          ...state,
          cli: { visit: party, lastVisit: state.cli?.lastVisit ?? null },
          attachedSince: state.attachedSince ?? now,
        };
  const lease: Effect[] = kind === "cli" ? [{ type: "clearLease" }] : [];
  const others = connected(joined).filter((other) => other !== party);
  return {
    state: joined,
    effects: [...lease, ...shown(joined, party), ...sendTo(others, partiesOf(joined))],
  };
}

/** What a party is sent as it joins: the run's hello, who else is on
 *  the run, the recent activity, the stop, and the request waiting for
 *  an answer. */
function shown(state: SessionState, party: PartyId): Effect[] {
  const hello: AttachMessage[] = state.hello === null ? [] : [state.hello];
  const recent = state.recent.map(logLine);
  const render: AttachMessage[] = state.lastRender === null ? [] : [state.lastRender];
  const pending: AttachMessage[] =
    state.pending === null || state.pending === state.lastRender ? [] : [state.pending];
  return [...hello, partiesOf(state), ...recent, ...render, ...pending].map((message) => ({
    type: "send",
    to: party,
    message,
  }));
}

/** A party has left: it is waited on for nothing, and the rest are told
 *  who is still on the run. The session ends with the last party. */
function left(state: SessionState, party: PartyId, lease: Effect[]): Stepped {
  const stillAwaited = state.awaitingRender.filter((other) => other !== party);
  const settled = settleRender({ ...state, awaitingRender: stillAwaited });
  const rest = connected(settled.state);
  if (settled.state.terminal === null && settled.state.cli === null) {
    return { state: settled.state, effects: [...settled.effects, { type: "end" }] };
  }
  return {
    state: settled.state,
    effects: [...settled.effects, ...lease, ...sendTo(rest, partiesOf(settled.state))],
  };
}

/** A pending render that no party is still waited on for is done: the
 *  driver gets the one acknowledgement it asked for. */
function settleRender(state: SessionState): Stepped {
  const render = state.pending;
  if (render === null || render.method !== "render" || state.awaitingRender.length > 0) {
    return { state, effects: [] };
  }
  return {
    state: { ...state, pending: null },
    effects: [{ type: "toDriver", message: { type: "reply", id: render.id, result: undefined } }],
  };
}

function disconnect(state: SessionState, party: PartyId, now: number): Stepped {
  if (party === state.terminal) {
    return left({ ...state, terminal: null }, party, []);
  }
  if (state.cli !== null && party === state.cli.visit) {
    return left({ ...state, cli: { visit: null, lastVisit: now } }, party, [
      { type: "startLease" },
    ]);
  }
  return { state, effects: [] };
}

function fromDriver(state: SessionState, message: AttachMessage): Stepped {
  switch (message.type) {
    case "hello":
      return { state: { ...state, hello: message }, effects: [] };
    case "request": {
      const parties = connected(state);
      const isRender = message.method === "render";
      return {
        state: {
          ...state,
          pending: message,
          awaitingRender: isRender ? parties : [],
          lastRender: isRender ? message : state.lastRender,
        },
        effects: sendTo(parties, message),
      };
    }
    case "notice": {
      const line = message.method === "log" ? [String(message.args[0])] : [];
      const recent = [...state.recent, ...line].slice(-RECENT_LINES);
      return { state: { ...state, recent }, effects: sendTo(connected(state), message) };
    }
    case "finished": {
      const parties = connected(state);
      if (parties.length === 0) {
        return { state: { ...state, finished: message }, effects: [] };
      }
      return { state, effects: [...sendTo(parties, message), { type: "end" }] };
    }
    default:
      return { state, effects: [] };
  }
}

function fromParty(state: SessionState, party: PartyId, message: AttachMessage): Stepped {
  if (!connected(state).includes(party)) {
    return { state, effects: [] };
  }
  switch (message.type) {
    case "reply":
      return reply(state, party, message);
    case "pause":
      return { state, effects: [{ type: "toDriver", message }] };
    default:
      return { state, effects: [] };
  }
}

/** A reply from a party. To a pending render, one acknowledgement of
 *  the ones waited on. To any other pending request, the answer: the
 *  driver gets it, every party is told who answered and how, and the
 *  other parties are sent `answered` so a read they are inside stops.
 *  To a request already answered, `answered` again, so a late party is
 *  told; to anything else, nothing. */
function reply(
  state: SessionState,
  party: PartyId,
  message: Extract<AttachMessage, { type: "reply" }>,
): Stepped {
  const pending = state.pending;
  if (pending !== null && message.id === pending.id && pending.method === "render") {
    const awaiting = state.awaitingRender.filter((other) => other !== party);
    return settleRender({ ...state, awaitingRender: awaiting });
  }
  if (pending !== null && message.id === pending.id) {
    const by = kindOf(state, party);
    const answer: Answered = {
      id: message.id,
      by,
      command: describeAnswer(pending.method, message.result),
    };
    const line = `${by}: ${answer.command}`;
    const others = connected(state).filter((other) => other !== party);
    return {
      state: {
        ...state,
        pending: null,
        recent: [...state.recent, line].slice(-RECENT_LINES),
        answered: [...state.answered, answer].slice(-ANSWERED_KEPT),
      },
      effects: [
        { type: "toDriver", message },
        ...sendTo(connected(state), logLine(line)),
        ...sendTo(others, { type: "answered", ...answer }),
      ],
    };
  }
  const earlier = state.answered.find((answer) => answer.id === message.id);
  if (earlier !== undefined) {
    return { state, effects: sendTo([party], { type: "answered", ...earlier }) };
  }
  return { state, effects: [] };
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
      ...sendTo([released.terminal], partiesOf(released)),
    ],
  };
}
