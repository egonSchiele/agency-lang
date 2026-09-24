import * as http from "node:http";
import { parseJsonBody } from "../serve/util.js";
import { notServedMessage } from "./localServe.js";
import {
  createCapture,
  describeReply,
  describeRequest,
  serveLogLines,
  type LogEntry,
  type LogOptions,
  type Reply,
} from "./serveLog.js";

/** One process behind the door: the name requests use for it, the string it
 *  was started with (the request's `model` is rewritten to this, because
 *  mlx_lm.server loads whatever model a request names), its port, and how
 *  it is named in a message. */
export type Route = { model: string; upstreamModel: string; port: number; label: string };

export type FrontDoor = { port: number; close: () => Promise<void> };

/** Where the door prints what it saw, and how much of it. Absent for a door
 *  that logs nothing, which is what the tests of the forwarding itself use. */
export type DoorLogging = LogOptions & { log: (line: string) => void };

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function error(res: http.ServerResponse, status: number, message: string): void {
  json(res, status, { error: { message } });
}

/** Headers that describe the connection or the framing of the body we
 *  already read. The forwarded request gets its own. */
const HOP_HEADERS = ["transfer-encoding", "host", "connection", "content-length"];

function forwardHeaders(
  incoming: http.IncomingHttpHeaders,
  bodyLength: number,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!HOP_HEADERS.includes(name)) {
      headers[name] = value;
    }
  }
  headers["content-length"] = String(bodyLength);
  return headers;
}

/** What the door does with one request once it knows how it ended: the
 *  reply as it went out. */
type Finish = (reply: Reply) => void;

/** The request with its reply length held to `limit`, the server's
 *  --max-tokens. mlx_lm.server reads a request's own `max_tokens` over its
 *  flag, so the flag alone only caps requests that name no length. Capping
 *  here makes it the ceiling the flag promises. A request that names no
 *  length is left alone, since the process then applies the flag itself. */
export function capMaxTokens(
  body: Record<string, unknown>,
  limit: number | undefined,
): Record<string, unknown> {
  if (limit === undefined) {
    return body;
  }
  const capped = { ...body };
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const value = capped[field];
    if (typeof value === "number" && value > limit) {
      capped[field] = limit;
    }
  }
  return capped;
}

/** The reply for a JSON body the door wrote itself. */
function ownReply(status: number, body: string): Reply {
  return {
    status,
    body,
    contentType: "application/json",
    truncated: false,
    totalBytes: Buffer.byteLength(body),
  };
}

function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: Route,
  body: Buffer,
  finish: Finish,
): void {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: route.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers, body.length),
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      // A copy of the reply for the log. The client's bytes are untouched:
      // this listener only reads what pipe is already carrying.
      const capture = createCapture();
      up.on("data", (chunk: Buffer) => capture.push(chunk));
      up.pipe(res);
      // The process died mid-reply: end our side too, or the client waits.
      up.on("close", () => {
        if (!up.complete) {
          res.destroy();
        }
        finish({
          status: up.statusCode ?? 502,
          body: capture.text(),
          contentType: up.headers["content-type"],
          truncated: capture.truncated || !up.complete,
          totalBytes: capture.total,
        });
      });
    },
  );
  upstream.on("error", (err) => {
    const message = `${route.label}: ${err.message}`;
    error(res, 502, message);
    finish(ownReply(502, JSON.stringify({ error: { message } })));
  });
  // The client went away mid-reply: close our side of the upstream socket.
  // The chat server looks at its socket while it generates and drops the
  // reply within half a second of this, instead of running it to
  // max_tokens for nobody.
  res.on("close", () => {
    if (!res.writableFinished) {
      upstream.destroy();
    }
  });
  upstream.end(body);
}

type ReadResult =
  { body: Record<string, unknown> } | { refusal: { status: number; message: string } };

/** The request body, or how to refuse it. Refusing is left to the caller so
 *  that every reply the door sends, including this one, reaches the log. */
async function readRequest(req: http.IncomingMessage): Promise<ReadResult> {
  try {
    const parsed = await parseJsonBody(req);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { refusal: { status: 400, message: "Request body is not a JSON object." } };
    }
    return { body: parsed as Record<string, unknown> };
  } catch (err) {
    const message = (err as Error).message;
    const status = message === "Request body too large" ? 413 : 400;
    return { refusal: { status, message: `${message}.` } };
  }
}

/** Times one request and prints its lines when it ends. A door with no
 *  logging gets a recorder whose `finish` does nothing. */
function recorder(
  req: http.IncomingMessage,
  logging: DoorLogging | undefined,
  now: () => number = Date.now,
): { finish: Finish; describe: (body: Record<string, unknown>) => void } {
  if (logging === undefined) {
    return { finish: () => {}, describe: () => {} };
  }
  const started = now();
  const entry: LogEntry = {
    method: req.method ?? "?",
    path: req.url ?? "",
    model: null,
    status: 0,
    durationMs: 0,
    request: null,
    reply: null,
  };
  let written = false;
  return {
    describe: (body) => {
      entry.model = typeof body.model === "string" ? body.model : null;
      entry.request = describeRequest(body);
    },
    finish: (reply) => {
      if (written) {
        return;
      }
      written = true;
      entry.status = reply.status;
      entry.durationMs = now() - started;
      entry.reply = describeReply(reply);
      for (const line of serveLogLines(entry, logging)) {
        logging.log(line);
      }
    },
  };
}

/** Listen on `port` (0 for any) and forward each request to the route whose
 *  model matches the request body's `model`. A request for any other model
 *  gets a 404 and reaches no process. With `logging`, every request is
 *  printed as it ends. With `maxTokens`, a request asking for a longer
 *  reply is held to it. */
export function startFrontDoor(
  port: number,
  routes: Route[],
  logging?: DoorLogging,
  maxTokens?: number,
): Promise<FrontDoor> {
  const served = routes.map((r) => r.model);
  const server = http.createServer(async (req, res) => {
    const record = recorder(req, logging);
    const refuse = (status: number, message: string): void => {
      error(res, status, message);
      record.finish(ownReply(status, JSON.stringify({ error: { message } })));
    };
    if (req.method === "GET" && req.url === "/v1/models") {
      const body = { object: "list", data: served.map((id) => ({ id, object: "model" })) };
      json(res, 200, body);
      record.finish(ownReply(200, JSON.stringify(body)));
      return;
    }
    const read = await readRequest(req);
    if ("refusal" in read) {
      refuse(read.refusal.status, read.refusal.message);
      return;
    }
    const parsed = read.body;
    record.describe(parsed);
    if (typeof parsed.model !== "string") {
      refuse(
        400,
        `The request names no model. Set the model field to one of: ${served.join(", ")}.`,
      );
      return;
    }
    const model = parsed.model;
    const route = routes.find((r) => r.model === model);
    if (route === undefined) {
      refuse(404, notServedMessage(served, model));
      return;
    }
    forward(
      req,
      res,
      route,
      Buffer.from(
        JSON.stringify({ ...capMaxTokens(parsed, maxTokens), model: route.upstreamModel }),
      ),
      record.finish,
    );
  });
  // closeAllConnections: a reply still streaming from a process we just
  // killed would otherwise keep close() from ever finishing.
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const bound = (server.address() as { port: number }).port;
      resolve({ port: bound, close });
    });
  });
}
