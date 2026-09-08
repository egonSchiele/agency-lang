import * as http from "node:http";
import { parseJsonBody } from "../serve/util.js";
import { notServedMessage } from "./localServe.js";

/** One mlx_lm.server process: the name requests use for it, the string it
 *  was started with (the request's `model` is rewritten to this, because the
 *  server loads whatever model a request names), and its port. */
export type Route = { model: string; upstreamModel: string; port: number };

export type FrontDoor = { port: number; close: () => Promise<void> };

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

function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: Route,
  body: Buffer,
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
      up.pipe(res);
      // The process died mid-reply: end our side too, or the client waits.
      up.on("close", () => {
        if (!up.complete) {
          res.destroy();
        }
      });
    },
  );
  upstream.on("error", (err) =>
    error(res, 502, `mlx_lm.server for ${route.model}: ${err.message}`),
  );
  // The client went away mid-reply: stop the generation instead of letting
  // it run to --max-tokens for nobody.
  res.on("close", () => {
    if (!res.writableFinished) {
      upstream.destroy();
    }
  });
  upstream.end(body);
}

async function readRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await parseJsonBody(req);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      error(res, 400, "Request body is not a JSON object.");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const message = (err as Error).message;
    error(res, message === "Request body too large" ? 413 : 400, `${message}.`);
    return null;
  }
}

/** Listen on `port` (0 for any) and forward each request to the route whose
 *  model matches the request body's `model`. A request for any other model
 *  gets a 404 and reaches no process. */
export function startFrontDoor(port: number, routes: Route[]): Promise<FrontDoor> {
  const served = routes.map((r) => r.model);
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      json(res, 200, { object: "list", data: served.map((id) => ({ id, object: "model" })) });
      return;
    }
    const parsed = await readRequest(req, res);
    if (parsed === null) {
      return;
    }
    if (typeof parsed.model !== "string") {
      error(
        res,
        400,
        `The request names no model. Set the model field to one of: ${served.join(", ")}.`,
      );
      return;
    }
    const model = parsed.model;
    const route = routes.find((r) => r.model === model);
    if (route === undefined) {
      error(res, 404, notServedMessage(served, model));
      return;
    }
    forward(
      req,
      res,
      route,
      Buffer.from(JSON.stringify({ ...parsed, model: route.upstreamModel })),
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
