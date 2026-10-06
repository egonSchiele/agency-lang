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

export type FrontDoor = {
  port: number;
  /** Ends every request in progress on a model, and restarts its process
   *  when a cancelled request would otherwise keep running. Returns how
   *  many requests were ended. */
  cancel: (model: string) => Promise<number>;
  /** From now on, every request gets a 503. */
  refuseNew: () => void;
  close: () => Promise<void>;
};

/** One request from the moment its model is known until it ends.
 *
 *  upstream      the request to the model's process. Null while the
 *                request waits for its model to load
 *  stopsOnClose  whether closing `upstream` stops the process's work
 *  cancelled     set by `cancel`, so the handlers in `forward` write
 *                nothing more to a client that was already answered */
type InProgress = {
  res: http.ServerResponse;
  upstream: http.ClientRequest | null;
  stopsOnClose: boolean;
  cancelled: boolean;
};

/** The status for a request its server ended on someone else's behalf.
 *  nginx's code, since HTTP has none. */
const CLIENT_CLOSED_REQUEST = 499;
const UNSUPPORTED_MEDIA_TYPE = 415;
const SHUTTING_DOWN = 503;

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
  entry: InProgress,
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
    // A cancelled request was answered by `cancel`, and destroying its
    // upstream request is what raised this error.
    if (entry.cancelled) {
      finish(ownReply(CLIENT_CLOSED_REQUEST, JSON.stringify({ error: { message: "Cancelled" } })));
      return;
    }
    const message = `${held.plan.label}: ${err.message}`;
    error(res, 502, message);
    finish(ownReply(502, JSON.stringify({ error: { message } })));
  });
  entry.upstream = upstream;
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
  stopping: 503,
};

const FORBIDDEN_HOST = 403;

/** A route the door answers itself, about the server and not for a model.
 *  A POST route gets the request's JSON body. */
type AdminRoute = {
  method: "GET" | "POST";
  path: string;
  handle: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
};

/** Why a request to an admin route is refused, or null. The door listens
 *  on 127.0.0.1 only, but a web page can reach that address under a
 *  hostname of its own, and the browser then treats the page and the
 *  server as one site; such a request carries the page's hostname in
 *  `Host`. A page also cannot send `content-type: application/json`
 *  across sites without a preflight request, which the door never
 *  answers, so a POST must carry it. */
function adminRefusal(
  req: http.IncomingMessage,
  port: number,
): { status: number; message: string } | null {
  if (!isLocalHost(req.headers.host, port)) {
    return {
      status: FORBIDDEN_HOST,
      message: "This route answers requests made to 127.0.0.1 or localhost only.",
    };
  }
  if (req.method === "POST" && !/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    return {
      status: UNSUPPORTED_MEDIA_TYPE,
      message: "This route takes a JSON body, with content-type: application/json.",
    };
  }
  return null;
}

/** Ends a request on `cancel`'s behalf: a 499 if nothing was sent yet,
 *  otherwise the connection is cut. The request to the process is cut
 *  either way. */
function cancelRequest(entry: InProgress): void {
  entry.cancelled = true;
  if (entry.res.headersSent) {
    entry.res.destroy();
  } else {
    error(entry.res, CLIENT_CLOSED_REQUEST, "Cancelled");
  }
  entry.upstream?.destroy();
}

/** Whether a request's `Host` header names this server on this machine.
 *  The door listens on 127.0.0.1 only, but a web page can reach that
 *  address under a hostname of its own, and the browser then treats the
 *  page and the server as one site. Such a request carries the page's
 *  hostname here, and is refused. */
function isLocalHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Ends every request in progress on a model, and restarts its process
 *  when a cancelled request would otherwise keep it busy. Returns how many
 *  requests were ended. */
async function cancelOn(
  pool: ModelPool,
  inProgress: Record<string, InProgress[]>,
  model: string,
): Promise<number> {
  const entries = inProgress[model] ?? [];
  const plan = pool.plan(model);
  entries.forEach(cancelRequest);
  // A request that was sent to the process and that closing does not
  // stop keeps the process busy. The only way to stop it is to restart
  // the process. A lazy model is loaded again by its next request.
  const keepsRunning = entries.some((entry) => entry.upstream !== null && !entry.stopsOnClose);
  if (keepsRunning && plan !== undefined) {
    await pool.unload(model);
    if (!plan.lazy) {
      await pool.load(model);
    }
  }
  return entries.length;
}

