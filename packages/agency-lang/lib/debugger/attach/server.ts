// The run side. `attachOverChannel` is the whole of attaching once a
// channel exists: build a driver in attached mode on a `ChannelDebuggerIO`,
// send `hello`, install the driver, and detach when the channel closes. A
// test hands it one side of an in-memory pair. `startAttachServer` is the
// Node piece around it: a Unix socket in the sessions directory, one
// debugger at a time, nothing kept alive by an open session.
import * as fs from "fs";
import * as net from "net";

import { hasInterrupts } from "../../runtime/interrupts.js";
import { isPaused } from "../../runtime/pause.js";
import type { AttachedRunResult } from "../../runtime/attachedDebugger.js";
import { DebuggerDriver, type ModuleFunctions } from "../driver.js";
import type { Channel } from "./channel.js";
import { ChannelDebuggerIO } from "./channelIO.js";
import { lineChannel } from "./lineChannel.js";
import type { Hello } from "./protocol.js";
import { ensureSessionsDir, recordPaths, type AttachRecord } from "./registry.js";

/** macOS and the BSDs limit a Unix socket path to 104 bytes (108 on
 *  Linux). */
const MAX_SOCKET_PATH_BYTES = 104;
const DEFAULT_REWIND_SIZE = 30;

export type AttachOptions = {
  functions: ModuleFunctions;
  hello: Hello;
  rewindSize?: number;
};

export type AttachedSession = {
  driver: DebuggerDriver;
  /** Since when, for the message a second connection gets. */
  since: Date;
  detach(): void;
};

/** Attach a debugger that speaks over `channel` to the program behind
 *  `functions`. Closing the channel, from either side, detaches. */
export function attachOverChannel(channel: Channel, options: AttachOptions): AttachedSession {
  const io = new ChannelDebuggerIO(channel);
  const driver = new DebuggerDriver({
    mod: options.functions,
    rewindSize: options.rewindSize ?? DEFAULT_REWIND_SIZE,
    ui: io,
    attached: true,
  });
  let detached = false;
  const detach = (): void => {
    if (detached) {
      return;
    }
    detached = true;
    driver.detach();
    channel.close();
  };
  channel.onClose(() => detach());
  channel.send(options.hello);
  driver.attach();
  // The program's end reaches here two ways: through `finished` when it
  // ends in a leg the caller ran, and as the final result of `run` when
  // the driver ran the leg that ended it. Either way the person is told
  // and the session ends.
  const attached = driver.debuggerState.attached!;
  const finishedByDriver = attached.finished;
  attached.finished = async (result) => {
    await finishedByDriver(result);
    channel.send({ type: "finished", value: result?.data });
    detach();
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
      channel.send({ type: "finished", value: undefined, error: errorText(error) });
      detach();
      throw error;
    }
    if ("threw" in ran) {
      channel.send({ type: "finished", value: undefined, error: errorText(ran.threw) });
      detach();
    } else if (!hasInterrupts(ran.result?.data) && !isPaused(ran.result?.data)) {
      // A paused checkpoint, from the caller's own pause signal, is a
      // suspension, not the end: the caller resumes it, and the session
      // goes on.
      channel.send({ type: "finished", value: ran.result?.data });
      detach();
    }
    return ran;
  };
  return { driver, since: new Date(), detach };
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

/** Listen on `<pid>.sock` in the sessions directory and attach the first
 *  debugger that connects. The server and every accepted socket are
 *  `unref`ed, so an open session never keeps a finished program alive. A
 *  second connection while one is attached is told so and closed; Node
 *  cannot read the peer's pid from a Unix socket, so the message says
 *  since when. Every way this can fail comes back as `unavailable`:
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
  const server = net.createServer((socket) => {
    socket.unref();
    const channel = lineChannel(socket);
    if (session !== null) {
      channel.send({
        type: "refused",
        reason: `already attached since ${session.since.toLocaleTimeString()}`,
      });
      log(
        `[agency debug] refused a second debugger: attached since ${session.since.toISOString()}`,
      );
      channel.close();
      return;
    }
    const attached = attachOverChannel(channel, {
      functions: options.functions(),
      hello,
      rewindSize: options.rewindSize,
    });
    session = attached;
    channel.onClose(() => {
      if (session === attached) {
        session = null;
      }
    });
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
            server.close(() => {
              fs.rmSync(paths.sock, { force: true });
              done();
            });
          }),
      });
    });
  });
}
