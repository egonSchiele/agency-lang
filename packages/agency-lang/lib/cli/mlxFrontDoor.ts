import * as http from "node:http";
import { notServedMessage } from "./localServe.js";

/** One mlx_lm.server process: the name requests use for it, the string it
 *  was started with (the request's `model` is rewritten to this, because the
 *  server loads whatever model a request names), and its port. */
export type Route = { model: string; upstreamModel: string; port: number };

export type FrontDoor = { port: number; close: () => Promise<void> };

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function error(res: http.ServerResponse, status: number, message: string): void {
  json(res, status, { error: { message } });
}

function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: Route,
  body: Buffer,
): void {
  const headers = { ...req.headers, "content-length": String(body.length) };
  const upstream = http.request(
    { host: "127.0.0.1", port: route.port, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) =>
    error(res, 502, `mlx_lm.server for ${route.model}: ${err.message}`),
  );
  upstream.end(body);
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
    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString("utf-8"));
    } catch {
      error(res, 400, "Request body is not JSON.");
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
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const bound = (server.address() as { port: number }).port;
      resolve({ port: bound, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
