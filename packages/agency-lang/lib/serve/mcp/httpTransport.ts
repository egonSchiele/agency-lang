import http from "http";
import type { Logger } from "../../logger.js";
import {
  DEFAULT_HOST,
  defaultAllowedHosts,
  enforceNoKeyOnNonLoopback,
  logServerStart,
  makeGuardedRequestListener,
  parseJsonBody,
} from "../http/security.js";
import type { JsonRpcMessage, McpHandler } from "./adapter.js";

export const DEFAULT_MCP_PATH = "/mcp";
export const DEFAULT_MCP_PORT = 3545;

export type McpHttpConfig = {
  /** JSON-RPC handler returned by createMcpHandler. */
  handler: McpHandler;
  port: number;
  /** Interface to bind to. Default "127.0.0.1" (loopback only). */
  host?: string;
  /** Path the MCP endpoint is mounted at. Default "/mcp". */
  path?: string;
  apiKey?: string;
  /**
   * Allowed Host: header values (DNS-rebinding defense). If unset, defaults
   * follow the same rules as the REST adapter (loopback addresses for
   * loopback bind; skipped for non-loopback bind, where the mandatory API
   * key handles security).
   */
  allowedHosts?: string[];
  logger: Logger;
};

/**
 * Start an MCP server using the Streamable HTTP transport. The transport
 * is intentionally minimal:
 *   - POST {path} with a single JSON-RPC message → JSON response
 *   - POST {path} with a JSON-RPC batch (array) → array of responses, or
 *     202 No Content if every message in the batch is a notification
 *   - GET/DELETE {path} → 405 with `Allow: POST` (we have no
 *     server-initiated messages, so SSE streams and session lifecycle are
 *     not needed)
 *
 * Auth, host validation, body-size limits, and the no-key-on-non-loopback
 * guard are shared with the REST HTTP server via lib/serve/http/security.ts.
 */
export function startMcpHttpServer(config: McpHttpConfig): http.Server {
  const { handler, logger, port, apiKey } = config;
  const host = config.host ?? DEFAULT_HOST;
  const mcpPath = config.path ?? DEFAULT_MCP_PATH;
  const allowedHosts = config.allowedHosts ?? defaultAllowedHosts(host);

  enforceNoKeyOnNonLoopback(host, apiKey);

  const listener = makeGuardedRequestListener({
    logger,
    apiKey,
    allowedHosts,
    inner: async (req, _res, ctx) => {
      if (ctx.path !== mcpPath) {
        ctx.sendJson(404, { error: "Not found" });
        return;
      }

      if (ctx.method !== "POST") {
        ctx.sendStatus(405, { Allow: "POST" });
        return;
      }

      const body = await parseJsonBody(req);

      // JSON-RPC 2.0 batch: array of messages → array of responses.
      // Empty arrays are explicitly invalid per the spec.
      if (Array.isArray(body)) {
        if (body.length === 0) {
          ctx.sendJson(400, { error: "JSON-RPC batch must not be empty" });
          return;
        }
        if (!body.every(isJsonRpcMessage)) {
          ctx.sendJson(400, {
            error: "Every entry of a JSON-RPC batch must be a JSON-RPC 2.0 message object",
          });
          return;
        }
        const responses = (await Promise.all(body.map(handler))).filter(
          (r): r is JsonRpcMessage => r !== null,
        );
        // All notifications → no response per JSON-RPC 2.0 §6 ("nothing
        // SHOULD be returned"). Use 202 with no body — 204 is the wrong
        // status (server *did* process the request, just has nothing to
        // return) and "{}" would violate RFC 9110 for both 202 and 204.
        if (responses.length === 0) {
          ctx.sendStatus(202);
          return;
        }
        ctx.sendJson(200, responses);
        return;
      }

      if (!isJsonRpcMessage(body)) {
        ctx.sendJson(400, {
          error: "Request body must be a JSON-RPC 2.0 message object or batch array",
        });
        return;
      }

      const response = await handler(body);
      // Notification (no id) → no response. 202 with no body, same as
      // the all-notifications batch case above.
      if (response === null) {
        ctx.sendStatus(202);
        return;
      }
      ctx.sendJson(200, response);
    },
  });

  const server = http.createServer(listener);

  server.listen(port, host, () => {
    logServerStart(logger, `Agency MCP HTTP server (path: ${mcpPath})`, host, port, apiKey);
  });

  return server;
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
