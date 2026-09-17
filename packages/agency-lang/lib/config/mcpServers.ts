import { z } from "zod";

// The `mcpServers` block of agency.json. @agency-lang/mcp imports this from
// agency-lang/config, so there is one copy.

export type McpStdioServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: "http";
  url: string;
  auth?: "oauth";
  authTimeout?: number;
  clientId?: string;
  clientSecret?: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export type McpServers = Record<string, McpServerConfig>;

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

type HttpServer = z.infer<typeof McpHttpServerSchema>;

type HttpServerRule = {
  broken: (server: HttpServer) => boolean;
  message: (server: HttpServer) => string;
  field?: string;
};

const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

function parsedUrl(url: string): URL | null {
  return URL.canParse(url) ? new URL(url) : null;
}

/** True for a URL that parses but is neither https nor a local host. */
function insecureRemote(url: string): boolean {
  const parsed = parsedUrl(url);
  if (parsed === null) {
    return false;
  }
  return parsed.protocol !== "https:" && !LOCAL_HOSTS.includes(parsed.hostname);
}

const usesOAuth = (server: HttpServer) => server.auth === "oauth";

const HTTP_SERVER_RULES: HttpServerRule[] = [
  {
    broken: (server) => Boolean(server.auth) && Boolean(server.headers),
    message: () => "cannot specify both 'auth' and 'headers'",
  },
  {
    broken: (server) => Boolean(server.authTimeout) && !usesOAuth(server),
    message: () => `'authTimeout' requires 'auth: "oauth"'`,
  },
  {
    broken: (server) => Boolean(server.clientId) && !usesOAuth(server),
    message: () => `'clientId' requires 'auth: "oauth"'`,
  },
  {
    broken: (server) => Boolean(server.clientSecret) && !usesOAuth(server),
    message: () => `'clientSecret' requires 'auth: "oauth"'`,
  },
  {
    broken: (server) => usesOAuth(server) && insecureRemote(server.url),
    message: () => "OAuth requires HTTPS (or localhost for development)",
    field: "url",
  },
  {
    broken: (server) => usesOAuth(server) && parsedUrl(server.url) === null,
    message: (server) => `invalid URL "${server.url}"`,
    field: "url",
  },
];

export const McpServersSchema = z
  .record(
    z
      .string()
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "MCP server names must contain only letters, numbers, hyphens, and underscores",
      ),
    McpServerSchema,
  )
  .superRefine((servers, ctx) => {
    for (const [name, server] of Object.entries(servers)) {
      if (!("type" in server)) {
        continue;
      }
      for (const rule of HTTP_SERVER_RULES.filter((candidate) => candidate.broken(server))) {
        ctx.addIssue({
          code: "custom",
          message: `MCP server "${name}": ${rule.message(server)}`,
          path: rule.field === undefined ? [name] : [name, rule.field],
        });
      }
    }
  });
