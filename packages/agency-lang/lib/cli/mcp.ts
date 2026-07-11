import * as os from "os";
import * as path from "path";
import { isFailure } from "@/runtime/index.js";
import { _addMcpServer, _removeMcpServer, _readMcpServersFromFile } from "@/stdlib/mcp.js";

// The "what" for `agency mcp …`. Commander does the parsing; these thin actions
// call the config core ("how") in std/mcp and print. Scope defaults to the
// project agency.json; --global targets the agent-home settings.json.

type ScopeOpts = { global?: boolean };

function agentHome(): string {
  const override = process.env.AGENCY_AGENT_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), ".agency-agent");
}

const projectFile = (): string => path.resolve(process.cwd(), "agency.json");
const globalFile = (): string => path.join(agentHome(), "settings.json");

const scopeFile = (o: ScopeOpts): string => (o.global ? globalFile() : projectFile());
const scopeName = (o: ScopeOpts): string => (o.global ? "global" : "project");

function transportSummary(config: unknown): string {
  const c = config as { type?: string; url?: string; command?: string };
  return c?.type === "http" ? `http ${c.url}` : `stdio ${c?.command}`;
}

export type McpAddOptions = ScopeOpts & {
  command?: string;
  args?: string;
  url?: string;
  oauth?: boolean;
};

export async function mcpAdd(name: string, opts: McpAddOptions): Promise<number> {
  let config: Record<string, unknown>;
  if (opts.url) {
    config = { type: "http", url: opts.url, ...(opts.oauth ? { auth: "oauth" } : {}) };
  } else if (opts.command) {
    config = { command: opts.command, ...(opts.args ? { args: opts.args.split(",") } : {}) };
  } else {
    console.error(`mcp add "${name}": provide --command (stdio) or --url (http).`);
    return 1;
  }
  const result = await _addMcpServer(name, config, scopeFile(opts));
  if (isFailure(result)) {
    console.error(`Could not add "${name}": ${result.error}`);
    return 1;
  }
  console.log(`Added MCP server "${name}" (${scopeName(opts)}).`);
  return 0;
}

export async function mcpRemove(name: string, opts: ScopeOpts): Promise<number> {
  const result = await _removeMcpServer(name, scopeFile(opts));
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

export function mcpList(): number {
  const project = _readMcpServersFromFile(projectFile());
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
