import http from "http";
import net from "net";
import { randomBytes } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { McpHttpServerConfig } from "../src/types.js";

/** A local OAuth authorization server and MCP server in one, for tests. */
export type FakeOAuthServer = {
  /** The MCP endpoint, for a server config's `url`. */
  mcpUrl: string;
  /** Make every access token given out so far stop working. */
  expireAccessTokens: () => void;
  /** From now on, answer every refresh with `invalid_grant`. */
  rejectRefreshTokens: () => void;
  /** How many refresh requests the token endpoint has answered. */
  refreshCount: () => number;
  close: () => Promise<void>;
};

export type FakeOAuthServerOptions = {
  /** Give out a new refresh token on each refresh and refuse the old one. Default false. */
  rotateRefreshTokens?: boolean;
  /** Hold each refresh response this long, so two refreshes overlap. Default 0. */
  refreshDelayMs?: number;
};

type ServerState = {
  origin: string;
  accessTokens: string[];
  refreshTokens: string[];
  refusingRefreshes: boolean;
  refreshes: number;
};

const newToken = (prefix: string): string => `${prefix}-${randomBytes(8).toString("hex")}`;

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function resourceMetadata(state: ServerState): unknown {
  return { resource: `${state.origin}/mcp`, authorization_servers: [state.origin] };
}

function authorizationServerMetadata(state: ServerState): unknown {
  return {
    issuer: state.origin,
    authorization_endpoint: `${state.origin}/authorize`,
    token_endpoint: `${state.origin}/token`,
    registration_endpoint: `${state.origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function giveLogin(state: ServerState): Record<string, unknown> {
  const access = newToken("access");
  const refresh = newToken("refresh");
  state.accessTokens.push(access);
  state.refreshTokens.push(refresh);
  return { access_token: access, token_type: "bearer", expires_in: 3600, refresh_token: refresh };
}

async function answerToken(
  state: ServerState,
  options: FakeOAuthServerOptions,
  form: URLSearchParams,
  res: http.ServerResponse,
): Promise<void> {
  if (form.get("grant_type") === "authorization_code") {
    sendJson(res, 200, giveLogin(state));
    return;
  }
  state.refreshes += 1;
  if (options.refreshDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs));
  }
  const refresh = form.get("refresh_token") ?? "";
  if (state.refusingRefreshes || !state.refreshTokens.includes(refresh)) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
    return;
  }
  const access = newToken("access");
  state.accessTokens.push(access);
  if (!options.rotateRefreshTokens) {
    sendJson(res, 200, { access_token: access, token_type: "bearer", expires_in: 3600, refresh_token: refresh });
    return;
  }
  const next = newToken("refresh");
  state.refreshTokens = state.refreshTokens.filter((token) => token !== refresh).concat(next);
  sendJson(res, 200, { access_token: access, token_type: "bearer", expires_in: 3600, refresh_token: next });
}

/** Serve one MCP request in stateless mode, with one tool, `add`. */
async function serveMcp(req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<void> {
  const server = new McpServer({ name: "fake-oauth-server", version: "1.0.0" });
  server.tool("add", "Add two numbers together", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, JSON.parse(body));
}

function hasCurrentToken(state: ServerState, req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  return token !== "" && state.accessTokens.includes(token);
}

async function route(
  state: ServerState,
  options: FakeOAuthServerOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const path = new URL(req.url ?? "/", state.origin).pathname;
  const body = await readBody(req);
  if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    sendJson(res, 200, resourceMetadata(state));
    return;
  }
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, authorizationServerMetadata(state));
    return;
  }
  if (req.method === "POST" && path === "/register") {
    sendJson(res, 201, { ...JSON.parse(body), client_id: newToken("client") });
    return;
  }
  if (req.method === "POST" && path === "/token") {
    await answerToken(state, options, new URLSearchParams(body), res);
    return;
  }
  if (path === "/mcp" && req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  if (path === "/mcp" && !hasCurrentToken(state, req)) {
    res.writeHead(401, {
      "WWW-Authenticate": `Bearer resource_metadata="${state.origin}/.well-known/oauth-protected-resource/mcp"`,
    });
    res.end();
    return;
  }
  if (path === "/mcp") {
    await serveMcp(req, res, body);
    return;
  }
  res.writeHead(404).end();
}

export async function startFakeOAuthServer(options: FakeOAuthServerOptions = {}): Promise<FakeOAuthServer> {
  const state: ServerState = {
    origin: "",
    accessTokens: [],
    refreshTokens: [],
    refusingRefreshes: false,
    refreshes: 0,
  };
  const server = http.createServer((req, res) => {
    route(state, options, req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "server_error", error_description: String(error) });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as net.AddressInfo;
  state.origin = `http://127.0.0.1:${address.port}`;
  return {
    mcpUrl: `${state.origin}/mcp`,
    expireAccessTokens: () => {
      state.accessTokens = [];
    },
    rejectRefreshTokens: () => {
      state.refusingRefreshes = true;
    },
    refreshCount: () => state.refreshes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing is listening on. Open a server on port 0, read its port, close it. */
export async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Do what the browser does at the end of a login: read `redirect_uri` and `state`
 *  from the login URL and request `<redirect_uri>?code=<code>&state=<state>`. */
export async function completeLogin(authUrl: string, code = "test-code"): Promise<Response> {
  const params = new URL(authUrl).searchParams;
  const callback = new URL(params.get("redirect_uri") ?? "");
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", params.get("state") ?? "");
  return fetch(callback);
}

/** A config for the fake server, as agency.json would hold it. */
export function oauthConfig(server: FakeOAuthServer, authTimeout?: number): McpHttpServerConfig {
  return {
    type: "http",
    url: server.mcpUrl,
    auth: "oauth",
    ...(authTimeout === undefined ? {} : { authTimeout }),
  };
}
