import http from "http";
import type { ExportedItem, ExportedFunction, ExportedNode } from "../types.js";
import { errorMessage, toArgs, parseJsonBody } from "../util.js";
import type { Logger } from "../../logger.js";
import {
  DEFAULT_HOST,
  defaultAllowedHosts,
  enforceNoKeyOnNonLoopback,
  logServerStart,
  makeGuardedRequestListener,
} from "./security.js";

export type HttpConfig = {
  exports: ExportedItem[];
  port: number;
  apiKey?: string;
  /** Interface to bind to. Default "127.0.0.1" (loopback only). */
  host?: string;
  /**
   * Allowed Host: header values (DNS-rebinding defense). If unset, defaults
   * are derived from `host`: loopback binds get an allowlist of loopback
   * names. Non-loopback binds skip Host validation by default (the strict
   * API key requirement mitigates DNS rebinding there); pass an explicit
   * array to lock the server down to specific hostnames.
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

export function startHttpServer(config: HttpConfig): http.Server {
  const handler = createHttpHandler(config);
  const { logger, port, apiKey } = config;
  const host = config.host ?? DEFAULT_HOST;
  const allowedHosts = config.allowedHosts ?? defaultAllowedHosts(host);

  enforceNoKeyOnNonLoopback(host, apiKey);

  const listener = makeGuardedRequestListener({
    logger,
    apiKey,
    allowedHosts,
    inner: async (req, _res, ctx) => {
      const body = ctx.method === "POST" ? await parseJsonBody(req) : undefined;
      const result = await handler(ctx.method, ctx.path, body);
      ctx.sendJson(result.status, result.body);
    },
  });

  const server = http.createServer(listener);

  server.listen(port, host, () => {
    logServerStart(logger, "Agency HTTP server", host, port, apiKey);
  });

  return server;
}
