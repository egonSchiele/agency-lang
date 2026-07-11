import * as fs from "fs";
import * as path from "path";
import * as mcpBridge from "./mcpBridge.mjs";
import { isMcpAvailable, exposeResolvedMcpPath } from "./mcpResolver.js";
import { gate } from "./mcpGate.js";
import { success, failure, isFailure, type ResultValue } from "../runtime/index.js";
import type { AgencyFunction } from "../runtime/agencyFunction.js";

// Local structural types. Do NOT `import type … from "@agency-lang/mcp"`: the
// package is an optional, uninstalled dependency, so a build-time import (even
// type-only) fails to resolve under pnpm (TS2307) and breaks the "non-dependency"
// precedent localModels.ts follows. Only `.name` is used off a tool.
type McpServerConfig = Record<string, unknown>;
type McpTool = { name: string };
export type McpServers = Record<string, McpServerConfig>;

export function _isMcpAvailable(): boolean {
  return isMcpAvailable();
}

/** Read the project agency.json mcpServers block. Hardened: readMcpConfig uses
 *  zod .parse which THROWS on a malformed block, and an Agency `catch` only
 *  intercepts Failure Results (not thrown JS), so a bad agency.json would crash
 *  startup. We swallow to {} with a warning instead. */
export async function _readProjectMcpConfig(cwd: string): Promise<Record<string, unknown>> {
  if (!isMcpAvailable()) {
    return {};
  }
  exposeResolvedMcpPath();
  try {
    return await mcpBridge.readProjectMcpConfig(cwd);
  } catch (error) {
    console.warn(
      `[mcp] ignoring malformed mcpServers in agency.json: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

export type McpLoadResult = {
  tools: AgencyFunction[];
  // Per-server outcome for `/mcp`: "connected" when its tools loaded,
  // "unavailable" when it failed to connect or returned nothing.
  status: Record<string, string>;
};

/** Project wins over global on name collision. Merges into a NULL-PROTOTYPE
 *  target: server names are user-controlled (agency.json / settings.json), and
 *  a key like "__proto__" — which the config schema's name regex permits —
 *  must become a plain data key, never mutate a prototype. */
export function _mergeMcpServers(global: McpServers, project: McpServers): McpServers {
  const out: McpServers = Object.create(null);
  for (const key of Object.keys(global)) {
    out[key] = global[key];
  }
  for (const key of Object.keys(project)) {
    out[key] = project[key];
  }
  return out;
}

async function _mcpCompatible(): Promise<boolean> {
  try {
    const v = await mcpBridge.packageVersion();
    return typeof v === "string" && v.length > 0;
  } catch {
    return false;
  }
}

export async function _loadMcpToolsForServer(
  server: string,
  merged: McpServers,
  onOAuthRequired?: (d: unknown) => void | Promise<void>,
): Promise<AgencyFunction[]> {
  // Absent-safe on its own (the Task 8 integration test calls this directly):
  // guard availability and catch a thrown bridge import so a missing package or
  // a spawn failure degrades to [] rather than propagating.
  if (!isMcpAvailable()) {
    return [];
  }
  exposeResolvedMcpPath();
  let res: mcpBridge.McpRawResultValue;
  try {
    res = await mcpBridge.mcpRaw(server, { config: merged, onOAuthRequired });
  } catch (error) {
    console.warn(
      `[mcp] server "${server}" failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  if (!res.success || !res.value) {
    console.warn(`[mcp] server "${server}" unavailable: ${String(res.error)}`);
    return [];
  }
  const { tools, callTool } = res.value;
  const gated = gate(callTool);
  return Promise.all(
    tools.map((tool: McpTool) =>
      mcpBridge.mcpToolToAgencyFunction(tool, gated) as Promise<AgencyFunction>,
    ),
  );
}

/** Load every configured server and report per-server status. Returns flat
 *  tools plus a { server -> "connected" | "unavailable" } map for `/mcp`. */
export async function _loadMcpToolsWithStatus(
  merged: McpServers,
  onOAuthRequired?: (d: unknown) => void | Promise<void>,
): Promise<McpLoadResult> {
  const empty: McpLoadResult = { tools: [], status: {} };
  if (!isMcpAvailable()) {
    return empty;
  }
  if (!(await _mcpCompatible())) {
    console.warn("[mcp] @agency-lang/mcp version could not be verified; skipping MCP tools.");
    return empty;
  }
  exposeResolvedMcpPath();
  const names = Object.keys(merged);
  if (names.length === 0) {
    return empty;
  }
  // Prime the package's singleton on the FIRST server sequentially (its manager
  // creation is not concurrency-safe), then load the rest in parallel. getTools
  // is per-server guarded, so parallel connects to distinct servers are safe.
  const [first, ...rest] = names;
  const firstTools = await _loadMcpToolsForServer(first, merged, onOAuthRequired);
  const restPairs = await Promise.all(
    rest.map(async (s) => ({ server: s, tools: await _loadMcpToolsForServer(s, merged, onOAuthRequired) })),
  );
  const pairs = [{ server: first, tools: firstTools }, ...restPairs];
  const tools: AgencyFunction[] = [];
  const status: Record<string, string> = {};
  for (const pair of pairs) {
    status[pair.server] = pair.tools.length > 0 ? "connected" : "unavailable";
    tools.push(...pair.tools);
  }
  return { tools, status };
}

export async function _loadMcpTools(
  merged: McpServers,
  onOAuthRequired?: (d: unknown) => void | Promise<void>,
): Promise<AgencyFunction[]> {
  return (await _loadMcpToolsWithStatus(merged, onOAuthRequired)).tools;
}

// ── Config management (used by the `agency mcp` CLI) ───────────────────────
// Scope-agnostic "how": callers pass the target file (project agency.json or
// the agent-home settings.json). Every helper returns an Agency Result and the
// mcpServers block is read/written while all other top-level keys are preserved.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serversOf(raw: Record<string, unknown>): McpServers {
  return isPlainObject(raw.mcpServers) ? (raw.mcpServers as McpServers) : {};
}

/** Validate an mcpServers map through the package schema. success() when valid,
 *  failure(message) otherwise — including a clear message when the package is
 *  absent or too old to expose the validator. */
export async function _validateMcpServers(servers: McpServers): Promise<ResultValue> {
  if (!isMcpAvailable()) {
    return failure("@agency-lang/mcp is not installed. Run: npm install @agency-lang/mcp");
  }
  exposeResolvedMcpPath();
  try {
    return await mcpBridge.validateMcpServers(servers);
  } catch (error) {
    return failure(
      `@agency-lang/mcp could not validate the config (upgrade the package?): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read a config file's top-level object. `null` when absent. failure() when it
 *  exists but is unreadable / not valid JSON / not a JSON object — so the
 *  add/remove writers never clobber a file they could not fully parse. */
function readConfigObject(file: string): ResultValue {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return success(null);
    }
    return failure(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure(`${file} is not valid JSON — fix it before editing servers (nothing was written)`);
  }
  if (!isPlainObject(parsed)) {
    return failure(`${file} is not a JSON object (nothing was written)`);
  }
  return success(parsed);
}

function writeConfigObject(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** The mcpServers map from a config file. Lenient: a missing or unparseable
 *  file reads as no servers (used by `list`, which must never crash). */
export function _readMcpServersFromFile(file: string): McpServers {
  const read = readConfigObject(file);
  if (isFailure(read) || read.value === null) {
    return {};
  }
  return serversOf(read.value as Record<string, unknown>);
}

/** Validate `config`, then add/overwrite it in `file`, preserving every other
 *  top-level key (null-prototype servers map). Creates the file if absent;
 *  never overwrites an existing-but-unparseable file. */
export async function _addMcpServer(
  name: string,
  config: McpServerConfig,
  file: string,
): Promise<ResultValue> {
  const valid = await _validateMcpServers({ [name]: config });
  if (isFailure(valid)) {
    return valid;
  }
  const read = readConfigObject(file);
  if (isFailure(read)) {
    return read;
  }
  const raw = (read.value ?? {}) as Record<string, unknown>;
  raw.mcpServers = _mergeMcpServers(serversOf(raw), { [name]: config });
  try {
    writeConfigObject(file, raw);
  } catch (error) {
    return failure(`cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return success(null);
}

/** Remove one server from `file`. success(true) if it existed and was removed,
 *  success(false) if it was not present, failure() if the file is unparseable. */
export async function _removeMcpServer(name: string, file: string): Promise<ResultValue> {
  const read = readConfigObject(file);
  if (isFailure(read)) {
    return read;
  }
  if (read.value === null) {
    return success(false);
  }
  const raw = read.value as Record<string, unknown>;
  const servers = serversOf(raw);
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    return success(false);
  }
  const next: McpServers = Object.create(null);
  for (const key of Object.keys(servers)) {
    if (key !== name) {
      next[key] = servers[key];
    }
  }
  raw.mcpServers = next;
  try {
    writeConfigObject(file, raw);
  } catch (error) {
    return failure(`cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return success(true);
}
