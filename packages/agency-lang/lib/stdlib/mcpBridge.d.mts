// Type declarations for the .mjs MCP bridge. The bridge dynamically imports the
// optional @agency-lang/mcp package, so its values are typed structurally here
// (the package's own types are not a build-time dependency of agency-lang).

export type McpRawResultValue = {
  success: boolean;
  value?: { tools: { name: string }[]; callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<string> };
  error?: unknown;
};

export function mcpRaw(
  serverName: string,
  options?: { config?: Record<string, unknown>; onOAuthRequired?: (data: unknown) => void | Promise<void> },
): Promise<McpRawResultValue>;

export function readProjectMcpConfig(cwd: string): Promise<Record<string, unknown>>;

export function mcpToolToAgencyFunction(
  tool: { name: string },
  callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>,
): Promise<unknown>;

export function packageVersion(): Promise<string>;

import type { ResultValue } from "../runtime/index.js";

export function validateMcpServers(
  servers: Record<string, unknown>,
): Promise<ResultValue>;

export type BridgeCallTool = (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;

export type BridgeServerState =
  | { status: "connected"; tools: { name: string; description?: string }[]; callTool: BridgeCallTool }
  | { status: "needsLogin" }
  | { status: "failed"; message: string };

type ConfigOption = { config: Record<string, unknown> };
type BridgeFailed = { status: "failed"; message: string };

export function connectServer(serverName: string, options: ConfigOption): Promise<BridgeServerState>;
export function serverStates(): Promise<Record<string, BridgeServerState>>;
export function startLogin(
  serverName: string,
  options: ConfigOption,
): Promise<{ status: "started"; authUrl: string } | BridgeFailed>;
export function finishLogin(serverName: string): Promise<BridgeServerState>;
export function cancelLogin(serverName: string): Promise<void>;
export function logout(serverName: string): Promise<{ status: "loggedOut" } | BridgeFailed>;
export function disconnectServer(serverName: string): Promise<void>;
