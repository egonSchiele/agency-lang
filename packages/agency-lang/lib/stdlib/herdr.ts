// Reports a line-mode REPL to Herdr, the terminal workspace manager for
// coding agents, so its sidebar shows the agent as idle, working, or
// blocked, and so it can reopen the session after a Herdr restart. Herdr
// sets HERDR_ENV, HERDR_SOCKET_PATH, and HERDR_PANE_ID in every pane it
// runs; outside Herdr the reporter does nothing. Each request is one JSON
// line on the socket. See docs/dev/agents/herdr.md.

import * as net from "net";

export type HerdrState = "idle" | "working" | "blocked";

/** The saved session in the pane, and the command that reopens it. */
export type HerdrSession = {
  id: string;
  resumeArgv: string[];
};

export type HerdrReporter = {
  /** Report a state in the background. A repeat of the last report is dropped. */
  report: (state: HerdrState, message?: string) => void;
  /** Report blocked while `wait` runs, then working. */
  whileBlocked: <T>(message: string, wait: () => Promise<T>) => Promise<T>;
  /** The session in the pane. It goes out with every later report. */
  setSession: (session: HerdrSession) => void;
  /** Clear the agent from the pane. Resolves once Herdr answers or the report times out. */
  release: () => Promise<void>;
};

type HerdrRequest = {
  method: string;
  params: Record<string, unknown>;
};

type LatestOnlySender = {
  send: (request: HerdrRequest) => void;
  flush: () => Promise<void>;
};

// `agent` is the name Herdr shows. `source` names the integration; Herdr's
// own integrations start theirs with `herdr:`, so ours must not.
const AGENT_NAME = "agency";
const SOURCE = "agency";

// Herdr must never slow the REPL down, so a report with no answer by then is dropped.
const REPORT_TIMEOUT_MS = 500;

// Herdr ignores a report whose `seq` is not above the last one it took from
// this source, including one from an earlier process. So `seq` follows the
// clock in microseconds, and goes up by one when two reports share a tick.
const SEQ_PER_MS = 1000;

const NO_HERDR: HerdrReporter = {
  report: () => {},
  whileBlocked: (_message, wait) => wait(),
  setSession: () => {},
  release: async () => {},
};

export function herdrReporter(env: Record<string, string | undefined>): HerdrReporter {
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !socketPath || !paneId) {
    return NO_HERDR;
  }
  const sender = latestOnlySender(socketPath);
  const pane = { pane_id: paneId, source: SOURCE, agent: AGENT_NAME };
  let session: HerdrSession | null = null;
  let lastReport = "";

  const report = (state: HerdrState, message?: string): void => {
    const params: Record<string, unknown> = { ...pane, state };
    if (message) {
      params.message = message;
    }
    if (session) {
      params.agent_session_id = session.id;
      params.resume_argv = session.resumeArgv;
    }
    const key = JSON.stringify(params);
    if (key === lastReport) {
      return;
    }
    lastReport = key;
    sender.send({ method: "pane.report_agent", params });
  };

  return {
    report,
    whileBlocked: async (message, wait) => {
      report("blocked", message);
      try {
        return await wait();
      } finally {
        report("working");
      }
    },
    setSession: (next) => {
      session = next;
    },
    release: () => {
      sender.send({ method: "pane.release_agent", params: pane });
      return sender.flush();
    },
  };
}

/** Sends one request at a time. A request queued while another is in
 *  flight replaces whatever was queued before it, so Herdr only ever gets
 *  the latest state. */
function latestOnlySender(socketPath: string): LatestOnlySender {
  let lastSeq = 0;
  let queued: HerdrRequest | null = null;
  let draining: Promise<void> | null = null;

  const nextSeq = (): number => {
    lastSeq = Math.max(lastSeq + 1, Date.now() * SEQ_PER_MS);
    return lastSeq;
  };

  const drain = async (): Promise<void> => {
    while (queued) {
      const request = queued;
      queued = null;
      const seq = nextSeq();
      await sendLine(socketPath, {
        id: `${SOURCE}:${seq}`,
        method: request.method,
        params: { ...request.params, seq },
      });
    }
    draining = null;
  };

  return {
    send: (request) => {
      queued = request;
      draining ??= drain();
    },
    flush: () => draining ?? Promise.resolve(),
  };
}

/** Write one JSON line to Herdr, then wait for its answer, a close, an
 *  error, or the timeout, whichever comes first. A failure is dropped on
 *  purpose: Herdr is optional, and its trouble must not reach the user's
 *  terminal. */
function sendLine(socketPath: string, request: object): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(done, REPORT_TIMEOUT_MS);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", done);
    socket.on("error", done);
    socket.on("close", done);
  });
}
