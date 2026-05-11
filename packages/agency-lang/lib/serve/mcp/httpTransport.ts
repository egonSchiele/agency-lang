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

const DEFAULT_PATH = "/mcp";

/**
 * Start an MCP server using the Streamable HTTP transport. The transport
 * is intentionally minimal:
 *   - POST {path} with a single JSON-RPC message → JSON response
 *   - GET/DELETE {path} → 405 (we have no server-initiated messages, so
 *     SSE streams and session lifecycle are not needed)
 *
 * Auth, host validation, body-size limits, and the no-key-on-non-loopback
 * guard are shared with the REST HTTP server via lib/serve/http/security.ts.
 */
export function startMcpHttpServer(config: McpHttpConfig): http.Server {
  const { handler, logger, port, apiKey } = config;
  const host = config.host ?? DEFAULT_HOST;
  const mcpPath = config.path ?? DEFAULT_PATH;
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
        ctx.sendJson(405, {
          error: `Method ${ctx.method} not allowed; use POST`,
        });
        return;
      }

      const body = await parseJsonBody(req);
      if (!isJsonRpcMessage(body)) {
        ctx.sendJson(400, { error: "Request body must be a JSON-RPC 2.0 message object" });
        return;
      }

      const response = await handler(body);
      // Notifications (no id) yield null; reply with 204 No Content.
      if (response === null) {
        ctx.sendJson(204, {});
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
