import http from "http";
import type { ExportedItem, ExportedFunction, ExportedNode } from "../types.js";
import { checkAuth } from "./auth.js";
import { errorMessage, toArgs, parseJsonBody } from "../util.js";
import type { Logger } from "../../logger.js";

export type HttpConfig = {
  exports: ExportedItem[];
  port: number;
  apiKey?: string;
  /** Interface to bind to. Default "127.0.0.1" (loopback only). */
  host?: string;
  /**
   * Allowed Host: header values (DNS-rebinding defense). If unset, defaults
   * are derived from `host`: loopback addresses are allowed, plus the
   * "localhost" hostname. For non-loopback hosts, callers must opt in
   * explicitly.
   */
  allowedHosts?: string[];
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

/**
 * Generic message returned to clients when an Agency function/node throws.
 * The full error is logged server-side but never sent to the client, to
 * avoid leaking secrets, file paths, model API responses, etc.
 */
const TOOL_ERROR_MESSAGE = "Tool execution failed";

async function callFunction(
  fn: ExportedFunction,
  body: unknown,
  logger: Logger,
): Promise<RouteResult> {
  try {
    const result = await fn.agencyFunction.invoke({
      type: "named",
      positionalArgs: [],
      namedArgs: toArgs(body),
    });
    return ok(result);
  } catch (err) {
    logger.error(`function ${fn.name} threw: ${errorMessage(err)}`);
    return fail(TOOL_ERROR_MESSAGE);
  }
}

async function callNode(
  node: ExportedNode,
  body: unknown,
  hasInterrupts: (data: unknown) => boolean,
  logger: Logger,
): Promise<RouteResult> {
  try {
    const args = toArgs(body);
    const positional = node.parameters.map((p) => args[p.name]);
    const result = (await node.invoke(...positional)) as { data: unknown };
    if (hasInterrupts(result.data)) return interruptResult(result.data);
    return ok(result.data);
  } catch (err) {
    logger.error(`node ${node.name} threw: ${errorMessage(err)}`);
    return fail(TOOL_ERROR_MESSAGE);
  }
}

async function resumeInterrupts(
  respondToInterrupts: (i: unknown[], r: unknown[]) => Promise<unknown>,
  hasInterrupts: (data: unknown) => boolean,
  body: unknown,
  logger: Logger,
): Promise<RouteResult> {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "Request body must be a JSON object" } };
  }
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
    logger.error(`resume threw: ${errorMessage(err)}`);
    return fail(TOOL_ERROR_MESSAGE);
  }
}

const FUNCTION_ROUTE = /^\/function\/([^/]+)$/;
const NODE_ROUTE = /^\/node\/([^/]+)$/;

export function createHttpHandler(config: HttpConfig): (
  method: string,
  path: string,
  body: unknown,
) => Promise<RouteResult> {
  const { exports, hasInterrupts, respondToInterrupts, logger } = config;

  const functions = Object.fromEntries(
    exports.filter((e): e is ExportedFunction => e.kind === "function").map((e) => [e.name, e]),
  );
  const nodes = Object.fromEntries(
    exports.filter((e): e is ExportedNode => e.kind === "node").map((e) => [e.name, e]),
  );

  return async (method, path, body): Promise<RouteResult> => {
    if (method === "GET" && path === "/list") {
      return {
        status: 200,
        body: {
          functions: Object.values(functions).map((f) => ({
            name: f.name,
            description: f.description,
            safe: f.agencyFunction.safe,
            interruptKinds: f.interruptKinds.map((ik) => ik.kind),
          })),
          nodes: Object.values(nodes).map((n) => ({
            name: n.name,
            parameters: n.parameters.map((p) => p.name),
            interruptKinds: n.interruptKinds.map((ik) => ik.kind),
          })),
        },
      };
    }

    if (method === "POST") {
      const functionMatch = path.match(FUNCTION_ROUTE);
      if (functionMatch) {
        const fn = functions[functionMatch[1]];
        if (!fn) return notFound(`Unknown function '${functionMatch[1]}'`);
        return callFunction(fn, body, logger);
      }

      const nodeMatch = path.match(NODE_ROUTE);
      if (nodeMatch) {
        const node = nodes[nodeMatch[1]];
        if (!node) return notFound(`Unknown node '${nodeMatch[1]}'`);
        return callNode(node, body, hasInterrupts, logger);
      }

      if (path === "/resume") {
        if (!respondToInterrupts) {
          return { status: 400, body: { error: "Module does not support interrupt resume" } };
        }
        return resumeInterrupts(respondToInterrupts, hasInterrupts, body, logger);
      }
    }

    return notFound("Not found");
  };
}

const DEFAULT_HOST = "127.0.0.1";
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host);
}

function defaultAllowedHosts(host: string): string[] {
  if (isLoopbackHost(host)) return ["localhost", "127.0.0.1", "[::1]"];
  // Non-loopback bind: only the exact bound host is allowed by default.
  return [host];
}

/**
 * Validate the Host header against an allowlist (DNS-rebinding defense).
 * Strips the port before comparison; matches case-insensitively.
 */
function isHostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (!hostHeader) return false;
  const hostOnly = stripPort(hostHeader).toLowerCase();
  return allowed.some((a) => a.toLowerCase() === hostOnly);
}

function stripPort(hostHeader: string): string {
  // IPv6 literal: "[::1]:3545" → "[::1]"
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const colon = hostHeader.indexOf(":");
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

export function startHttpServer(config: HttpConfig): http.Server {
  const handler = createHttpHandler(config);
  const { logger, port, apiKey } = config;
  const host = config.host ?? DEFAULT_HOST;
  const allowedHosts = config.allowedHosts ?? defaultAllowedHosts(host);

  if (!apiKey && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to start: no API key configured but bind host is "${host}" (non-loopback). ` +
      `Either configure an API key, or bind to 127.0.0.1.`,
    );
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0];
    const start = Date.now();

    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body) + "\n");
      logger.info(`${method} ${path} → ${status} (${Date.now() - start}ms)`);
    };

    // 1. Host header validation (DNS-rebinding defense). Done first so a
    //    rebinding attacker cannot reach any server logic, including auth.
    if (!isHostAllowed(req.headers.host, allowedHosts)) {
      sendJson(403, { error: "Forbidden host" });
      return;
    }

    // 2. Authentication. Done before body parsing so an unauthenticated
    //    client cannot force the server to buffer up to MAX_BODY_BYTES.
    if (!checkAuth(apiKey, req.headers.authorization)) {
      sendJson(401, { error: "Unauthorized" });
      return;
    }

    try {
      const body = method === "POST" ? await parseJsonBody(req) : undefined;
      const result = await handler(method, path, body);
      sendJson(result.status, result.body);
    } catch (err) {
      const msg = errorMessage(err);
      if (msg === "Invalid JSON body") {
        sendJson(400, { error: msg });
      } else if (msg === "Request body too large") {
        sendJson(413, { error: msg });
      } else {
        logger.error(`${method} ${path} → 500: ${msg}`);
        sendJson(500, { error: "Internal server error" });
      }
    }
  });

  server.listen(port, host, () => {
    const displayHost = host.includes(":") ? `[${host}]` : host;
    logger.info(`Agency HTTP server listening on http://${displayHost}:${port}`);
    if (!isLoopbackHost(host)) {
      logger.info(
        `WARNING: bound to ${host} (non-loopback). Server is reachable from the network.`,
      );
    }
    if (!apiKey) {
      logger.info(
        "WARNING: no API key configured. All requests are accepted without authentication.",
      );
    }
  });

  return server;
}
