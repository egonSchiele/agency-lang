import { applyRequestRules, type RequestRules, type Prepared } from "./requestRules.js";
import * as http from "node:http";
import { parseJsonBody } from "../serve/util.js";
import { notServedMessage } from "./localServe.js";
import { PoolRefusal, type Held, type ModelPool, type RefusalReason } from "./modelPool.js";
import { localBodyBytes } from "../stdlib/localImageInputs.js";
import { visionBodyBytes } from "../stdlib/vision.js";
import {
  createCapture,
  describeReply,
  describeRequest,
  IMAGES_PATH,
  serveLogLines,
  VISION_PATHS,
  type LogEntry,
  type LogOptions,
  type Reply,
} from "./serveLog.js";

/** mlx_lm's own name for whatever a server was started with. A client
 *  that cannot spell a repo id (Harbor allows a self-hosted model name one
 *  slash) can ask for this instead. It names the one model a single-model
 *  server serves, and nothing when several are served, since it would be
 *  a guess which. */
export const DEFAULT_MODEL_ALIAS = "default_model";

/** The served model a request for `requested` goes to: itself when it is
 *  served, the one served model for `default_model`, and undefined
 *  otherwise. */
export function servedModelFor(models: string[], requested: string): string | undefined {
  if (models.includes(requested)) {
    return requested;
  }
  return requested === DEFAULT_MODEL_ALIAS && models.length === 1 ? models[0] : undefined;
}

export type FrontDoor = { port: number; close: () => Promise<void> };

/** The routes Agency adds to the server, beside the OpenAI ones. */
const AGENCY_ROUTES = "/v1/agency/";

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
  held: Held,
  body: Buffer,
  finish: Finish,
): void {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: held.port,
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
    const message = `${held.plan.label}: ${err.message}`;
    error(res, 502, message);
    finish(ownReply(502, JSON.stringify({ error: { message } })));
  });
  // Close the upstream socket when the client leaves. Whether generation
  // stops depends on the runtime: mlx-vlm cancels streamed requests but
  // can finish a non-streaming request after the socket closes.
  res.on("close", () => {
    if (!res.writableFinished) {
      upstream.destroy();
    }
  });
  upstream.end(body);
}

/** The largest body the door reads for a request to each path whose
 *  server takes more than parseJsonBody's default: an image request may
 *  carry input images, and a vision request carries its image. Each limit
 *  is the one its server holds requests to. */
function bodyLimits(): Record<string, number> {
  return {
    [IMAGES_PATH]: localBodyBytes(),
    "/v1/chat/completions": localBodyBytes(),
    ...Object.fromEntries(VISION_PATHS.map((visionPath) => [visionPath, visionBodyBytes()])),
  };
}

/** The largest body the door reads for a request to `url`. A path not in
 *  `bodyLimits` keeps parseJsonBody's default. */
function bodyLimit(url: string | undefined): number | undefined {
  return url === undefined ? undefined : bodyLimits()[url];
}

/** The request body, or how to refuse it. Refusing is left to the caller so
 *  that every reply the door sends, including this one, reaches the log.
 *
 *  A body over the limit is read to its end and thrown away, so the client
 *  reads the 413 instead of seeing a dropped connection. That reading
 *  stops, and the socket closes, once the client has sent as much past the
 *  limit as the largest body the door takes. */
