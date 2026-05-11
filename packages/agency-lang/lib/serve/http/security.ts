/**
 * Shared HTTP security helpers used by both the REST adapter and the MCP
 * Streamable HTTP transport. Keeping them in one place avoids drift between
 * the two servers (e.g., one being upgraded with a new defense and the
 * other forgotten).
 */
import http from "http";
import type { Logger } from "../../logger.js";
import { checkAuth } from "./auth.js";
import { errorMessage, parseJsonBody } from "../util.js";

export const DEFAULT_HOST = "127.0.0.1";

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host);
}

export function defaultAllowedHosts(host: string): string[] | undefined {
  if (isLoopbackHost(host)) return ["localhost", "127.0.0.1", "[::1]"];
  // Non-loopback bind: skip Host validation by default. The mandatory API
  // key (enforced by enforceNoKeyOnNonLoopback) is what mitigates DNS
  // rebinding in this case. Operators can still pass an explicit
  // `allowedHosts` to lock things down.
  return undefined;
}

/**
 * Validate the Host header against an allowlist (DNS-rebinding defense).
 * Strips the port before comparison; matches case-insensitively. If
 * `allowed` is undefined, validation is skipped.
 */
export function isHostAllowed(
  hostHeader: string | undefined,
  allowed: string[] | undefined,
): boolean {
  if (allowed === undefined) return true;
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

/**
 * Throws if no API key is configured but the bind host is non-loopback.
 * Call this before binding to surface the misconfiguration as early as
 * possible — startup time, not first request.
 */
export function enforceNoKeyOnNonLoopback(host: string, apiKey: string | undefined): void {
  if (!apiKey && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to start: no API key configured but bind host is "${host}" (non-loopback). ` +
      `Either configure an API key, or bind to 127.0.0.1.`,
    );
  }
}

/**
 * Logs the standard "listening on …" message plus warnings about
 * non-loopback bind and missing API key.
 */
export function logServerStart(
  logger: Logger,
  serverLabel: string,
  host: string,
  port: number,
  apiKey: string | undefined,
): void {
  const displayHost = host.includes(":") ? `[${host}]` : host;
  logger.info(`${serverLabel} listening on http://${displayHost}:${port}`);
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
}

export type GuardedRequestContext = {
  method: string;
  path: string;
  start: number;
  sendJson: (status: number, body: unknown) => void;
  /**
   * Send an empty-body response (e.g. 202, 204, 405). Use this instead of
   * `sendJson` when the HTTP status forbids a body or when extra headers
   * (such as `Allow:` on a 405) need to be set without a JSON envelope.
   */
  sendStatus: (status: number, headers?: Record<string, string>) => void;
};

/**
 * Wraps an http.Server request handler with the standard pipeline:
 * 1. Host header validation (403 on mismatch)
 * 2. Authentication (401 on mismatch)
 * 3. Standard error envelope for body-parse errors / 500s
 *
 * The inner handler is only invoked once host + auth have passed.
 */
export function makeGuardedRequestListener(opts: {
  logger: Logger;
  apiKey: string | undefined;
  allowedHosts: string[] | undefined;
  /** Inner handler invoked after host + auth have passed. */
  inner: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: GuardedRequestContext,
  ) => Promise<void>;
}): http.RequestListener {
  const { logger, apiKey, allowedHosts, inner } = opts;
  return async (req, res) => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0];
    const start = Date.now();

    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body) + "\n");
      logger.info(`${method} ${path} → ${status} (${Date.now() - start}ms)`);
    };

    const sendStatus = (status: number, headers: Record<string, string> = {}) => {
      res.writeHead(status, headers);
      res.end();
      logger.info(`${method} ${path} → ${status} (${Date.now() - start}ms)`);
    };

    if (!isHostAllowed(req.headers.host, allowedHosts)) {
      sendJson(403, { error: "Forbidden host" });
      return;
    }

    if (!checkAuth(apiKey, req.headers.authorization)) {
      sendJson(401, { error: "Unauthorized" });
      return;
    }

    try {
      await inner(req, res, { method, path, start, sendJson, sendStatus });
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
  };
}

// Re-export parseJsonBody so transport modules don't need a second import.
export { parseJsonBody };
