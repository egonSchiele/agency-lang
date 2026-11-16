// A stand-in for @agency-lang/mcp 0.0.6, loaded through AGENCY_MCP_PATH by
// the /mcp menu tests. A server's behavior comes from its config:
//   { command: "ok" }                          connects with one tool, <name>__echo
//   { command: "missing" }                     fails with "spawn missing ENOENT"
//   { type: "http", url: ..., auth: "oauth" }  needs a login until one finishes
// A login finishes with no browser. The records live in module state, as the
// real package's manager is one per process.
import { AgencyFunction } from "agency-lang/runtime";

export const MCP_PACKAGE_VERSION = "0.0.6";

let config = {};
let records = {};
let loggedIn = [];
let pendingLogin = null;

const callTool = async (server, tool) => `${server}/${tool}`;

function connectedState(name) {
  const tool = {
    name: `${name}__echo`,
    description: "Echo the call.\nA second line.",
    serverName: name,
    inputSchema: { type: "object", properties: {} },
    __mcpTool: true,
  };
  return { status: "connected", tools: [tool], callTool };
}

function stateFor(name) {
  const server = config[name];
  if (server === undefined) {
    return { status: "failed", message: `MCP server "${name}" is not in the config` };
  }
  if (server.auth === "oauth") {
    return loggedIn.includes(name) ? connectedState(name) : { status: "needsLogin" };
  }
  if (server.command === "ok") {
    return connectedState(name);
  }
  return { status: "failed", message: `spawn ${server.command} ENOENT` };
}

export async function connectServer(name, options) {
  config = options.config;
  records[name] = stateFor(name);
  return records[name];
}

export async function serverStates() {
  return { ...records };
}

export async function startLogin(name, options) {
  config = options.config;
  if (config[name]?.auth !== "oauth") {
    return { status: "failed", message: `${name} is not an OAuth server` };
  }
  pendingLogin = name;
  return { status: "started", authUrl: `https://login.example/authorize?server=${name}` };
}

export async function finishLogin(name) {
  if (pendingLogin !== name) {
    return { status: "failed", message: `no login in progress for ${name}` };
  }
  pendingLogin = null;
  loggedIn = loggedIn.filter((n) => n !== name).concat(name);
  records[name] = stateFor(name);
  return records[name];
}

export async function cancelLogin(name) {
  if (pendingLogin === name) {
    pendingLogin = null;
  }
}

export async function logout(name) {
  loggedIn = loggedIn.filter((n) => n !== name);
  records[name] = { status: "needsLogin" };
  return { status: "loggedOut" };
}

export async function disconnectServer(name) {
  delete records[name];
}

export async function configureServers(options) {
  config = options.config;
}

export async function pendingServers() {
  const pending = {};
  for (const [name, server] of Object.entries(config)) {
    if (!(name in records)) {
      pending[name] = server;
    }
  }
  return pending;
}

export async function markServerFailed(name, message) {
  records[name] = { status: "failed", message };
}

export async function mcpRaw() {
  return { success: false, error: "mcpRaw is not part of the fake package" };
}

export function readMcpConfig() {
  return {};
}

export async function validateMcpServers() {
  return { success: true, value: null };
}

export function mcpToolToAgencyFunction(tool, call) {
  const originalName = tool.name.slice(`${tool.serverName}__`.length);
  return new AgencyFunction({
    name: tool.name,
    module: `mcp:${tool.serverName}`,
    fn: async () => call(tool.serverName, originalName, {}),
    params: [],
    toolDefinition: {
      name: tool.name,
      description: tool.description,
      schema: { ...tool.inputSchema, toJSONSchema: () => tool.inputSchema },
    },
  });
}
