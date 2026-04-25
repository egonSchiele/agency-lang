import * as fs from "fs";
import * as path from "path";

export const SUPPORTED_AGENT_LSP_TARGETS = [
  "claude-code",
  "codex",
  "opencode",
  "pi",
] as const;

export type AgentLspTarget = typeof SUPPORTED_AGENT_LSP_TARGETS[number];

export interface AgentLspSetupResult {
  target: AgentLspTarget;
  ok: boolean;
  files: string[];
  message: string;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function writeJsonFile(filePath: string, value: Record<string, unknown>): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function setupOpenCode(projectDir: string): AgentLspSetupResult {
  const configPath = path.join(projectDir, "opencode.json");
  const config = readJsonFile(configPath);
  const lsp = config.lsp && typeof config.lsp === "object" && !Array.isArray(config.lsp)
    ? config.lsp as Record<string, unknown>
    : {};

  lsp.agency = {
    command: ["agency", "lsp"],
    extensions: [".agency"],
  };

  const nextConfig: Record<string, unknown> = { ...config, lsp };
  if (nextConfig.$schema === undefined) {
    nextConfig.$schema = "https://opencode.ai/config.json";
  }

  writeJsonFile(configPath, nextConfig);

  return {
    target: "opencode",
    ok: true,
    files: [configPath],
    message: `Updated ${configPath}`,
  };
}

function setupClaudeCode(projectDir: string): AgentLspSetupResult {
  const pluginDir = path.join(projectDir, ".claude", "plugins", "agency-lsp");
  const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  const lspConfigPath = path.join(pluginDir, ".lsp.json");

  writeJsonFile(manifestPath, {
    name: "agency-lsp",
    description: "Agency language server plugin for Claude Code",
    version: "1.0.0",
  });

  writeJsonFile(lspConfigPath, {
    agency: {
      command: "agency",
      args: ["lsp"],
      extensionToLanguage: {
        ".agency": "agency",
      },
    },
  });

  return {
    target: "claude-code",
    ok: true,
    files: [manifestPath, lspConfigPath],
    message:
      `Created Claude Code plugin at ${pluginDir}. Start Claude with --plugin-dir ${pluginDir}`,
  };
}

function unsupported(target: AgentLspTarget, message: string): AgentLspSetupResult {
  return { target, ok: false, files: [], message };
}

export function setupAgentLsp(
  target: AgentLspTarget,
  projectDir: string = process.cwd(),
): AgentLspSetupResult {
  switch (target) {
    case "opencode":
      return setupOpenCode(projectDir);
    case "claude-code":
      return setupClaudeCode(projectDir);
    case "codex":
      return unsupported(
        target,
        "Codex CLI uses MCP rather than native LSP configuration here. Use `agency mcp setup codex` instead. No files were written.",
      );
    case "pi":
      return unsupported(
        target,
        "Pi does not currently expose documented native LSP server configuration. No files were written.",
      );
  }
}
