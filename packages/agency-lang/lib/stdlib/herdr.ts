// Reports a line-mode REPL to Herdr, the terminal workspace manager for
// coding agents. Herdr sets HERDR_ENV, HERDR_SOCKET_PATH, and HERDR_PANE_ID
// in every pane it runs; each request is one JSON line on that socket. See
// docs/dev/agents/herdr.md.

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

type StateReport = {
  kind: "state";
  state: HerdrState;
  message?: string;
};

type Report = StateReport | { kind: "release" };

type HerdrError = {
  code?: string;
};

type HerdrAnswer = {
  error?: HerdrError;
};

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

/** A reporter that shows this program in Herdr as `name`. It does nothing
 *  outside Herdr, or when `name` is empty. */
export function herdrReporter(
  env: Record<string, string | undefined>,
  name: string,
): HerdrReporter {
  const socketPath = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !socketPath || !paneId || !name) {
    return NO_HERDR;
  }
  const pane = { pane_id: paneId, source: name, agent: name };
  const nextSeq = clockSeq();
  let session: HerdrSession | null = null;
  let lastReport = "";
  let queued: Report | null = null;
  let draining: Promise<void> | null = null;

  // Built at send time, so a report queued before `session` was cleared
  // goes out without it.
  const requestFor = (report: Report): object => {
    const seq = nextSeq();
    const id = `${name}:${seq}`;
    if (report.kind === "release") {
      return { id, method: "pane.release_agent", params: { ...pane, seq } };
    }
    const params: Record<string, unknown> = { ...pane, state: report.state, seq };
    if (report.message) {
      params.message = report.message;
    }
    if (session) {
      params.agent_session_id = session.id;
      params.resume_argv = session.resumeArgv;
    }
    return { id, method: "pane.report_agent", params };
  };

  // One request in flight at a time; a newer report replaces the queued one.
  const drain = async (): Promise<void> => {
    while (queued) {
      const report = queued;
      queued = null;
      const answer = await sendLine(socketPath, requestFor(report));
      // Herdr drops the whole report when it refuses the resume command, so
      // stop sending the command and send the state again without it.
      if (answer?.error?.code === "invalid_resume_argv" && session) {
        session = null;
        queued ??= report;
      }
    }
    draining = null;
  };

  const enqueue = (report: Report): void => {
    queued = report;
    draining ??= drain();
  };

  const report = (state: HerdrState, message?: string): void => {
    const key = JSON.stringify([state, message, session?.id]);
    if (key === lastReport) {
      return;
    }
    lastReport = key;
    enqueue({ kind: "state", state, message });
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
      enqueue({ kind: "release" });
      return draining ?? Promise.resolve();
    },
  };
}

function clockSeq(): () => number {
  let lastSeq = 0;
  return () => {
    lastSeq = Math.max(lastSeq + 1, Date.now() * SEQ_PER_MS);
    return lastSeq;
  };
}

/** Write one JSON line to Herdr and resolve with its answer, or with null
 *  on a close, an error, or the timeout. Failures are dropped on purpose:
 *  Herdr is optional, and its trouble must not reach the user's terminal. */
function sendLine(socketPath: string, request: object): Promise<HerdrAnswer | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (answer: HerdrAnswer | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(null), REPORT_TIMEOUT_MS);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => done(parseAnswer(chunk.toString())));
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
  });
}

function parseAnswer(text: string): HerdrAnswer | null {
  try {
    return JSON.parse(text.split("\n")[0]) as HerdrAnswer;
  } catch {
    // Not an answer this reporter can read, so it counts as no answer.
    return null;
  }
}
