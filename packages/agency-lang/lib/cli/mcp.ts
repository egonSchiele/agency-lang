import * as path from "path";
import { isFailure } from "@/runtime/index.js";
import { agentHomeDir } from "@/runtime/agentHome.js";
import { projectTarget, readConfig, writeTarget, type ConfigTarget } from "@/configTarget.js";
import type { McpServers } from "@/mcpServers.js";
import {
  _addMcpServer,
  _removeMcpServer,
  _readMcpServersFromFile,
  type RawMcpServers,
} from "@/stdlib/mcp.js";

// The "what" for `agency mcp …`. Commander does the parsing; these thin actions
// call the config core ("how") in std/mcp and print. The project scope is a
// ConfigTarget; --global is the agent-home settings.json.

export type McpScope = { global?: boolean };

const globalFile = (): string => path.join(agentHomeDir(), "settings.json");
const currentProject = (): ConfigTarget => projectTarget(process.cwd());

const scopeFile = (scope: McpScope, target: ConfigTarget): string =>
  scope.global ? globalFile() : writeTarget(target);
const scopeName = (scope: McpScope): string => (scope.global ? "global" : "project");

/** An error message when --global and -c both name a file. */
function scopeConflict(scope: McpScope, target: ConfigTarget): string | null {
  const bothNamed = scope.global === true && target.kind === "file";
  return bothNamed ? "--global and -c name different config files. Pass only one of them." : null;
}

/** The project's servers, as Agency will load them. */
function projectServers(target: ConfigTarget): McpServers {
  const { config, error } = readConfig(target);
  if (error !== undefined) {
    console.error(error);
  }
  return config.mcpServers ?? {};
}

function transportSummary(config: unknown): string {
  const c = config as { type?: string; url?: string; command?: string };
  return c?.type === "http" ? `http ${c.url}` : `stdio ${c?.command}`;
}

export type McpAddOptions = McpScope & {
  command?: string;
  args?: string;
  url?: string;
  oauth?: boolean;
};

export async function mcpAdd(
  name: string,
  opts: McpAddOptions,
  target: ConfigTarget = currentProject(),
): Promise<number> {
  const conflict = scopeConflict(opts, target);
  if (conflict !== null) {
    console.error(conflict);
    return 1;
  }
  let config: Record<string, unknown>;
  if (opts.url) {
    config = { type: "http", url: opts.url, ...(opts.oauth ? { auth: "oauth" } : {}) };
  } else if (opts.command) {
    config = { command: opts.command, ...(opts.args ? { args: opts.args.split(",") } : {}) };
  } else {
    console.error(`mcp add "${name}": provide --command (stdio) or --url (http).`);
    return 1;
  }
  const result = await _addMcpServer(name, config, scopeFile(opts, target));
  if (isFailure(result)) {
    console.error(`Could not add "${name}": ${result.error}`);
    return 1;
  }
  console.log(`Added MCP server "${name}" (${scopeName(opts)}).`);
  return 0;
}

export async function mcpRemove(
  name: string,
  opts: McpScope,
  target: ConfigTarget = currentProject(),
): Promise<number> {
  const conflict = scopeConflict(opts, target);
  if (conflict !== null) {
    console.error(conflict);
    return 1;
  }
  const result = await _removeMcpServer(name, scopeFile(opts, target));
  if (isFailure(result)) {
    console.error(result.error);
    return 1;
  }
  if (result.value) {
    console.log(`Removed MCP server "${name}" (${scopeName(opts)}).`);
    return 0;
  }
  console.log(`No MCP server "${name}" in the ${scopeName(opts)} config.`);
  return 1;
}

export function mcpList(target: ConfigTarget = currentProject()): number {
  const project: RawMcpServers = projectServers(target);
  const global = _readMcpServersFromFile(globalFile());
  const names = Array.from(new Set([...Object.keys(global), ...Object.keys(project)])).sort();
  if (names.length === 0) {
    console.log("No MCP servers configured. Add one with: agency mcp add <name> …");
    return 0;
  }
  console.log("MCP servers:");
  for (const name of names) {
    // Project wins when both define it, matching how the agent loads them.
    const inProject = Object.prototype.hasOwnProperty.call(project, name);
    const config = inProject ? project[name] : global[name];
    console.log(`  ${name} — ${transportSummary(config)} [${inProject ? "project" : "global"}]`);
  }
  return 0;
}
