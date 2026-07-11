// Bundled MCP bridge. Statically imported by lib/stdlib/mcp.ts, but its own
// import of the optional @agency-lang/mcp package is dynamic and lives here — a
// plain .mjs shipped via the Makefile copy, outside TS lint — so the package
// stays a non-dependency (mirrors lib/stdlib/providers/llama-cpp.mjs).
// mcpResolver.ts exposes the resolved entry via AGENCY_MCP_PATH so a global
// install works even when the bare specifier is not resolvable from here.
import { pathToFileURL } from "node:url";

let _mod = null;

async function load() {
  if (_mod) {
    return _mod;
  }
  const pkgPath = process.env.AGENCY_MCP_PATH;
  _mod = pkgPath
    ? await import(pathToFileURL(pkgPath).href)
    : await import("@agency-lang/mcp");
  return _mod;
}

export async function mcpRaw(serverName, options) {
  return (await load()).mcpRaw(serverName, options);
}

export async function readProjectMcpConfig(cwd) {
  return (await load()).readMcpConfig(cwd);
}

export async function mcpToolToAgencyFunction(tool, callTool) {
  return (await load()).mcpToolToAgencyFunction(tool, callTool);
}

export async function packageVersion() {
  return (await load()).MCP_PACKAGE_VERSION;
}
