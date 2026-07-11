// Bundled MCP bridge — the ONE place agency-lang touches the optional,
// separately-installed @agency-lang/mcp package.
//
// # Why a .mjs
//
// @agency-lang/mcp is NOT a dependency of agency-lang (it stays optional). A
// static `import ... from "@agency-lang/mcp"` in TS would (a) fail tsc
// resolution and (b) throw at load when the package is absent, taking the whole
// agent down. The fix is a dynamic `import()` — but CLAUDE.md bans dynamic
// import in TS. So the dynamic import is quarantined in this plain .mjs, which
// the Makefile copies into dist alongside the TS output and which lint does not
// cover. lib/stdlib/mcp.ts imports THIS module statically (it is always
// present) and never imports the package directly. Same pattern as
// lib/stdlib/providers/llama-cpp.mjs.
//
// # How load() resolves the package
//
// Two paths, checked in order:
//  1. AGENCY_MCP_PATH — an absolute path to the package entry. mcpResolver.ts
//     sets this (via exposeResolvedMcpPath) after locating the package, INCLUDING
//     in a global node_modules that a bare `import "@agency-lang/mcp"` from this
//     file could not reach. It is also the dev/test + advanced-install override.
//     We import it as a file URL.
//  2. Bare `import("@agency-lang/mcp")` — resolves when the package sits in a
//     node_modules Node can walk to from here (a normal project install).
//
// The resolved module is cached in `_mod` so repeat calls don't re-import.
// Callers gate on mcpResolver.isMcpAvailable() BEFORE calling in, so load() is
// only reached when the package is known to be resolvable; a stray failure
// still surfaces as a normal rejection the caller catches.
//
// # What it exposes
//
// Thin async pass-throughs to the package's real exports — mcpRaw,
// readMcpConfig, mcpToolToAgencyFunction, MCP_PACKAGE_VERSION. The shapes are
// pinned by mcpBridge.d.mts and guarded by mcpBridge.contract.test.ts so
// signature drift between this bridge and the package is caught, not silent.
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
