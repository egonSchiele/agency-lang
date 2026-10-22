// The run side. `openSession` is the whole of attaching: build a driver
// in attached mode on a `ChannelDebuggerIO` over a session channel, send
// `hello`, install the driver, and detach when the session ends. The
// session's parties, a terminal debugger or the visits of `agency debug
// session`, are admitted to it as they connect; the rules for who may
// join and when the session ends are `sessionRules.ts`. A test hands
// `attachOverChannel` one side of an in-memory pair, which opens a
// session with that channel as its terminal. `startAttachServer` is the
// Node piece around it: a Unix socket in the sessions directory, one
// session at a time, nothing kept alive by an open session.
import * as fs from "fs";
import * as net from "net";

import { hasInterrupts } from "../../runtime/interrupts.js";
import { isPaused } from "../../runtime/pause.js";
import type { AttachedRunResult } from "../../runtime/attachedDebugger.js";
import { DebuggerDriver, type ModuleFunctions } from "../driver.js";
import type { Channel } from "./channel.js";
import { ChannelDebuggerIO } from "./channelIO.js";
import { lineChannel } from "./lineChannel.js";
import { parseAttachMessage, type ClientKind, type Hello } from "./protocol.js";
import { ensureSessionsDir, recordPaths, type AttachRecord } from "./registry.js";
import { sessionChannel, type SessionChannelOptions } from "./sessionChannel.js";
import { emptySession, statusOf } from "./sessionRules.js";

/** macOS and the BSDs limit a Unix socket path to 104 bytes (108 on
 *  Linux). */
const MAX_SOCKET_PATH_BYTES = 104;
const DEFAULT_REWIND_SIZE = 30;
/** How long a connection has to say what it is. A client built before
 *  `client` existed sends nothing first and would wait on `hello` for
 *  ever; it is told why instead. */
export const HANDSHAKE_MS = 5_000;

export type AttachOptions = {
  functions: ModuleFunctions;
  hello: Hello;
  rewindSize?: number;
  session?: SessionChannelOptions;
};

export type AttachedSession = {
  driver: DebuggerDriver;
  /** A connection that sent `client` with this kind. */
  admit(channel: Channel, kind: ClientKind): void;
  /** Run `listener` once, when the session ends for any reason. */
  onEnd(listener: () => void): void;
  /** End the session: the driver is removed and every party is closed. */
  detach(): void;
};

/** Open a session on the program behind `functions`, with no party on
 *  it yet. The driver is installed at once, so the program stops at its
 *  next step and waits for the first party to join. */
export function openSession(options: AttachOptions): AttachedSession {
  const channel = sessionChannel(options.session);
  const io = new ChannelDebuggerIO(channel);
  const driver = new DebuggerDriver({
    mod: options.functions,
    rewindSize: options.rewindSize ?? DEFAULT_REWIND_SIZE,
    ui: io,
    attached: true,
  });
  channel.onClose(() => driver.detach());
  channel.send(options.hello);
  driver.attach();
  // The program's end reaches here two ways: through `finished` when it
  // ends in a leg the caller ran, and as the final result of `run` when
  // the driver ran the leg that ended it. Either way the driver comes off
  // the program, and the session tells its parties and ends, or keeps
  // the news for a visit that comes later.
  const finished = (message: { value?: unknown; error?: string }): void => {
    driver.detach();
    channel.send({ type: "finished", ...message });
  };
  const attached = driver.debuggerState.attached!;
  const finishedByDriver = attached.finished;
  attached.finished = async (result) => {
    await finishedByDriver(result);
    finished({ value: result?.data });
  };
  const runByDriver = attached.run;
  attached.run = async (result, leg) => {
    let ran: AttachedRunResult;
    try {
      ran = await runByDriver(result, leg);
    } catch (error) {
      // A function set built by hand without the serve-style resume
      // (only a test does that today; `attachFunctionsFor` always has it)
      // throws a failed leg's error instead; the person is told the same
      // way.
      finished({ error: errorText(error) });
      throw error;
    }
    if ("threw" in ran) {
      finished({ error: errorText(ran.threw) });
    } else if (!hasInterrupts(ran.result?.data) && !isPaused(ran.result?.data)) {
      // A paused checkpoint, from the caller's own pause signal, is a
      // suspension, not the end: the caller resumes it, and the session
      // goes on.
      finished({ value: ran.result?.data });
    }
    return ran;
  };
  return {
    driver,
    admit: (party, kind) => channel.admit(party, kind),
    onEnd: (listener) => channel.onClose(listener),
    detach: () => channel.end(),
  };
}

/** Attach a debugger that speaks over `channel`, a terminal whose
 *  connection is its session: closing it, from either side, detaches. */
