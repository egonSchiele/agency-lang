import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { applyCliFlagsToConfig, createProgram, runCli } from "./agency.js";

const execFileAsync = promisify(execFile);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runCli", () => {
  it("awaits the async lsp startup path", async () => {
    const startServer = vi.fn();
    const loadLspStartServer = vi.fn(async () => startServer);

    await runCli(["node", "agency", "lsp"], { loadLspStartServer });

    expect(loadLspStartServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("awaits the async mcp startup path", async () => {
    const startServer = vi.fn();
    const loadMcpStartServer = vi.fn(async () => startServer);

    await runCli(["node", "agency", "mcp"], { loadMcpStartServer });

    expect(loadMcpStartServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("writes Codex MCP config to an explicit path", async () => {
    const configPath = path.join(tmpDir, "config.toml");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(
      ["node", "agency", "mcp", "setup", "codex", "--codex-config", configPath],
      { resolveMcpCommand: () => ["node", "/tmp/agency.js", "mcp"] },
    );

    expect(fs.readFileSync(configPath, "utf-8")).toContain('[mcp_servers.agency]');
    expect(fs.readFileSync(configPath, "utf-8")).toContain('command = "node"');
    logSpy.mockRestore();
  });

  it("uses the stable agency executable for default Codex MCP setup", async () => {
    const configPath = path.join(tmpDir, "config.toml");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(
      ["node", "agency", "mcp", "setup", "codex", "--codex-config", configPath],
    );

    const written = fs.readFileSync(configPath, "utf-8");
    expect(written).toContain('[mcp_servers.agency]');
    expect(written).toContain('command = "agency"');
    expect(written).toContain('args = ["mcp"]');
    expect(written).not.toContain("/tmp/");
    logSpy.mockRestore();
  });
});

describe("agency CLI command tree", () => {
  it("exposes optimize under both `eval optimize` and the top-level `optimize` alias", () => {
    const program = createProgram();
    const topLevelCommands = program.commands.map((command) => command.name());
    const evalCommand = program.commands.find((command) => command.name() === "eval");
    const evalCommands = evalCommand?.commands.map((command) => command.name()) ?? [];

    expect(topLevelCommands).toContain("optimize");
    expect(evalCommands).toContain("optimize");
  });

  it("makes `view` the default for `logs` so `agency logs <file>` works without the subcommand", () => {
    const program = createProgram();
    const logsCommand = program.commands.find((command) => command.name() === "logs");
    expect(logsCommand).toBeDefined();
    // `view` is still registered explicitly as a subcommand.
    const logsSubcommands = logsCommand?.commands.map((command) => command.name()) ?? [];
    expect(logsSubcommands).toContain("view");
    // The parent `logs` command itself takes an optional [file] argument
    // and has its own action handler — that's the default-view path.
    expect(logsCommand?.usage()).toContain("[file]");
    expect(typeof (logsCommand as unknown as { _actionHandler?: unknown })._actionHandler)
      .toBe("function");
  });
});

describe("applyCliFlagsToConfig", () => {
  it("maps --log-file to log.logFile and enables observability", () => {
    const out = applyCliFlagsToConfig({}, { logFile: "run.jsonl" });
    expect(out.log?.logFile).toBe("run.jsonl");
    expect(out.observability).toBe(true);
  });

  it("maps --strict to strict AND strictTypes (both required by the gate)", () => {
    const out = applyCliFlagsToConfig({}, { strict: true });
    expect(out.typechecker).toEqual({ strict: true, strictTypes: true });
  });

  it("maps --observability alone", () => {
    expect(applyCliFlagsToConfig({}, { observability: true }).observability).toBe(true);
  });

  it("preserves a log.host loaded from agency.json when adding logFile", () => {
    const out = applyCliFlagsToConfig({ log: { host: "https://h" } }, { logFile: "x" });
    expect(out.log).toEqual({ host: "https://h", logFile: "x" });
  });

  it("derives the default trace file from the input path", () => {
    const out = applyCliFlagsToConfig({}, { trace: true }, "prog.agency");
    expect(out.trace).toBe(true);
    expect(out.traceFile).toBe("prog.trace");
  });

  it("does not mutate the input config", () => {
    const input = {};
    applyCliFlagsToConfig(input, { strict: true, logFile: "x" });
    expect(input).toEqual({});
  });
});

describe("compile --strict (integration)", () => {
  it("exits non-zero on a type error with --strict, zero without", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strict-"));
    const f = path.join(dir, "bad.agency");
    fs.writeFileSync(f, 'node main() {\n  let x: number = "hello"\n}\n');
    const cli = path.resolve("dist/scripts/agency.js");
    await expect(execFileAsync("node", [cli, "compile", f])).resolves.toBeTruthy();
    await expect(execFileAsync("node", [cli, "compile", "--strict", f])).rejects.toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("config show (integration)", () => {
  it("prints the resolved, merged config as JSON", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-show-"));
    fs.writeFileSync(path.join(dir, "agency.json"), JSON.stringify({ outDir: "./built" }));
    const cli = path.resolve("dist/scripts/agency.js");
    const { stdout } = await execFileAsync("node", [
      cli,
      "-c",
      path.join(dir, "agency.json"),
      "config",
      "show",
    ]);
    expect(JSON.parse(stdout).outDir).toBe("./built");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
