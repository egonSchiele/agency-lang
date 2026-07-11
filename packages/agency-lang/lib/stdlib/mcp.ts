import * as fs from "fs";
import * as path from "path";
import * as mcpBridge from "./mcpBridge.mjs";
import { isMcpAvailable, exposeResolvedMcpPath } from "./mcpResolver.js";
import { gate } from "./mcpGate.js";
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

// ── Config management (mcp add/remove/list) ───────────────────────────────
// Scope-agnostic: callers pass the target file (project agency.json or the
// agent-home settings.json). The mcpServers block is read/written while every
// other top-level key is preserved.

export type McpValidation = { ok: boolean; error?: string };

/** Validate an mcpServers map through the package schema (no throw). Returns a
 *  clear "not installed" failure when the package is absent. */
export async function _validateMcpServers(servers: McpServers): Promise<McpValidation> {
  if (!isMcpAvailable()) {
    return { ok: false, error: "@agency-lang/mcp is not installed. Run: npm install @agency-lang/mcp" };
  }
  exposeResolvedMcpPath();
  return mcpBridge.validateMcpServers(servers);
}

function _readJsonFile(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function _writeJsonFile(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** The mcpServers map from a config file (any file with an `mcpServers` key). */
export function _readMcpServersFromFile(file: string): McpServers {
  const raw = _readJsonFile(file);
  const servers = raw.mcpServers;
  return servers && typeof servers === "object" ? (servers as McpServers) : {};
}

/** Add/overwrite one server in `file`, preserving all other top-level keys and
 *  using a null-prototype mcpServers map. Creates the file if absent. */
export function _upsertMcpServerInFile(file: string, name: string, config: McpServerConfig): void {
  const raw = _readJsonFile(file);
  const existing = (raw.mcpServers && typeof raw.mcpServers === "object"
    ? (raw.mcpServers as McpServers)
    : {}) as McpServers;
  raw.mcpServers = _mergeMcpServers(existing, { [name]: config });
  _writeJsonFile(file, raw);
}

export type ParsedMcpCommand = {
  sub: string;
  name: string;
  config: McpServerConfig | null;
  global: boolean;
  error: string | null;
};

/** Parse a `/mcp` REPL argument string (everything after `/mcp `), e.g.
 *  `add fs --command npx --args -y,x,/tmp` or `remove fs --global`. Assembles
 *  the stdio/http config for `add`. Returns `{ error }` on a usage problem. */
export function _parseMcpCommand(argstr: string): ParsedMcpCommand {
  const toks = argstr.trim().split(/\s+/).filter((t) => t.length > 0);
  const out: ParsedMcpCommand = { sub: toks[0] ?? "", name: "", config: null, global: false, error: null };
  let command: string | undefined;
  let args: string | undefined;
  let url: string | undefined;
  let oauth = false;
  const positionals: string[] = [];
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--oauth") {
      oauth = true;
    } else if (t === "--global") {
      out.global = true;
    } else if (t === "--project") {
      out.global = false;
    } else if (t === "--command") {
      command = toks[++i];
    } else if (t === "--args") {
      args = toks[++i];
    } else if (t === "--url") {
      url = toks[++i];
    } else {
      positionals.push(t);
    }
  }
  out.name = positionals[0] ?? "";
  if (out.sub === "add") {
    if (!out.name) {
      out.error = "usage: /mcp add <name> (--command <cmd> [--args a,b,c] | --url <url> [--oauth]) [--global]";
    } else if (url) {
      out.config = { type: "http", url, ...(oauth ? { auth: "oauth" } : {}) };
    } else if (command) {
      out.config = { command, ...(args ? { args: args.split(",") } : {}) };
    } else {
      out.error = `/mcp add "${out.name}": provide --command (stdio) or --url (http)`;
    }
  } else if (out.sub === "remove" && !out.name) {
    out.error = "usage: /mcp remove <name> [--global]";
  }
  return out;
}

/** Drop the tools belonging to `server` (module `mcp:<server>`) from a tool
 *  list — used by `/mcp remove` to update the live session. */
export function _dropMcpToolsForServer(tools: AgencyFunction[], server: string): AgencyFunction[] {
  const mod = `mcp:${server}`;
  return tools.filter((t) => t.module !== mod);
}

/** Validate `config` then write it to `file`. Returns the validation result;
 *  writes nothing on failure. */
export async function _addMcpServer(
  name: string,
  config: McpServerConfig,
  file: string,
): Promise<McpValidation> {
  const check = await _validateMcpServers({ [name]: config });
  if (!check.ok) {
    return check;
  }
  _upsertMcpServerInFile(file, name, config);
  return { ok: true };
}

/** Remove one server from `file`. Returns whether it existed; writes only if
 *  something changed. */
export function _removeMcpServerFromFile(file: string, name: string): boolean {
  const raw = _readJsonFile(file);
  const existing = raw.mcpServers;
  if (!existing || typeof existing !== "object" || !(name in (existing as McpServers))) {
    return false;
  }
  const next: McpServers = Object.create(null);
  for (const key of Object.keys(existing as McpServers)) {
    if (key !== name) {
      next[key] = (existing as McpServers)[key];
    }
  }
  raw.mcpServers = next;
  _writeJsonFile(file, raw);
  return true;
}
