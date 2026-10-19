// The running viewer's end of the wire. Starts a server on a Unix socket in
// the sessions directory, writes the record, answers one request per
// connection through the port, and removes both files on stop. The server
// never touches a comments file: a `reload` tells the port to re-read.
import * as net from "net";
import * as path from "path";

import { SessionRequestSchema, type SessionReply, type SessionRequest } from "./protocol.js";
import type { SessionPort } from "./port.js";
import { ensureSessionsDir, recordPaths, removeRecord, writeRecord } from "./registry.js";

/** macOS and the BSDs limit a Unix socket path to 104 bytes (108 on Linux);
 *  a long agent home on an external volume can go over. */
const MAX_SOCKET_PATH_BYTES = 104;
/** How long a connected client may take to send its one line. */
const REQUEST_TIMEOUT_MS = 5_000;
/** A request is one short JSON line; a client that sends more than this
 *  without a newline is not speaking the protocol and is dropped. */
const MAX_REQUEST_BYTES = 64 * 1024;

export type SessionServerOptions = {
  dir: string;
  logPath: string;
  commentsPath: string | undefined;
  /** The viewer's pid; a test may pick another to keep records apart. */
  pid?: number;
};

export type SessionServer = { socketPath: string; stop(): Promise<void> };

/** Why no server was started: the shell shows this once if asked for a
 *  session key, and otherwise runs as before. */
export type SessionUnavailable = { unavailable: string };

export function startSessionServer(
  port: SessionPort,
  options: SessionServerOptions,
): Promise<SessionServer | SessionUnavailable> {
  if (process.platform === "win32") {
    return Promise.resolve({ unavailable: "sessions need Unix sockets, which Windows lacks" });
  }
  const pid = options.pid ?? process.pid;
  const paths = recordPaths(options.dir, pid);
  // The viewer may have been given relative paths; the CLI that reads the
  // record runs from any directory, so the record carries absolute ones.
  const absolutePaths = {
    logPath: path.resolve(options.logPath),
    commentsPath:
      options.commentsPath === undefined ? undefined : path.resolve(options.commentsPath),
  };
  if (Buffer.byteLength(paths.sock) > MAX_SOCKET_PATH_BYTES) {
    return Promise.resolve({
      unavailable:
        `the session socket path is ${Buffer.byteLength(paths.sock)} bytes, over the ` +
        `${MAX_SOCKET_PATH_BYTES} the platform allows: set AGENCY_AGENT_HOME to a shorter path`,
    });
  }
  // A viewer that exited through a signal handler left its files behind, and
  // a reused pid would hit EADDRINUSE on them. They are ours by pid.
  try {
    ensureSessionsDir(options.dir);
    removeRecord(options.dir, pid);
  } catch (error) {
    return Promise.resolve({
      unavailable: `could not prepare ${options.dir}: ${(error as Error).message}`,
    });
  }
  // Every accepted socket, so `stop` can end one whose client never sent a
  // full line; `server.close` alone would wait on it forever.
  const open: net.Socket[] = [];
  let stopping = false;
  const server = net.createServer((socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    open.push(socket);
    socket.on("close", () => {
      open.splice(open.indexOf(socket), 1);
    });
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    // One request per connection: the first line is answered and the rest
    // of the stream is ignored, so a second line cannot run a navigate or
    // a reload twice, and a stream that never ends a line is cut off.
    let buffer = "";
    socket.setEncoding("utf8");
    const onData = (chunk: string): void => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.destroy();
        }
        return;
      }
      socket.removeListener("data", onData);
      const reply = answer(port, { ...options, ...absolutePaths }, buffer.slice(0, newline));
      socket.end(JSON.stringify(reply) + "\n");
    };
    socket.on("data", onData);
    socket.on("error", () => {
      // The client went away mid-request; there is nobody to answer.
    });
  });
  return new Promise((resolve) => {
    // A listen failure (a sessions directory that cannot be written, a
    // path the platform refuses) leaves the viewer running without a
    // session, as Windows does; it never takes the viewer down.
    const unavailable = (error: Error): void => {
      resolve({ unavailable: `could not listen on ${paths.sock}: ${error.message}` });
    };
    server.once("error", unavailable);
    server.listen(paths.sock, () => {
      server.removeListener("error", unavailable);
      try {
        writeRecord(options.dir, {
          pid,
          logPath: absolutePaths.logPath,
          commentsPath: absolutePaths.commentsPath,
          cwd: process.cwd(),
          started: new Date().toISOString(),
        });
      } catch (error) {
        // A record that cannot be written (a full disk, a directory made
        // read-only between mkdir and now) leaves no session; the socket
        // is closed so nothing listens that no CLI can find.
        server.close();
        resolve({ unavailable: `could not write ${paths.json}: ${(error as Error).message}` });
        return;
      }
      resolve({
        socketPath: paths.sock,
        stop: () =>
          new Promise<void>((done) => {
            stopping = true;
            server.close(() => {
              removeRecord(options.dir, pid);
              done();
            });
            for (const socket of [...open]) {
              socket.destroy();
            }
          }),
      });
    });
  });
}

export function isUnavailable(
  started: SessionServer | SessionUnavailable,
): started is SessionUnavailable {
  return "unavailable" in started;
}

function answer(port: SessionPort, options: SessionServerOptions, line: string): SessionReply {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: "request is not JSON" };
  }
  const parsed = SessionRequestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: `bad request: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  }
  return handle(port, options, parsed.data);
}

function handle(
  port: SessionPort,
  options: SessionServerOptions,
  req: SessionRequest,
): SessionReply {
  // A port call runs viewer code; a throw here would be uncaught in the
  // socket's data handler and take the viewer down in raw mode.
  try {
    return answerRequest(port, options, req);
  } catch (error) {
    return {
      ok: false,
      error: `the viewer could not handle ${req.op}: ${(error as Error).message}`,
    };
  }
}

function answerRequest(
  port: SessionPort,
  options: SessionServerOptions,
  req: SessionRequest,
): SessionReply {
  switch (req.op) {
    case "get":
      return {
        ok: true,
        focus: { ...port.focus(), logPath: options.logPath, commentsPath: options.commentsPath },
      };
    case "navigate": {
      const result = port.navigate(req.traceId, req.rowId);
      return result === "ok" ? { ok: true } : { ok: false, error: result };
    }
    case "reload":
      port.reloadComments();
      return { ok: true };
    case "pick":
      port.pick();
      return { ok: true };
  }
}
