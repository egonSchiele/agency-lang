// The run side. `attachOverChannel` is the whole of attaching once a
// channel exists: build a driver in attached mode on a `ChannelDebuggerIO`,
// send `hello`, install the driver, and detach when the channel closes. A
// test hands it one side of an in-memory pair. `startAttachServer` is the
// Node piece around it: a Unix socket in the sessions directory, one
// debugger at a time, nothing kept alive by an open session.
import * as fs from "fs";
import * as net from "net";

import { hasInterrupts } from "../../runtime/interrupts.js";
import { DebuggerDriver, type ModuleFunctions } from "../driver.js";
import type { Channel } from "./channel.js";
import { ChannelDebuggerIO } from "./channelIO.js";
import { lineChannel } from "./lineChannel.js";
import type { Hello } from "./protocol.js";
import { recordPaths, type AttachRecord } from "./registry.js";

/** macOS and the BSDs limit a Unix socket path to 104 bytes (108 on
 *  Linux). */
const MAX_SOCKET_PATH_BYTES = 104;
const DEFAULT_REWIND_SIZE = 30;

export type AttachOptions = {
  functions: ModuleFunctions;
  hello: Hello;
  rewindSize?: number;
  /** Where a line about the session goes, such as a refused second
   *  connection. The program's stderr by default. */
  log?: (line: string) => void;
};

export type AttachedSession = {
  driver: DebuggerDriver;
  /** Since when, for the message a second connection gets. */
  since: Date;
  /** Tell the person the program finished, then end the session. */
  finished(value: unknown): void;
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
    const ran = await runByDriver(result, leg);
    if (!hasInterrupts(ran.result?.data)) {
      channel.send({ type: "finished", value: ran.result?.data });
      detach();
    }
    return ran;
  };
  return {
    driver,
    since: new Date(),
    finished: (value) => {
      channel.send({ type: "finished", value });
      detach();
    },
    detach,
  };
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
  functions: ModuleFunctions;
  rewindSize?: number;
  log?: (line: string) => void;
};

/** Listen on `<pid>.sock` in the sessions directory and attach the first
 *  debugger that connects. The server and every accepted socket are
 *  `unref`ed, so an open session never keeps a finished program alive. A
 *  second connection while one is attached is told so and closed; Node
 *  cannot read the peer's pid from a Unix socket, so the message says
 *  since when. The caller has already checked the directory
 *  (`ensureSessionsDir`). */
export function startAttachServer(
  options: AttachServerOptions,
): Promise<AttachServer | ServerUnavailable> {
  const log = options.log ?? ((line: string) => console.error(line));
  if (process.platform === "win32") {
    return Promise.resolve({ unavailable: "attach needs Unix sockets, which Windows lacks" });
  }
  const paths = recordPaths(options.dir, options.record.pid);
  if (Buffer.byteLength(paths.sock) > MAX_SOCKET_PATH_BYTES) {
    return Promise.resolve({
      unavailable:
        `the debug socket path is ${Buffer.byteLength(paths.sock)} bytes, over the ` +
        `${MAX_SOCKET_PATH_BYTES} the platform allows: set AGENCY_HOME to a shorter path`,
    });
  }
  // A run that exited through a signal handler left its socket behind, and
  // a reused pid would hit EADDRINUSE on it. It is ours by pid.
  fs.rmSync(paths.sock, { force: true });

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
      functions: options.functions,
      hello,
      rewindSize: options.rewindSize,
      log,
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
