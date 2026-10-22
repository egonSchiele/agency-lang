// The rules of a debug session on a running program, as one pure
// function: a state and an event in, the new state and the effects out.
// Who may join, who is refused, what a joining party is sent, which
// reply answers which of the driver's requests, when the lease fires,
// and when the session ends are all rows of `step`, and the test for
// this file is a table of them. Nothing here touches a socket, a timer,
// or a promise; `sessionChannel.ts` applies the effects.
//
// The one idea: the run holds the session, and a connection is a party on
// it. A terminal debugger and a CLI visit can both be on the run at once,
// and either one drives: every request goes to every party, the first
// reply answers it, and the other party is told who answered and with
// what. A reply to a request that is no longer pending is refused, never
// reconciled; there is no merging anywhere here. A terminal's close is
// its detach, as before. A CLI visit connects, is shown where the program
// is, answers or reads, and disconnects, and the CLI's hold on the
// session stays, with the driver's requests pending, until the next visit
// or the lease.
import { describeAnswer } from "./describe.js";
import {
  REPLY_SCHEMAS,
  type AttachMessage,
  type ClientKind,
  type FinishedMessage,
  type Hello,
  type NoticeMessage,
  type PartiesMessage,
  type PartyKind,
  type RequestMessage,
  type StatusMessage,
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

type ReplyMessage = Extract<AttachMessage, { type: "reply" }>;

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
  /** For each pending `render`, by id, the parties still to acknowledge
   *  it. */
  awaiting: Record<number, PartyId[]>;
  /** The parties sent the last render on joining and not yet done
   *  drawing it; the requests waiting go to each once it has. */
  drawing: PartyId[];
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
    pending: [],
    awaiting: {},
    drawing: [],
    lastRender: null,
    settings: {},
    spinning: false,
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
export const ANSWERED_KEPT = 10;

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
  const { state: showing, effects } = shown(joined, party);
  return {
    state: showing,
    effects: [...lease, ...effects, ...sendTo(others, partiesOf(joined))],
  };
}

/** What a party is sent as it joins: the run's hello, who else is on the
 *  run, the settings and the spinner as they stand, the recent activity,
 *  then, when the driver is waiting on an answer, the stop. The requests
 *  waiting follow once the party has acknowledged the stop, so it has
 *  drawn or stored it before it is asked for a command, as the driver
 *  arranges for a party that was there when the stop came. A joiner
 *  during a render that is still pending is one more party it waits
 *  for. With nothing pending the program is running, and the last stop
 *  is not shown: it is where the program was, not where it is. */
function shown(state: SessionState, party: PartyId): Stepped {
  const hello: AttachMessage[] = state.hello === null ? [] : [state.hello];
  const settings = Object.values(state.settings);
  const spinner: AttachMessage[] = state.spinning
    ? [{ type: "notice", method: "startSpinner", args: [] }]
    : [];
  const recent = state.recent.map(logLine);
  const first = [...hello, partiesOf(state), ...settings, ...spinner, ...recent];
  const render = state.pending.length > 0 ? state.lastRender : null;
  if (render === null) {
    return { state, effects: first.flatMap((message) => sendTo([party], message)) };
  }
  const awaited = state.awaiting[render.id];
  const awaiting =
    awaited === undefined
      ? state.awaiting
      : { ...state.awaiting, [render.id]: [...awaited, party] };
  return {
    state: { ...state, awaiting, drawing: [...state.drawing, party] },
    effects: [...first, render].flatMap((message) => sendTo([party], message)),
  };
}

/** A party has left: it is waited on for nothing, and the rest are told
 *  who is still on the run. The session ends with the last party. The
 *  `before` effects (a lease to start, a channel to close) come first. */
function left(state: SessionState, party: PartyId, before: Effect[]): Stepped {
  const gone = {
    ...state,
    drawing: state.drawing.filter((other) => other !== party),
    awaiting: withoutParty(state.awaiting, party),
  };
  const settled = settleRenders(gone);
  const rest = connected(settled.state);
  if (settled.state.terminal === null && settled.state.cli === null) {
    return { state: settled.state, effects: [...before, ...settled.effects, { type: "end" }] };
  }
  return {
    state: settled.state,
    effects: [...before, ...settled.effects, ...sendTo(rest, partiesOf(settled.state))],
  };
}

function withoutParty(
  awaiting: Record<number, PartyId[]>,
  party: PartyId,
): Record<number, PartyId[]> {
  const result: Record<number, PartyId[]> = {};
  for (const [id, parties] of Object.entries(awaiting)) {
    result[Number(id)] = parties.filter((other) => other !== party);
  }
  return result;
}

/** Every pending render that no party is still waited on for is done:
 *  the driver gets the one acknowledgement it asked for. */