async function readRequest(
  req: http.IncomingMessage,
  maxBytes: number | undefined,
): Promise<Prepared> {
  try {
    const parsed = await parseJsonBody(req, maxBytes, localBodyBytes());
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
  let outputFormat: string | undefined;
  return {
    describe: (body) => {
      entry.model = typeof body.model === "string" ? body.model : null;
      entry.request = describeRequest(body);
      outputFormat = typeof body.output_format === "string" ? body.output_format : undefined;
    },
    finish: (reply) => {
      if (written) {
        return;
      }
      written = true;
      entry.status = reply.status;
      entry.durationMs = now() - started;
      entry.reply = describeReply(reply, { path: entry.path, outputFormat });
      for (const line of serveLogLines(entry, logging)) {
        logging.log(line);
      }
    },
  };
}

/** The status the door answers with when the pool will not hand out a
 *  model, by the pool's reason. */
const STATUS_FOR_REFUSAL: Record<RefusalReason, number> = {
  "not-loaded": 503,
  "load-failed": 502,
  "not-enough-memory": 503,
};

const FORBIDDEN_HOST = 403;

/** A route the door answers itself, about the server and not for a model. */
type AdminRoute = {
  method: "GET";
  path: string;
  handle: () => { status: number; body: unknown };
};

/** Whether a request's `Host` header names this server on this machine.
 *  The door listens on 127.0.0.1 only, but a web page can reach that
 *  address under a hostname of its own, and the browser then treats the
 *  page and the server as one site. Such a request carries the page's
 *  hostname here, and is refused. */
function isLocalHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Listen on `port` (0 for any) and forward each request to the process of
 *  the model its body names. A request for a model that is not served gets
 *  a 404 and reaches no process. With `logging`, every request is printed
 *  as it ends. With `maxTokens`, a request asking for a longer reply is
 *  held to it. */
export function startFrontDoor(
  port: number,
  pool: ModelPool,
  logging?: DoorLogging,
  maxTokens?: number,
): Promise<FrontDoor> {
  const served = pool.models();
  const adminRoutes: AdminRoute[] = [
    {
      method: "GET",
      path: "/v1/models",
      handle: () => ({
        status: 200,
        body: { object: "list", data: served.map((id) => ({ id, object: "model" })) },
      }),
    },
    {
      method: "GET",
      path: "/v1/agency/status",
      handle: () => ({ status: 200, body: { models: pool.status() } }),
    },
  ];
  const server = http.createServer(async (req, res) => {
    const record = recorder(req, logging);
    const refuse = (status: number, message: string): void => {
      error(res, status, message);
      record.finish(ownReply(status, JSON.stringify({ error: { message } })));
    };
    const admin = adminRoutes.find((row) => row.method === req.method && row.path === req.url);
    if (admin !== undefined) {
      const boundPort = (server.address() as { port: number }).port;
      if (admin.path.startsWith(AGENCY_ROUTES) && !isLocalHost(req.headers.host, boundPort)) {
        refuse(FORBIDDEN_HOST, "This route answers requests made to 127.0.0.1 or localhost only.");
        return;
      }
      const reply = admin.handle();
      json(res, reply.status, reply.body);
      record.finish(ownReply(reply.status, JSON.stringify(reply.body)));
      return;
    }
    const read = await readRequest(req, bodyLimit(req.url));
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
    const model = servedModelFor(served, parsed.model);
    const plan = model === undefined ? undefined : pool.plan(model);
    if (plan === undefined) {
      refuse(404, notServedMessage(served, parsed.model, req.url ?? ""));
      return;
    }
    // The rules run before the model is asked for, so a request they
    // refuse never holds a model.
    const prepared =
      plan.rules === null
        ? { body: parsed }
        : applyRequestRules(plan.rules, {
            method: req.method ?? "",
            path: req.url ?? "",
            body: parsed,
          });
    if ("refusal" in prepared) {
      refuse(prepared.refusal.status, prepared.refusal.message);
      return;
    }
    // The client may leave while its model loads. `res.destroyed` does not
    // say so until something is written, so watch the close instead.
    let clientGone = false;
    res.once("close", () => {
      clientGone = true;
    });
    let held: Held;
    try {
      held = await pool.acquire(plan.model);
    } catch (err) {
      if (!(err instanceof PoolRefusal)) {
        throw err;
      }
      refuse(STATUS_FOR_REFUSAL[err.reason], err.message);
      return;
    }
    if (clientGone) {
      held.release();
      return;
    }
    forward(
      req,
      res,
      held,
      Buffer.from(
        JSON.stringify({ ...capMaxTokens(prepared.body, maxTokens), model: plan.upstreamModel }),
      ),
      (reply) => {
        held.release();
        record.finish(reply);
      },
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
