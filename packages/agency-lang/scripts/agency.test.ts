import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import {
  createProgram,
  injectAgentSeparator,
  parseNonNegativeInt,
  parsePositiveInt,
  runCli,
} from "./agency.js";

const execFileAsync = promisify(execFile);

// The CLI integration tests below shell out to the built dist/ to observe real
// process exit codes (compile calls process.exit, which would kill the vitest
// worker if run in-process). They are SKIPPED (with a visible reason) when dist
// isn't built, so `pnpm test` stays green on a clean checkout; they run in CI
// and after `make` / `pnpm run build`.
const CLI = path.resolve("dist/scripts/agency.js");
const HAS_BUILT_CLI = fs.existsSync(CLI);
if (!HAS_BUILT_CLI) {
  console.warn(
    `Skipping CLI integration tests: ${CLI} not built (run \`make\` or \`pnpm run build\`).`,
  );
}

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

describe.skipIf(!HAS_BUILT_CLI)("compile --strict (integration, requires build)", () => {
  it("exits non-zero on a type error with --strict, zero without", async () => {
    const cli = CLI;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strict-"));
    const f = path.join(dir, "bad.agency");
    fs.writeFileSync(f, 'node main() {\n  let x: number = "hello"\n}\n');
    await expect(execFileAsync("node", [cli, "compile", f])).resolves.toBeTruthy();
    await expect(execFileAsync("node", [cli, "compile", "--strict", f])).rejects.toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!HAS_BUILT_CLI)("compile --max-tool-call-rounds (integration, requires build)", () => {
  it("bakes the flag value into the generated runPrompt call (overriding the default 10)", async () => {
    const cli = CLI;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtcr-"));
    const f = path.join(dir, "prog.agency");
    const out = path.join(dir, "prog.ts");
    fs.writeFileSync(f, 'node main() {\n  const reply = llm("hi")\n}\n');
    await execFileAsync("node", [cli, "compile", "--ts", "--max-tool-call-rounds", "3", f]);
    const generated = fs.readFileSync(out, "utf-8");
    expect(generated).toContain("maxToolCallRounds: 3");
    expect(generated).not.toContain("maxToolCallRounds: 10");
    // A positive integer is required.
    await expect(
      execFileAsync("node", [cli, "compile", "--ts", "--max-tool-call-rounds", "0", f]),
    ).rejects.toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!HAS_BUILT_CLI)("config show (integration, requires build)", () => {
  it("prints the resolved, merged config as JSON, with secrets masked by default", async () => {
    const cli = CLI;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-show-"));
    fs.writeFileSync(
      path.join(dir, "agency.json"),
      JSON.stringify({ outDir: "./built", log: { apiKey: "sk-secret-1234" } }),
    );
    const cfg = path.join(dir, "agency.json");

    const masked = await execFileAsync("node", [cli, "-c", cfg, "config", "show"]);
    const maskedJson = JSON.parse(masked.stdout);
    expect(maskedJson.outDir).toBe("./built");
    expect(maskedJson.log.apiKey).toBe("•••1234");
    expect(masked.stdout).not.toContain("sk-secret-1234");

    const raw = await execFileAsync("node", [cli, "-c", cfg, "config", "show", "--show-secrets"]);
    expect(JSON.parse(raw.stdout).log.apiKey).toBe("sk-secret-1234");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("integer flag parsers reject parseInt footguns", () => {
  it("parsePositiveInt accepts positive integers, rejects 0/floats/garbage/hex/negatives", () => {
    expect(parsePositiveInt("5")).toBe(5);
    expect(parsePositiveInt("100")).toBe(100);
    for (const bad of ["0", "1.5", "3abc", "0x10", "-1", "", " ", "1e3"]) {
      expect(() => parsePositiveInt(bad)).toThrow();
    }
  });

  it("parseNonNegativeInt accepts 0 and positives, rejects floats/garbage/hex/negatives", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
    expect(parseNonNegativeInt("42")).toBe(42);
    for (const bad of ["1.5", "3abc", "0x10", "-1", "", "1e3"]) {
      expect(() => parseNonNegativeInt(bad)).toThrow();
    }
  });
});

describe("injectAgentSeparator", () => {
  const N = ["node", "agency"];

  it("inserts `--` right after `agent` so agent flags are forwarded", () => {
    expect(injectAgentSeparator([...N, "agent", "--policy", "approve-all"])).toEqual(
      [...N, "agent", "--", "--policy", "approve-all"],
    );
  });

  it("keeps --max-cost/--max-time BEFORE the `--` so commander parses them", () => {
    // The bug this guards: without skipping the budget flags, they land after
    // `--` and get forwarded to the agent instead of installing the budget.
    expect(
      injectAgentSeparator([...N, "agent", "--max-cost", "5", "-p", "task"]),
    ).toEqual([...N, "agent", "--max-cost", "5", "--", "-p", "task"]);
    expect(
      injectAgentSeparator([
        ...N, "agent", "--max-cost", "5", "--max-time", "30m", "--policy", "reject",
      ]),
    ).toEqual([
      ...N, "agent", "--max-cost", "5", "--max-time", "30m", "--", "--policy", "reject",
    ]);
  });

  it("handles the --flag=value form of the budget options", () => {
    expect(
      injectAgentSeparator([...N, "agent", "--max-time=30m", "-p", "task"]),
    ).toEqual([...N, "agent", "--max-time=30m", "--", "-p", "task"]);
  });

  it("leaves argv untouched when the user already wrote `--`", () => {
    const already = [...N, "agent", "--max-cost", "5", "--", "-p", "task"];
    expect(injectAgentSeparator(already)).toEqual(already);
    const bare = [...N, "agent", "--", "-p", "task"];
    expect(injectAgentSeparator(bare)).toEqual(bare);
  });

  it("is a no-op for other subcommands", () => {
    const run = [...N, "run", "foo.agency", "--max-cost", "5"];
    expect(injectAgentSeparator(run)).toEqual(run);
  });
});
