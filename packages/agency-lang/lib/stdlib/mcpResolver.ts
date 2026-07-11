import { createRequire } from "node:module";
import * as path from "path";
import { globalNodeModulesRoots } from "./localModels.js";

const PKG = "@agency-lang/mcp";

/** Resolve @agency-lang/mcp to the absolute path of its main entry, searching:
 *  an explicit AGENCY_MCP_PATH override first (dev/test + advanced installs),
 *  then local require paths, then each global node_modules root (npm i -g /
 *  pnpm add -g). Null if not reachable. Resolution only — never imports the
 *  package (that is the bridge's job). The override mirrors llama-cpp's
 *  AGENCY_SMOLTALK_LLAMA_CPP_PATH escape hatch; agency-lang does not depend on
 *  the package, so it is NOT resolvable from a monorepo checkout without it. */
export function resolveMcpEntry(): string | null {
  const override = process.env.AGENCY_MCP_PATH;
  if (override) {
    return override;
  }
  try {
    return createRequire(import.meta.url).resolve(PKG);
  } catch {
    /* not local — try global roots */
  }
  for (const root of globalNodeModulesRoots()) {
    try {
      return createRequire(path.join(root, "..", "_resolver.js")).resolve(PKG);
    } catch {
      /* try the next root */
    }
  }
  return null;
}

export function isMcpAvailable(): boolean {
  return resolveMcpEntry() !== null;
}

/** Expose the resolved entry to mcpBridge.mjs via AGENCY_MCP_PATH so the bridge
 *  can import it even from a global node_modules. Idempotent. */
export function exposeResolvedMcpPath(): void {
  if (process.env.AGENCY_MCP_PATH) {
    return;
  }
  const entry = resolveMcpEntry();
  if (entry !== null) {
    process.env.AGENCY_MCP_PATH = entry;
  }
}
