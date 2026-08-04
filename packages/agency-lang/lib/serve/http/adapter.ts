import http from "http";
import type { ExportedItem, ServedExportedItem, ServedExportedFunction, ServedExportedNode } from "../types.js";
import { errorMessage, toArgs, parseJsonBody } from "../util.js";
import { validateResumeBatch } from "../../runtime/interrupts.js";
import { readCause } from "../../runtime/errors.js";
import { formatBudgetExceeded } from "../../runtime/budgetExit.js";
import type {
  ServedInvocationOutcome,
  InvocationUsageSnapshot,
} from "../../runtime/invocationUsage.js";
import type { Logger } from "../../logger.js";
import {
  DEFAULT_HOST,
  defaultAllowedHosts,
  enforceNoKeyOnNonLoopback,
  logServerStart,
  makeGuardedRequestListener,
} from "./security.js";

/** PUBLIC config type (re-exported from `agency-lang/serve`) — kept
 *  byte-compatible with the pre-seam contract: raw `ExportedItem`s and a
 *  `respondToInterrupts` returning `Promise<unknown>`. Host apps that import
 *  this type keep type-checking. The adapters run on the internal
 *  `ServedHandlerConfig` below; `createServeHandler` builds that from a
 *  discovered module. */
export type HandlerConfig = {
  exports: ExportedItem[];
  logger: Logger;
  hasInterrupts: (data: unknown) => boolean;
  respondToInterrupts: (interrupts: unknown[], responses: unknown[]) => Promise<unknown>;
};

/** INTERNAL adapter config: the served contract the HTTP adapter actually runs
 *  on — usage-bearing `ServedExportedItem`s and a `respondToInterrupts` that
 *  returns a `ServedInvocationOutcome`. Not part of the public surface. */
type ServedHandlerConfig = {
  exports: ServedExportedItem[];
  logger: Logger;
  hasInterrupts: (data: unknown) => boolean;
  respondToInterrupts: (
    interrupts: unknown[],
    responses: unknown[],
  ) => Promise<ServedInvocationOutcome<unknown>>;
};

export type HttpConfig = ServedHandlerConfig & {
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
};

