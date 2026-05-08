import http from "http";
import type { ExportedItem } from "../types.js";
import { checkAuth } from "./auth.js";
import type { Logger } from "../../logger.js";

export type HttpConfig = {
  exports: ExportedItem[];
  port: number;
  apiKey?: string;
  logger: Logger;
  moduleExports: Record<string, unknown>;
};

type RouteResult = {
  status: number;
  body: unknown;
};

export function createHttpHandler(config: HttpConfig): (
  method: string,
  path: string,
  body: unknown,
  authHeader?: string,
) => Promise<RouteResult> {
  const { exports, apiKey, moduleExports } = config;

  const itemsByName: Record<string, ExportedItem> = {};
  for (const item of exports) {
    itemsByName[item.name] = item;
  }

  const hasInterrupts = moduleExports.hasInterrupts as (data: unknown) => boolean;
  const respondToInterrupts = moduleExports.respondToInterrupts as (
    interrupts: unknown[],
    responses: unknown[],
  ) => Promise<unknown>;

  return async (
    method: string,
    path: string,
    body: unknown,
    authHeader?: string,
  ): Promise<RouteResult> => {
    if (!checkAuth(apiKey, authHeader)) {
      return { status: 401, body: { error: "Unauthorized" } };
    }

    if (method === "GET" && path === "/list") {
      return {
        status: 200,
        body: {
          functions: exports
            .filter((e) => e.kind === "function")
            .map((e) => ({
              name: e.name,
              description: e.kind === "function" ? e.description : undefined,
              safe: e.kind === "function" ? e.agencyFunction.safe : undefined,
            })),
          nodes: exports
            .filter((e) => e.kind === "node")
            .map((e) => ({
              name: e.name,
              parameters:
                e.kind === "node" ? e.parameters.map((p) => p.name) : [],
            })),
        },
      };
    }

    if (method === "POST") {
      const functionMatch = path.match(/^\/functions\/([^/]+)$/);
      if (functionMatch) {
        const name = functionMatch[1];
        const item = itemsByName[name];
        if (!item || item.kind !== "function") {
          return { status: 404, body: { error: `Unknown function '${name}'` } };
        }
        try {
          const args = (body as Record<string, unknown>) ?? {};
          const result = await item.agencyFunction.invoke({
            type: "named",
            positionalArgs: [],
            namedArgs: args,
          });
          return { status: 200, body: { success: true, value: result } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { status: 200, body: { success: false, error: msg } };
        }
      }

      const nodeMatch = path.match(/^\/nodes\/([^/]+)$/);
      if (nodeMatch) {
        const name = nodeMatch[1];
        const item = itemsByName[name];
        if (!item || item.kind !== "node") {
          return { status: 404, body: { error: `Unknown node '${name}'` } };
        }
        try {
          const args = (body as Record<string, unknown>) ?? {};
          const result = (await item.invoke(args)) as {
            data: unknown;
            messages: unknown;
          };
          if (hasInterrupts && hasInterrupts(result.data)) {
            return {
              status: 200,
              body: {
                success: true,
                value: {
                  interrupts: result.data,
                  state: JSON.stringify(result.data),
                },
              },
            };
          }
          return { status: 200, body: { success: true, value: result.data } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { status: 200, body: { success: false, error: msg } };
        }
      }

      if (path === "/resume") {
        if (!respondToInterrupts) {
          return {
            status: 400,
            body: { error: "Module does not support interrupt resume" },
          };
        }
        try {
          const { interrupts, responses } = body as {
            interrupts: unknown[];
            responses: unknown[];
          };
          if (!Array.isArray(interrupts) || !Array.isArray(responses)) {
            return {
              status: 400,
              body: { error: "interrupts and responses must be arrays" },
            };
          }
          const result = (await respondToInterrupts(interrupts, responses)) as {
            data: unknown;
          };
          if (hasInterrupts && hasInterrupts(result.data)) {
            return {
              status: 200,
              body: {
                success: true,
                value: {
                  interrupts: result.data,
                  state: JSON.stringify(result.data),
                },
              },
            };
          }
          return { status: 200, body: { success: true, value: result.data } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { status: 200, body: { success: false, error: msg } };
        }
      }
    }

    return { status: 404, body: { error: "Not found" } };
  };
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function startHttpServer(config: HttpConfig): http.Server {
  const handler = createHttpHandler(config);
  const { logger, port } = config;

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const authHeader = req.headers.authorization;

    try {
      const body = method === "POST" ? await parseBody(req) : undefined;
      const result = await handler(method, path, body, authHeader);

      logger.info(`${method} ${path} → ${result.status}`);

      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
