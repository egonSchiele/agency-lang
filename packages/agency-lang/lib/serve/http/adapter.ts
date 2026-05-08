import http from "http";
import type { ExportedItem, ExportedFunction, ExportedNode } from "../types.js";
import { checkAuth } from "./auth.js";
import { errorMessage, toArgs, parseJsonBody } from "../util.js";
import type { Logger } from "../../logger.js";

export type HttpConfig = {
  exports: ExportedItem[];
  port: number;
  apiKey?: string;
  logger: Logger;
  hasInterrupts: (data: unknown) => boolean;
  respondToInterrupts: (interrupts: unknown[], responses: unknown[]) => Promise<unknown>;
};

type RouteResult = {
  status: number;
  body: unknown;
};

function ok(value: unknown): RouteResult {
  return { status: 200, body: { success: true, value } };
}

function fail(error: string): RouteResult {
  return { status: 200, body: { success: false, error } };
}

function notFound(error: string): RouteResult {
  return { status: 404, body: { error } };
}

function interruptResult(data: unknown): RouteResult {
  return ok({ interrupts: data, state: JSON.stringify(data) });
}

async function callFunction(fn: ExportedFunction, body: unknown): Promise<RouteResult> {
  try {
    const result = await fn.agencyFunction.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: toArgs(body),
    });
    return ok(result);
  } catch (err) {
    return fail(errorMessage(err));
  }
}

async function callNode(
  node: ExportedNode,
  body: unknown,
  hasInterrupts: (data: unknown) => boolean,
): Promise<RouteResult> {
  try {
    const result = (await node.invoke(toArgs(body))) as { data: unknown };
    if (hasInterrupts(result.data)) return interruptResult(result.data);
    return ok(result.data);
  } catch (err) {
    return fail(errorMessage(err));
  }
}

async function resumeInterrupts(
  respondToInterrupts: (i: unknown[], r: unknown[]) => Promise<unknown>,
  hasInterrupts: (data: unknown) => boolean,
  body: unknown,
): Promise<RouteResult> {
  const { interrupts, responses } = body as {
    interrupts: unknown[];
    responses: unknown[];
  };
  if (!Array.isArray(interrupts) || !Array.isArray(responses)) {
    return { status: 400, body: { error: "interrupts and responses must be arrays" } };
  }
  try {
    const result = (await respondToInterrupts(interrupts, responses)) as { data: unknown };
    if (hasInterrupts(result.data)) return interruptResult(result.data);
    return ok(result.data);
  } catch (err) {
    return fail(errorMessage(err));
  }
}

const FUNCTION_ROUTE = /^\/functions\/([^/]+)$/;
const NODE_ROUTE = /^\/nodes\/([^/]+)$/;

export function createHttpHandler(config: HttpConfig): (
  method: string,
  path: string,
  body: unknown,
  authHeader?: string,
) => Promise<RouteResult> {
  const { exports, apiKey, hasInterrupts, respondToInterrupts } = config;

  const functions = Object.fromEntries(
    exports.filter((e): e is ExportedFunction => e.kind === "function").map((e) => [e.name, e]),
  );
  const nodes = Object.fromEntries(
    exports.filter((e): e is ExportedNode => e.kind === "node").map((e) => [e.name, e]),
  );

  return async (method, path, body, authHeader): Promise<RouteResult> => {
    if (!checkAuth(apiKey, authHeader)) {
      return { status: 401, body: { error: "Unauthorized" } };
    }

    if (method === "GET" && path === "/list") {
      return {
        status: 200,
        body: {
          functions: Object.values(functions).map((f) => ({
            name: f.name,
            description: f.description,
            safe: f.agencyFunction.safe,
          })),
          nodes: Object.values(nodes).map((n) => ({
            name: n.name,
            parameters: n.parameters.map((p) => p.name),
          })),
        },
      };
    }

    if (method === "POST") {
      const functionMatch = path.match(FUNCTION_ROUTE);
      if (functionMatch) {
        const fn = functions[functionMatch[1]];
        if (!fn) return notFound(`Unknown function '${functionMatch[1]}'`);
        return callFunction(fn, body);
      }

      const nodeMatch = path.match(NODE_ROUTE);
      if (nodeMatch) {
        const node = nodes[nodeMatch[1]];
        if (!node) return notFound(`Unknown node '${nodeMatch[1]}'`);
        return callNode(node, body, hasInterrupts);
      }

      if (path === "/resume") {
        if (!respondToInterrupts) {
          return { status: 400, body: { error: "Module does not support interrupt resume" } };
        }
        return resumeInterrupts(respondToInterrupts, hasInterrupts, body);
      }
    }

    return notFound("Not found");
  };
}

export function startHttpServer(config: HttpConfig): http.Server {
  const handler = createHttpHandler(config);
  const { logger, port } = config;

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const authHeader = req.headers.authorization;

    try {
      const body = method === "POST" ? await parseJsonBody(req) : undefined;
      const result = await handler(method, path, body, authHeader);

      logger.info(`${method} ${path} → ${result.status}`);

      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      const msg = errorMessage(err);
      logger.error(`${method} ${path} → 500: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  server.listen(port, () => {
    logger.info(`Agency HTTP server listening on port ${port}`);
  });

  return server;
}
