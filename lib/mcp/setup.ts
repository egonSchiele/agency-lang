import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CodexMcpSetupResult {
  ok: boolean;
  configPath: string;
  message: string;
}

export function codexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function renderCodexMcpServerBlock(command: string[], serverName: string = "agency"): string {
  const [executable, ...args] = command;
  const lines = [
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(executable)}`,
  ];
  if (args.length > 0) {
    lines.push(`args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`);
  }
  return lines.join("\n");
}

function upsertTomlSection(content: string, header: string, block: string): string {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(`(^${escapedHeader}\\n[\\s\\S]*?)(?=^\\[[^\\n]+\\]\\n|$)`, "m");
  const normalized = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;

  if (sectionRegex.test(normalized)) {
    return normalized.replace(sectionRegex, `${block}\n`);
  }

  if (normalized.length === 0) {
    return `${block}\n`;
  }

  return `${normalized}\n${block}\n`;
}

export function setupCodexMcp(configPath: string, command: string[], serverName: string = "agency"): CodexMcpSetupResult {
  const header = `[mcp_servers.${serverName}]`;
  const block = renderCodexMcpServerBlock(command, serverName);
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
  const next = upsertTomlSection(current, header, block);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next, "utf-8");

  return {
    ok: true,
    configPath,
    message: `Updated ${configPath} with MCP server '${serverName}'`,
  };
}
