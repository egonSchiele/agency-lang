import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import type { McpServerConfig } from "./types.js";

const McpStdioServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const McpHttpServerSchema = z
  .object({
    type: z.literal("http"),
    url: z.string(),
    auth: z.literal("oauth").optional(),
    authTimeout: z.number().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const McpServerSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);

const McpServersSchema = z
  .record(
    z
      .string()
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "MCP server names must contain only letters, numbers, hyphens, and underscores",
      ),
    McpServerSchema,
  )
  .superRefine((data, ctx) => {
    for (const [name, server] of Object.entries(data)) {
      if ("type" in server && server.type === "http") {
        const httpServer = server as z.infer<typeof McpHttpServerSchema>;
        if (httpServer.auth && httpServer.headers) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP server "${name}": cannot specify both 'auth' and 'headers'`,
            path: [name],
          });
        }
        if (httpServer.authTimeout && httpServer.auth !== "oauth") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP server "${name}": 'authTimeout' requires 'auth: "oauth"'`,
            path: [name],
          });
        }
        if (httpServer.clientId && httpServer.auth !== "oauth") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP server "${name}": 'clientId' requires 'auth: "oauth"'`,
            path: [name],
          });
        }
        if (httpServer.clientSecret && httpServer.auth !== "oauth") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MCP server "${name}": 'clientSecret' requires 'auth: "oauth"'`,
            path: [name],
          });
        }
        if (httpServer.auth === "oauth") {
          try {
            const parsed = new URL(httpServer.url);
            const isLocalhost = ["127.0.0.1", "localhost"].includes(parsed.hostname);
            if (parsed.protocol !== "https:" && !isLocalhost) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `MCP server "${name}": OAuth requires HTTPS (or localhost for development)`,
                path: [name, "url"],
              });
            }
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `MCP server "${name}": invalid URL "${httpServer.url}"`,
              path: [name, "url"],
            });
          }
        }
      }
    }
  });

function readAgencyJson(startDir: string): Record<string, any> | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, "agency.json");
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf-8"));
    } catch {
      // File doesn't exist or isn't valid JSON — try parent
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readMcpConfig(cwd?: string): Record<string, McpServerConfig> {
  const raw = readAgencyJson(cwd || process.cwd());
  if (!raw || !raw.mcpServers) return {};

  const result = McpServersSchema.parse(raw.mcpServers);
  return result as Record<string, McpServerConfig>;
}
