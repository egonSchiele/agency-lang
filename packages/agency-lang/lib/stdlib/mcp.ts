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

/** Project wins over global on name collision. */
export function _mergeMcpServers(global: McpServers, project: McpServers): McpServers {
  return { ...global, ...project };
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

export async function _loadMcpTools(
  merged: McpServers,
  onOAuthRequired?: (d: unknown) => void | Promise<void>,
): Promise<AgencyFunction[]> {
  if (!isMcpAvailable()) {
    return [];
  }
  if (!(await _mcpCompatible())) {
    console.warn("[mcp] @agency-lang/mcp version could not be verified; skipping MCP tools.");
    return [];
  }
  exposeResolvedMcpPath();
  const names = Object.keys(merged);
  if (names.length === 0) {
    return [];
  }
  // Prime the package's singleton on the FIRST server sequentially (its manager
  // creation is not concurrency-safe), then load the rest in parallel. getTools
  // is per-server guarded, so parallel connects to distinct servers are safe.
  const [first, ...rest] = names;
  const firstTools = await _loadMcpToolsForServer(first, merged, onOAuthRequired);
  const restTools = await Promise.all(
    rest.map((s) => _loadMcpToolsForServer(s, merged, onOAuthRequired)),
  );
  return [firstTools, ...restTools].flat();
}
