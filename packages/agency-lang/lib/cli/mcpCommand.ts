import * as os from "os";
import * as path from "path";
import type { AgencyConfig } from "@/config.js";
import {
  _validateMcpServers,
  _readMcpServersFromFile,
  _upsertMcpServerInFile,
  _removeMcpServerFromFile,
  type McpServers,
} from "@/stdlib/mcp.js";

/** Agent-home dir (where settings.json lives), mirroring the agent's resolution. */
function agentHome(): string {
  const override = process.env.AGENCY_AGENT_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), ".agency-agent");
}

type Scope = "project" | "global";

function scopeFile(scope: Scope): string {
  return scope === "global"
    ? path.join(agentHome(), "settings.json")
    : path.resolve(process.cwd(), "agency.json");
}

type Flags = {
  positionals: string[];
  command?: string;
  args?: string;
  url?: string;
  oauth: boolean;
  scope: Scope;
};

// Minimal flag parser. `--flag value` for string flags; `--oauth/--project/
// --global` are booleans. Default scope is project (spec).
function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positionals: [], oauth: false, scope: "project" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--oauth") {
      flags.oauth = true;
    } else if (a === "--global") {
      flags.scope = "global";
    } else if (a === "--project") {
      flags.scope = "project";
    } else if (a === "--command") {
      flags.command = argv[++i];
    } else if (a === "--args") {
      flags.args = argv[++i];
    } else if (a === "--url") {
      flags.url = argv[++i];
    } else if (a.startsWith("--")) {
      // Unknown flag — surface rather than silently ignore.
      flags.positionals.push(a);
    } else {
      flags.positionals.push(a);
    }
  }
  return flags;
}

function transportSummary(config: Record<string, unknown>): string {
  return config.type === "http" ? `http ${String(config.url)}` : `stdio ${String(config.command)}`;
}

async function add(f: Flags): Promise<number> {
  const name = f.positionals[1];
  if (!name) {
    console.error("Usage: agency agent mcp add <name> (--command <cmd> [--args a,b,c] | --url <url> [--oauth]) [--project|--global]");
    return 1;
  }
  let config: Record<string, unknown>;
  if (f.url) {
    config = { type: "http", url: f.url, ...(f.oauth ? { auth: "oauth" } : {}) };
  } else if (f.command) {
    config = { command: f.command, ...(f.args ? { args: f.args.split(",") } : {}) };
  } else {
    console.error(`mcp add "${name}": provide --command (stdio) or --url (http).`);
    return 1;
  }
  const check = await _validateMcpServers({ [name]: config } as McpServers);
  if (!check.ok) {
    console.error(`Invalid MCP server "${name}": ${check.error}`);
    return 1;
  }
  _upsertMcpServerInFile(scopeFile(f.scope), name, config);
  console.log(`Added MCP server "${name}" (${f.scope}).`);
  return 0;
}

function remove(f: Flags): number {
  const name = f.positionals[1];
  if (!name) {
    console.error("Usage: agency agent mcp remove <name> [--project|--global]");
    return 1;
  }
  const removed = _removeMcpServerFromFile(scopeFile(f.scope), name);
  console.log(removed ? `Removed MCP server "${name}" (${f.scope}).` : `No MCP server "${name}" in the ${f.scope} config.`);
  return removed ? 0 : 1;
}

function list(): number {
  const project = _readMcpServersFromFile(scopeFile("project"));
  const global = _readMcpServersFromFile(scopeFile("global"));
  const names = Array.from(new Set([...Object.keys(global), ...Object.keys(project)])).sort();
  if (names.length === 0) {
    console.log("No MCP servers configured. Add one with: agency agent mcp add <name> ...");
    return 0;
  }
  console.log("MCP servers:");
  for (const name of names) {
    // Project wins when both define it, matching how the agent loads them.
    const inProject = name in project;
    const source = inProject ? "project" : "global";
    const config = inProject ? project[name] : global[name];
    console.log(`  ${name} — ${transportSummary(config)} [${source}]`);
  }
  return 0;
}

/** `agency agent mcp <list|add|remove> …`. Returns an exit code. */
export async function mcpCommand(_config: AgencyConfig, args: string[]): Promise<number> {
  const sub = args[0];
  const f = parseFlags(args);
  if (sub === "list") {
    return list();
  }
  if (sub === "add") {
    return add(f);
  }
  if (sub === "remove") {
    return remove(f);
  }
  console.error("Usage: agency agent mcp <list|add|remove> …");
  return 1;
}