export type RouteResult = {
  status: number;
  body: unknown;
  /** Per-invocation usage for the serve cost seam, present on every
   *  post-execution outcome (success/interrupt/402/failure/cancel) and absent
   *  on pre-execution results (/list, 404, validation 400). Read in-process by
   *  the host (statelog); not part of the standalone HTTP body. */
  usage?: InvocationUsageSnapshot["usage"];
  usageComplete?: boolean;
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

/** A tripped ROOT budget is a spend/time stop, not a generic tool failure.
 *  Return a typed, structured result (HTTP 402) carrying the dimension, limit,
 *  and spend, so a caller and traces can tell it apart without string-matching
 *  the generic message. Unlike other errors, the budget numbers are safe to
 *  surface — they are the operator's own limit, not server internals. */
function budgetExceeded(cause: {
  dimension: "cost" | "time";
  limit: number;
  spent: number;
}): RouteResult {
  return {
    status: 402,
    body: {
      success: false,
      code: "budgetExceeded",
      error: formatBudgetExceeded(cause),
      dimension: cause.dimension,
      limit: cause.limit,
      spent: cause.spent,
    },
  };
}

/** Map a thrown error to a route result: a root-budget trip becomes a typed
 *  budgetExceeded (402); anything else is logged and returned as the generic
 *  tool error so no server detail leaks. Detection is by CAUSE (mirrors
 *  budgetExit), so it catches a root trip however it surfaced. */
function errorResult(err: unknown, logger: Logger, what: string): RouteResult {
  const cause = readCause(err);
  if (cause?.kind === "guardTrip") {
    logger.error(`${what}: ${formatBudgetExceeded(cause)}`);
    return budgetExceeded(cause);
  }
  logger.error(`${what} threw: ${errorMessage(err)}`);
  return fail(TOOL_ERROR_MESSAGE);
}

/** Attach a per-invocation usage snapshot to any post-execution route result. */
function withUsage(base: RouteResult, outcome: InvocationUsageSnapshot): RouteResult {
  return { ...base, usage: outcome.usage, usageComplete: outcome.usageComplete };
}

/** Map one served outcome to a route result: `renderReturned` shapes the success
 *  body (function → `ok`; node/resume → interrupt-aware), and a threw-outcome
 *  runs the existing 402/generic classification on the ORIGINAL error (identity
 *  preserved, so `readCause` still recognizes a guard trip). Usage is attached
 *  once, here, for every branch. */
function routeResultFor(
  outcome: ServedInvocationOutcome<unknown>,
  opts: { renderReturned: (value: unknown) => RouteResult; logger: Logger; what: string },
): RouteResult {
  const base =
    outcome.status === "returned"
      ? opts.renderReturned(outcome.value)
      : errorResult(outcome.error, opts.logger, opts.what);
  return withUsage(base, outcome);
}

async function callFunction(
  fn: ServedExportedFunction,
  body: unknown,
  logger: Logger,
): Promise<RouteResult> {
  let outcome: ServedInvocationOutcome<unknown>;
  try {
    outcome = await fn.invokeServed(toArgs(body));
  } catch (err) {
    // A throw here is a pre-outcome internal failure (the core normally converts
    // agent errors into a threw-outcome), so there is no usage to report.
    return errorResult(err, logger, `function ${fn.name}`);
  }
  return routeResultFor(outcome, { renderReturned: ok, logger, what: `function ${fn.name}` });
}

async function callNode(
  node: ServedExportedNode,
  body: unknown,
  hasInterrupts: (data: unknown) => boolean,
  logger: Logger,
): Promise<RouteResult> {
  let outcome: ServedInvocationOutcome<unknown>;
  try {
    // The node receives its named args as a data object; the serve invoker maps
    // them to the node's params and returns the caller-facing data as the value.
    outcome = await node.invokeServed(toArgs(body));
  } catch (err) {
    return errorResult(err, logger, `node ${node.name}`);
  }
  return routeResultFor(outcome, {
    renderReturned: (data) => (hasInterrupts(data) ? interruptResult(data) : ok(data)),
    logger,
    what: `node ${node.name}`,
  });
}

async function resumeInterrupts(
  respondToInterrupts: (i: unknown[], r: unknown[]) => Promise<ServedInvocationOutcome<unknown>>,
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
  const validationError = validateResumeBatch(interrupts, responses);
  if (validationError) {
    // Reject before any runtime code runs: a malformed response must never
    // reach the resume path, where an unknown type continues past the interrupt.
    return { status: 400, body: { error: validationError } };
  }
  let outcome: ServedInvocationOutcome<unknown>;
  try {
    outcome = await respondToInterrupts(interrupts, responses);
  } catch (err) {
    return errorResult(err, logger, "resume");
  }
  return routeResultFor(outcome, {
    renderReturned: (value) => {
      const data = (value as { data: unknown }).data;
      return hasInterrupts(data) ? interruptResult(data) : ok(data);
    },
    logger,
    what: "resume",
  });
}

const FUNCTION_ROUTE = /^\/function\/([^/]+)$/;
const NODE_ROUTE = /^\/node\/([^/]+)$/;

export function createHttpHandler(config: ServedHandlerConfig): (
  method: string,
  path: string,
  body: unknown,
) => Promise<RouteResult> {
  const { exports, hasInterrupts, respondToInterrupts, logger } = config;

  // Null-prototype maps: function/node names come from the request URL, so a
  // plain object would let a name like `/function/toString` resolve to an
  // inherited Object.prototype method, bypass the "unknown" 404 check, and
  // surface as a generic tool failure instead.
  const functions: Record<string, ServedExportedFunction> = Object.assign(
    Object.create(null),
    Object.fromEntries(
      exports.filter((e): e is ServedExportedFunction => e.kind === "function").map((e) => [e.name, e]),
    ),
  );
  const nodes: Record<string, ServedExportedNode> = Object.assign(
    Object.create(null),
    Object.fromEntries(
      exports.filter((e): e is ServedExportedNode => e.kind === "node").map((e) => [e.name, e]),
    ),
  );

  return async (method, path, body): Promise<RouteResult> => {
    if (method === "GET" && path === "/list") {
      return {
        status: 200,
        body: {
          functions: Object.values(functions).map((f) => ({
            name: f.name,
            description: f.description,
            parameters: f.parameters.map((p) => p.name),
            // Retry-safety markers, mirroring the MCP adapter's
            // destructiveHint/idempotentHint. Only the set marker appears.
            destructive: f.agencyFunction.markers?.destructive ?? false,
            idempotent: f.agencyFunction.markers?.idempotent ?? false,
            interruptEffects: f.interruptEffects.map((ik) => ik.effect),
          })),
          nodes: Object.values(nodes).map((n) => ({
            name: n.name,
            parameters: n.parameters.map((p) => p.name),
            interruptEffects: n.interruptEffects.map((ik) => ik.effect),
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

/**
 * Render a parameter list for display, e.g. `(name, count?, ...rest)`.
 * `?` marks params with a default (optional), `...` marks a variadic.
 * Returns "" when there are no params so the route prints bare.
 */
function describeParams(
  params: Array<{ name: string; hasDefault?: boolean; variadic?: boolean }>,
): string {
  if (params.length === 0) return "";
  const parts = params.map((p) => {
    const prefix = p.variadic ? "..." : "";
    const suffix = !p.variadic && p.hasDefault ? "?" : "";
    return `${prefix}${p.name}${suffix}`;
  });
  return ` (${parts.join(", ")})`;
}

/**
 * Log the routes the server exposes, one per line, e.g.
 *   POST  /function/greet (name)
 * so operators can see the available endpoints at a glance on startup.
 */
function logRoutes(config: HttpConfig): void {
  const { logger, exports } = config;

  type Route = { method: string; path: string; params: string };
  const routes: Route[] = [{ method: "GET", path: "/list", params: "" }];

  for (const item of exports) {
    if (item.kind === "function") {
      // Bound params are filled in at definition time and are not part of
      // the request body, so only the unbound params are caller-facing.
      const callerParams = item.agencyFunction.params.filter((p) => !p.isBound);
      routes.push({
        method: "POST",
        path: `/function/${item.name}`,
        params: describeParams(callerParams),
      });
    } else {
      routes.push({
        method: "POST",
        path: `/node/${item.name}`,
        params: describeParams(item.parameters),
      });
    }
  }

  routes.push({ method: "POST", path: "/resume", params: " (interrupts, responses)" });

  const methodWidth = Math.max(...routes.map((r) => r.method.length));
  logger.info("Routes:");
  for (const r of routes) {
    logger.info(`  ${r.method.padEnd(methodWidth)}  ${r.path}${r.params}`);
  }
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
    logRoutes(config);
  });

  return server;
}
