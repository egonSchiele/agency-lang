// The agency-lang/config entry point, used by @agency-lang/mcp.
export {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  findProjectRoot,
  projectTarget,
  readConfig,
  type ConfigTarget,
} from "./target.js";
export {
  McpServersSchema,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpServers,
  type McpStdioServerConfig,
} from "./mcpServers.js";
