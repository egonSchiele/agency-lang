import {
  McpServersSchema,
  findProjectRoot,
  projectTarget,
  readConfig,
  type McpServers,
} from "agency-lang/config";
import { success, failure, type ResultValue } from "agency-lang/runtime";

/** The mcpServers of the nearest project, with agency.local.json merged over
 *  agency.json. Throws when either file is invalid. */
export function readMcpConfig(cwd?: string): McpServers {
  const root = findProjectRoot(cwd || process.cwd());
  if (root === null) {
    return {};
  }
  const { config, error } = readConfig(projectTarget(root));
  if (error !== undefined) {
    throw new Error(error);
  }
  return config.mcpServers ?? {};
}

/** Validate an `mcpServers` map without throwing. Returns a `success()` Result
 *  when valid, or a `failure()` whose error joins the zod issues. Used by
 *  `mcp add` to reject a bad server before it is written to a config file. */
export function validateMcpServers(servers: Record<string, unknown>): ResultValue {
  const result = McpServersSchema.safeParse(servers);
  if (result.success) {
    return success(null);
  }
  const error = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return failure(error);
}
