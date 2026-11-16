import { createRequire } from "node:module";
import { McpManager, type ServerRecord } from "./mcpManager.js";
import { mcpToolToAgencyFunction } from "./toolAdapter.js";
import { readMcpConfig } from "./configReader.js";
import type { McpServerConfig, McpTool } from "./types.js";
import { success, failure, registerGlobalHook, type ResultValue } from "agency-lang/runtime";

let singleton: McpManager | null = null;
let cleanupRegistered = false;
let registeredCallback: ((data: any) => void | Promise<void>) | undefined;

export type McpRawOptions = {
  config?: Record<string, McpServerConfig>;
  onOAuthRequired?: (data: any) => void | Promise<void>;
};

export type McpRawResult = {
  tools: McpTool[];
  callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
};

function getManager(
  onOAuthRequired?: (data: any) => void | Promise<void>,
  config?: Record<string, McpServerConfig>,
): McpManager {
  // The manager is a process-wide singleton built on the FIRST call. A call
  // that passes a `config` replaces the stored one; a call without one leaves
  // it alone. `onOAuthRequired` is first-caller-wins, so a different later
  // callback is ignored with a warning.
  if (!singleton) {
    const resolved = config ?? readMcpConfig();
    if (onOAuthRequired) registeredCallback = onOAuthRequired;
    singleton = new McpManager(resolved, { onOAuthRequired });
    if (!cleanupRegistered) {
      cleanupRegistered = true;
      registerGlobalHook("onAgentEnd", async () => {
        if (singleton) {
          await singleton.disconnectAll();
          singleton = null;
        }
      });
    }
  } else {
    if (config) {
      singleton.setConfig(config);
    }
    if (onOAuthRequired && onOAuthRequired !== registeredCallback) {
      console.warn(
        "[mcp] onOAuthRequired callback was already set on the first mcp() call and cannot be changed. The callback passed here will be ignored.",
      );
    }
  }
  return singleton;
}