function settleRenders(state: SessionState): Stepped {
  const done = state.pending.filter(
    (request) => request.method === "render" && (state.awaiting[request.id] ?? []).length === 0,
  );
  if (done.length === 0) {
    return { state, effects: [] };
  }
  const awaiting = { ...state.awaiting };
  for (const render of done) {
    delete awaiting[render.id];
  }
  return {
    state: {
      ...state,
      pending: state.pending.filter((request) => !done.includes(request)),
      awaiting,
    },
    effects: done.map((render) => ({
      type: "toDriver",
      message: { type: "reply", id: render.id, result: undefined },
    })),
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
      // A party still drawing the replayed stop is sent this once it has.
      const parties = connected(state).filter((party) => !state.drawing.includes(party));
      const isRender = message.method === "render";
      const kept = isRender ? asLastRender(state, message) : message;
      return {
        state: {
          ...state,
          pending: [...state.pending, kept],
          awaiting: isRender ? { ...state.awaiting, [message.id]: parties } : state.awaiting,
          lastRender: isRender ? kept : state.lastRender,
        },
        effects: sendTo(parties, message),
      };
    }
    case "notice":
      return { state: noted(state, message), effects: sendTo(connected(state), message) };
    case "finished": {
      const parties = connected(state);
      if (parties.length === 0) {
        return {
          state: { ...state, finished: message, pending: [], awaiting: {} },
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
    case "reply":
      return reply(state, party, message);
    case "pause":
      return { state, effects: [{ type: "toDriver", message }] };
    case "detach":
      return detachParty(state, party);
    default:
      return { state, effects: [] };
  }
}

/** A CLI visit releasing the hold: the visit is closed, the hold is
 *  gone, and the session ends unless a terminal is attached. A terminal
 *  sending it is treated as closing. */
function detachParty(state: SessionState, party: PartyId): Stepped {
  if (party === state.terminal) {
    return left({ ...state, terminal: null }, party, [{ type: "close", party }]);
  }
  return left({ ...state, cli: null }, party, [{ type: "clearLease" }, { type: "close", party }]);
}

/** A reply from a party. To a pending render, one acknowledgement of the
 *  ones waited on; from a party drawing the replayed stop, also the cue
 *  to send it the requests waiting. To any other pending request, the
 *  answer: the driver gets it, every party is told who answered and how,
 *  and the other parties are sent `answered` so a read they are inside
 *  stops. To a request already answered, `answered` again, so a late
 *  party is told; to anything else, nothing. A reply that carries the
 *  party's error, or an answer of the wrong shape for the request, is
 *  that party failing: it is dropped from the session, the way its
 *  failure ended the session when it was the only party, and the request
 *  stays pending for the rest. */
function reply(state: SessionState, party: PartyId, message: ReplyMessage): Stepped {
  const pending = state.pending.find((request) => request.id === message.id);
  if (pending === undefined) {
    const earlier = state.answered.find((answer) => answer.id === message.id);
    if (earlier !== undefined) {
      return { state, effects: sendTo([party], { type: "answered", ...earlier }) };
    }
    if (state.drawing.includes(party) && message.id === state.lastRender?.id) {
      return drawn(state, party);
    }
    return { state, effects: [] };
  }
  const failure = replyFailure(pending, message);
  if (failure !== null) {
    return dropped(state, party, `the ${kindOf(state, party)} ${failure}`);
  }
  if (pending.method === "render") {
    const awaited = (state.awaiting[pending.id] ?? []).filter((other) => other !== party);
    const acked = { ...state, awaiting: { ...state.awaiting, [pending.id]: awaited } };
    const settled = settleRenders(acked);
    if (!state.drawing.includes(party) || pending !== state.lastRender) {
      return settled;
    }
    const after = drawn(settled.state, party);
    return { state: after.state, effects: [...settled.effects, ...after.effects] };
  }
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
      pending: state.pending.filter((request) => request !== pending),
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

/** Why a reply cannot answer `pending`, in the words the log gets, or
 *  null when it can. */
function replyFailure(pending: RequestMessage, message: ReplyMessage): string | null {
  if (message.error !== undefined) {
    return `failed to answer ${pending.method}: ${message.error}`;
  }
  const checked = REPLY_SCHEMAS[pending.method].safeParse(message.result);
  if (!checked.success) {
    return `answered ${pending.method} with something that is not a ${pending.method} answer`;
  }
  return null;
}

/** A joining party has drawn the stop: the requests waiting go to it. */
function drawn(state: SessionState, party: PartyId): Stepped {
  const waiting = state.pending.filter((request) => request !== state.lastRender);
  return {
    state: { ...state, drawing: state.drawing.filter((other) => other !== party) },
    effects: waiting.flatMap((request) => sendTo([party], request)),
  };
}

/** A party that cannot answer is closed and taken off the session; a
 *  terminal's close is its detach, a visit's leaves the CLI's hold. */
function dropped(state: SessionState, party: PartyId, reason: string): Stepped {
  const log: Effect = { type: "log", line: `[agency debug] ${reason}; dropping it` };
  if (party === state.terminal) {
    return left({ ...state, terminal: null }, party, [log, { type: "close", party }]);
  }
  return left({ ...state, cli: { visit: null, lastVisit: null } }, party, [
    log,
    { type: "close", party },
    { type: "startLease" },
  ]);
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
