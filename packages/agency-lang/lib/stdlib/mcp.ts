import * as mcpBridge from "./mcpBridge.mjs";
import { isMcpAvailable, exposeResolvedMcpPath } from "./mcpResolver.js";

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