export async function mcp(
  serverName: string,
  onOAuthRequired?: (data: any) => void | Promise<void>,
): Promise<ResultValue> {
  let manager: McpManager;
  try {
    manager = getManager(onOAuthRequired);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
  }

  let result: ResultValue;
  try {
    result = await manager.getTools(serverName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
  }

  if (!result.success) {
    return result;
  }

  const tools = result.value;
  const agencyFunctions = tools.map((tool: any) =>
    mcpToolToAgencyFunction(tool, (sn, tn, args) =>
      manager.callTool(sn, tn, args),
    ),
  );

  return success(agencyFunctions);
}

export async function mcpRaw(
  serverName: string,
  options?: McpRawOptions,
): Promise<ResultValue> {
  let manager: McpManager;
  try {
    manager = getManager(options?.onOAuthRequired, options?.config);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  let result: ResultValue;
  try {
    result = await manager.getTools(serverName);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  if (!result.success) {
    return result;
  }
  const value: McpRawResult = {
    tools: result.value,
    callTool: (server, tool, args) => manager.callTool(server, tool, args),
  };
  return success(value);
}

export type CallTool = (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;

/** A server's state, as the 0.0.6 exports return it. */
export type ServerState =
  | { status: "connected"; tools: McpTool[]; callTool: CallTool }
  | { status: "needsLogin" }
  | { status: "failed"; message: string };

export type ConfigOption = { config: Record<string, McpServerConfig> };

type Failed = { status: "failed"; message: string };
type LoginStarted = { status: "started"; authUrl: string };
type LoggedOut = { status: "loggedOut" };

const failed = (message: string): Failed => ({ status: "failed", message });

/** Run `action`. If it throws, log the error and return `onError(message)`. */
async function orElse<T>(what: string, action: () => Promise<T>, onError: (message: string) => T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp] ${what} failed: ${message}`);
    return onError(message);
  }
}

function toServerState(manager: McpManager, record: ServerRecord): ServerState {
  if (record.status !== "connected") {
    return record;
  }
  return { ...record, callTool: (server, tool, args) => manager.callTool(server, tool, args) };
}

/** The manager, with `serverName`'s entry taken from `config`. The other
 *  servers' entries stay as they were, so connecting one server never drops
 *  the rest of the config. configureServers replaces the whole config. */
function managerWithServer(serverName: string, config: Record<string, McpServerConfig>): McpManager {
  if (singleton === null) {
    return getManager(undefined, config);
  }
  singleton.setServerConfig(serverName, config[serverName]);
  return singleton;
}

/** Connect one server. Never starts a login: a server that needs one comes
 *  back as `needsLogin`. */
export function connectServer(serverName: string, options: ConfigOption): Promise<ServerState> {
  return orElse(
    `connect "${serverName}"`,
    async () => {
      const manager = managerWithServer(serverName, options.config);
      return toServerState(manager, await manager.connectServer(serverName));
    },
    failed,
  );
}

/** Every server's state, without connecting anything. */
export async function serverStates(): Promise<Record<string, ServerState>> {
  const manager = singleton;
  if (manager === null) {
    return {};
  }
  const states: Record<string, ServerState> = {};
  for (const [name, record] of Object.entries(manager.records())) {
    states[name] = toServerState(manager, record);
  }
  return states;
}

/** Start a login and return the login page URL, without waiting for it. Any
 *  login in progress, for any server, is cancelled first. */
export function startLogin(serverName: string, options: ConfigOption): Promise<LoginStarted | Failed> {
  return orElse<LoginStarted | Failed>(
    `start a login for "${serverName}"`,
    async () => ({
      status: "started",
      authUrl: await managerWithServer(serverName, options.config).startLogin(serverName),
    }),
    failed,
  );
}

/** Wait for the login startLogin began, then connect with it. */
export function finishLogin(serverName: string): Promise<ServerState> {
  return orElse(
    `finish the login for "${serverName}"`,
    async () => {
      const manager = singleton;
      if (manager === null) {
        throw new Error(`no login in progress for ${serverName}`);
      }
      return toServerState(manager, await manager.finishLogin(serverName));
    },
    failed,
  );
}

export function cancelLogin(serverName: string): Promise<void> {
  return orElse(
    `cancel the login for "${serverName}"`,
    async () => {
      await singleton?.cancelLogin(serverName);
    },
    () => undefined,
  );
}

/** Delete the saved login and disconnect. Keeps the registration. */
export function logout(serverName: string): Promise<LoggedOut | Failed> {
  return orElse<LoggedOut | Failed>(
    `log out of "${serverName}"`,
    async () => {
      await getManager().logout(serverName);
      return { status: "loggedOut" };
    },
    failed,
  );
}

export function disconnectServer(serverName: string): Promise<void> {
  return orElse(
    `disconnect "${serverName}"`,
    async () => {
      await singleton?.disconnectServer(serverName);
    },
    () => undefined,
  );
}

/** Store the server config without connecting anything. A caller that must
 *  ask before it connects stores the config early and connects later. */
export function configureServers(options: ConfigOption): void {
  getManager(undefined, options.config);
}

/** The configured servers that have no state yet, with their configs. */
export async function pendingServers(): Promise<Record<string, McpServerConfig>> {
  return singleton?.pendingServers() ?? {};
}

/** Record a server as failed without connecting, for example when starting
 *  it was not approved. */
export function markServerFailed(serverName: string, message: string): Promise<void> {
  return orElse(
    `mark "${serverName}" as failed`,
    async () => {
      await getManager().markFailed(serverName, message);
    },
    () => undefined,
  );
}

export { readMcpConfig, validateMcpServers } from "./configReader.js";
export { mcpToolToAgencyFunction } from "./toolAdapter.js";

export const MCP_PACKAGE_VERSION: string = (() => {
  // Resolve the package.json from BOTH src/mcp.ts (../package.json, vitest) and
  // the built dist/src/mcp.js (../../package.json). Try nearest-first.
  const require = createRequire(import.meta.url);
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const version = require(rel).version;
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return "0.0.0";
})();

export type { McpTool, McpServerConfig } from "./types.js";