/** The routes the door answers itself. */
function adminRoutesFor(
  pool: ModelPool,
  served: string[],
  cancel: (model: string) => Promise<number>,
  onShutdown: () => void,
): AdminRoute[] {
  return [
    {
      method: "POST",
      path: "/v1/agency/shutdown",
      handle: async () => {
        // Answered first, then the server closes; the caller gets its 200.
        setImmediate(onShutdown);
        return { status: 200, body: { shuttingDown: true } };
      },
    },
    {
      method: "GET",
      path: "/v1/models",
      handle: async () => ({
        status: 200,
        body: { object: "list", data: served.map((id) => ({ id, object: "model" })) },
      }),
    },
    {
      method: "GET",
      path: "/v1/agency/status",
      handle: async () => ({ status: 200, body: { models: pool.status() } }),
    },
    {
      method: "POST",
      path: "/v1/agency/cancel",
      handle: async (body) => {
        const model = typeof body.model === "string" ? body.model : "";
        if (pool.plan(model) === undefined) {
          return { status: 404, body: { error: { message: notServedMessage(served, model, "") } } };
        }
        return { status: 200, body: { cancelled: await cancel(model) } };
      },
    },
  ];
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
  onShutdown: () => void = () => {},
): Promise<FrontDoor> {
  const served = pool.models();
  /** The requests in progress, by model. */
  const inProgress: Record<string, InProgress[]> = Object.fromEntries(
    served.map((model) => [model, []]),
  );
  const cancel = (model: string) => cancelOn(pool, inProgress, model);
  const adminRoutes = adminRoutesFor(pool, served, cancel, onShutdown);
  let refusingNew = false;
  const server = http.createServer(async (req, res) => {
    const record = recorder(req, logging);
    const refuse = (status: number, message: string): void => {
      error(res, status, message);
      record.finish(ownReply(status, JSON.stringify({ error: { message } })));
    };
    if (refusingNew) {
      refuse(SHUTTING_DOWN, "This server is shutting down.");
      return;
    }
    const admin = adminRoutes.find((row) => row.method === req.method && row.path === req.url);
    if (admin !== undefined) {
      const boundPort = (server.address() as { port: number }).port;
      const refusal = admin.path.startsWith(AGENCY_ROUTES) ? adminRefusal(req, boundPort) : null;
      if (refusal !== null) {
        refuse(refusal.status, refusal.message);
        return;
      }
      const adminBody = admin.method === "POST" ? await readRequest(req, undefined) : { body: {} };
      if ("refusal" in adminBody) {
        refuse(adminBody.refusal.status, adminBody.refusal.message);
        return;
      }
      const reply = await admin.handle(adminBody.body);
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
    const entry: InProgress = {
      res,
      upstream: null,
      stopsOnClose: plan.stopsOnClose(prepared.body),
      cancelled: false,
    };
    inProgress[plan.model].push(entry);
    const done = (): void => {
      inProgress[plan.model] = inProgress[plan.model].filter((other) => other !== entry);
    };
    let held: Held;
    try {
      held = await pool.acquire(plan.model);
    } catch (err) {
      done();
      if (!(err instanceof PoolRefusal)) {
        throw err;
      }
      if (!entry.cancelled) {
        refuse(STATUS_FOR_REFUSAL[err.reason], err.message);
      }
      return;
    }
    if (clientGone || entry.cancelled) {
      held.release();
      done();
      return;
    }
    forward(
      req,
      res,
      held,
      Buffer.from(
        JSON.stringify({ ...capMaxTokens(prepared.body, maxTokens), model: plan.upstreamModel }),
      ),
      entry,
      (reply) => {
        held.release();
        done();
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
      resolve({
        port: bound,
        cancel,
        refuseNew: () => {
          refusingNew = true;
        },
        close,
      });
    });
  });
}