export function attachOverChannel(channel: Channel, options: AttachOptions): AttachedSession {
  const session = openSession(options);
  session.admit(channel, "terminal");
  return session;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type AttachServer = {
  socketPath: string;
  /** The session on the connection in progress, or null. */
  current(): AttachedSession | null;
  stop(): Promise<void>;
};

export type ServerUnavailable = { unavailable: string };

export type AttachServerOptions = {
  dir: string;
  record: AttachRecord;
  /** The functions of the context a debugger attaches to, read when a
   *  debugger connects: the context running then is the one meant, and
   *  a TypeScript program can have started another node since the
   *  signal arrived. */
  functions: () => ModuleFunctions;
  rewindSize?: number;
  log?: (line: string) => void;
};

/** Listen on `<pid>.sock` in the sessions directory. A connection's
 *  first message says what it is; the first to join opens the session,
 *  and the rules in `sessionRules.ts` say who else may. The server and
 *  every accepted socket are `unref`ed, so an open session never keeps a
 *  finished program alive, and the server is `ref`ed only while the
 *  driver waits on an answer. Node cannot read the peer's pid from a
 *  Unix socket, so a refusal says since when. Every way this can fail
 *  comes back as `unavailable`:
 *  the signal listener that calls it must never throw into the program.
 *  The directory is checked here, right before `listen`, not only at
 *  registration hours earlier: the check is what keeps the socket's
 *  short window at the umask's mode private. */
export async function startAttachServer(
  options: AttachServerOptions,
): Promise<AttachServer | ServerUnavailable> {
  const log = options.log ?? ((line: string) => console.error(line));
  if (process.platform === "win32") {
    return { unavailable: "attach needs Unix sockets, which Windows lacks" };
  }
  const refusal = ensureSessionsDir(options.dir);
  if (refusal !== null) {
    return { unavailable: refusal.refused };
  }
  const paths = recordPaths(options.dir, options.record.pid);
  if (Buffer.byteLength(paths.sock) > MAX_SOCKET_PATH_BYTES) {
    return {
      unavailable:
        `the debug socket path is ${Buffer.byteLength(paths.sock)} bytes, over the ` +
        `${MAX_SOCKET_PATH_BYTES} the platform allows: set AGENCY_HOME to a shorter path`,
    };
  }
  // A run that exited through a signal handler left its socket behind, and
  // a reused pid would hit EADDRINUSE on it. It is ours by pid. A
  // directory at that path, or one we may not remove, is a refusal.
  try {
    fs.rmSync(paths.sock, { force: true });
  } catch (error) {
    return { unavailable: `could not remove ${paths.sock}: ${(error as Error).message}` };
  }

  let session: AttachedSession | null = null;
  const hello: Hello = {
    type: "hello",
    program: options.record.program,
    node: options.record.node,
    pid: options.record.pid,
  };
  const admit = (channel: Channel, kind: ClientKind): void => {
    if (session === null && kind === "probe") {
      channel.send(statusOf(emptySession()));
      channel.close();
      return;
    }
    if (session === null) {
      const opened = openSession({
        functions: options.functions(),
        hello,
        rewindSize: options.rewindSize,
        session: { keepAlive: (on) => (on ? server.ref() : server.unref()), log },
      });
      opened.onEnd(() => {
        if (session === opened) {
          session = null;
        }
      });
      session = opened;
    }
    session.admit(channel, kind);
  };
  // The connections that have not said what they are yet. The session
  // owns a connection only from its `client` message, so these are closed
  // here, by the deadline or at `stop`.
  let greeting: Channel[] = [];
  const server = net.createServer((socket) => {
    socket.unref();
    const channel = lineChannel(socket);
    greeting.push(channel);
    const done = (): void => {
      greeting = greeting.filter((entry) => entry !== channel);
      clearTimeout(deadline);
      stop();
    };
    const deadline = setTimeout(() => {
      done();
      channel.send({
        type: "refused",
        reason: `no client message within ${HANDSHAKE_MS / 1000} seconds; is the debugger an older build?`,
      });
      channel.close();
    }, HANDSHAKE_MS);
    deadline.unref();
    const stop = channel.onMessage((raw) => {
      done();
      const message = parseAttachMessage(raw);
      if (message === null || message.type !== "client") {
        channel.send({ type: "refused", reason: "the first message must say what the client is" });
        channel.close();
        return;
      }
      admit(channel, message.kind);
    });
    channel.onClose(done);
  });
  server.unref();

  return new Promise((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ unavailable: `could not listen on ${paths.sock}: ${error.message}` });
    });
    server.listen(paths.sock, () => {
      try {
        fs.chmodSync(paths.sock, 0o600);
      } catch (error) {
        server.close();
        fs.rmSync(paths.sock, { force: true });
        resolve({ unavailable: `could not chmod ${paths.sock}: ${(error as Error).message}` });
        return;
      }
      resolve({
        socketPath: paths.sock,
        current: () => session,
        stop: () =>
          new Promise<void>((done) => {
            session?.detach();
            for (const channel of [...greeting]) {
              channel.close();
            }
            server.close(() => {
              fs.rmSync(paths.sock, { force: true });
              done();
            });
          }),
      });
    });
  });
}
