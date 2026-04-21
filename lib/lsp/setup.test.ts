import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setupAgentLsp } from "./setup.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-setup-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("setupAgentLsp", () => {
  it("writes OpenCode config", () => {
    const result = setupAgentLsp("opencode", tmpDir);

    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(1);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf-8"),
    );
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect(config.lsp.agency.command).toEqual(["agency", "lsp"]);
    expect(config.lsp.agency.extensions).toEqual([".agency"]);
  });

  it("merges into existing OpenCode config", () => {
    const configPath = path.join(tmpDir, "opencode.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }),
    );

    setupAgentLsp("opencode", tmpDir);

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.model).toBe("anthropic/claude-sonnet-4-5");
    expect(config.lsp.agency.command).toEqual(["agency", "lsp"]);
  });

  it("writes Claude Code plugin files", () => {
    const result = setupAgentLsp("claude-code", tmpDir);

    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);

    const manifestPath = path.join(
      tmpDir,
      ".claude",
      "plugins",
      "agency-lsp",
      ".claude-plugin",
      "plugin.json",
    );
    const lspConfigPath = path.join(
      tmpDir,
      ".claude",
      "plugins",
      "agency-lsp",
      ".lsp.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const lspConfig = JSON.parse(fs.readFileSync(lspConfigPath, "utf-8"));

    expect(manifest.name).toBe("agency-lsp");
    expect(lspConfig.agency.command).toBe("agency");
    expect(lspConfig.agency.args).toEqual(["lsp"]);
    expect(lspConfig.agency.extensionToLanguage[".agency"]).toBe("agency");
  });

  it("reports Codex as unsupported", () => {
    const result = setupAgentLsp("codex", tmpDir);

    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.message).toContain("Codex CLI");
  });

  it("reports Pi as unsupported", () => {
    const result = setupAgentLsp("pi", tmpDir);

    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.message).toContain("Pi");
  });
});
