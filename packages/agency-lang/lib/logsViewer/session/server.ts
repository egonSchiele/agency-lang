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
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const reply = answer(port, { ...options, ...absolutePaths }, buffer.slice(0, newline));
      socket.end(JSON.stringify(reply) + "\n");
    });
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
      writeRecord(options.dir, {
        pid,
        logPath: absolutePaths.logPath,
        commentsPath: absolutePaths.commentsPath,
        cwd: process.cwd(),
        started: new Date().toISOString(),
      });
      resolve({
        socketPath: paths.sock,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => {
              removeRecord(options.dir, pid);
              done();
            });
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
  }
}
