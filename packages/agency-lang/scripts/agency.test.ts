import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitCommandLine } from "@/cli/commandLine.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Command } from "commander";

// Replace only the three new remote-management recipe modules so registration
// can be exercised with real `parseAsync` without hitting the network.
const remoteRecipeMocks = vi.hoisted(() => ({
  runWhoami: vi.fn(),
  runProjectsList: vi.fn(),
  runProjectsCreate: vi.fn(),
  runKeysList: vi.fn(),
  runKeysCreate: vi.fn(),
  runSpend: vi.fn(),
  runPull: vi.fn(),
  runLogs: vi.fn(),
}));
vi.mock("@/cli/remote/commands/whoami.js", () => ({
  runWhoami: remoteRecipeMocks.runWhoami,
}));
vi.mock("@/cli/remote/commands/projects.js", () => ({
  runProjectsList: remoteRecipeMocks.runProjectsList,
  runProjectsCreate: remoteRecipeMocks.runProjectsCreate,
}));
vi.mock("@/cli/remote/commands/keys.js", () => ({
  runKeysList: remoteRecipeMocks.runKeysList,
  runKeysCreate: remoteRecipeMocks.runKeysCreate,
}));
vi.mock("@/cli/remote/commands/spend.js", () => ({
  runSpend: remoteRecipeMocks.runSpend,
}));
// pull/logs recipes are mocked; logsMode and util stay REAL so the
// registration's mode/TTY preflight and clean-exit are exercised.
vi.mock("@/cli/remote/commands/pull.js", () => ({ runPull: remoteRecipeMocks.runPull }));
vi.mock("@/cli/remote/commands/logs.js", () => ({ runLogs: remoteRecipeMocks.runLogs }));

import {
  createProgram,
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
    // The parent `logs` command itself takes optional variadic [files...]
    // and has its own action handler — a sole statelog file is the
    // default-view path; run dirs and multiple paths open the explorer.
    expect(logsCommand?.usage()).toContain("[files...]");
    expect(typeof (logsCommand as unknown as { _actionHandler?: unknown })._actionHandler)
      .toBe("function");
  });

  it("registers the remote command group with its subcommands", () => {
    const program = createProgram();
    const remote = program.commands.find((command) => command.name() === "remote");
    expect(remote).toBeDefined();
    expect(remote?.commands.map((command) => command.name()).sort()).toEqual([
      "call",
      "deploy",
      "keys",
      "link",
      "logs",
      "ls",
      "open",
      "projects",
      "pull",
      "spend",
      "whoami",
    ]);
  });

  it("forwards `remote spend <project>` args to runSpend", async () => {
    remoteRecipeMocks.runSpend.mockClear();
    const program = createProgram();
    await program.parseAsync(
      ["remote", "spend", "my-project", "--since", "7d", "--json", "--by-model", "--by-kind", "--host", "https://h", "--api-key-env", "SPEND_KEY"],
      { from: "user" },
    );
    expect(remoteRecipeMocks.runSpend).toHaveBeenCalledTimes(1);
    const [project, options] = remoteRecipeMocks.runSpend.mock.calls[0];
    expect(project).toBe("my-project");
    expect(options).toMatchObject({ since: "7d", json: true, byModel: true, byKind: true, host: "https://h", apiKeyEnv: "SPEND_KEY" });
  });

  it("forwards bare `remote spend` with an undefined project", async () => {
    remoteRecipeMocks.runSpend.mockClear();
    const program = createProgram();
    await program.parseAsync(["remote", "spend"], { from: "user" });
    expect(remoteRecipeMocks.runSpend).toHaveBeenCalledTimes(1);
    expect(remoteRecipeMocks.runSpend.mock.calls[0][0]).toBeUndefined();
  });

  it("no longer registers a top-level deploy command (moved to remote deploy)", () => {
    const program = createProgram();
    expect(program.commands.map((command) => command.name())).not.toContain("deploy");
  });

  it("logs supports --csv for a headless runs-table export", () => {
    const program = createProgram();
    const logsCommand = program.commands.find((command) => command.name() === "logs");
    const optionNames = logsCommand?.options.map((option) => option.long) ?? [];
    expect(optionNames).toContain("--csv");
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

// The agent boundary now comes from splitCommandLine with an agent policy, so
// these cases live beside the run cases in lib/cli/commandLine.test.ts. What is
// asserted here is that the CLI wires that policy up: the budget flags must
// stay on agency's side of the separator, or the cap silently never applies.
describe("agent command line", () => {
  const N = ["node", "agency"];
  const AGENT_POLICY = [
    {
      command: "agent",
      ownedPositionals: 0,
      options: [
        { long: "--max-cost", arity: "required" as const },
        { long: "--max-time", arity: "required" as const },
      ],
      warnOnCollision: false,
    },
  ];
  const split = (...words: string[]) =>
    splitCommandLine([...N, ...words], [], AGENT_POLICY).argv;

  it("inserts `--` right after `agent` so agent flags are forwarded", () => {
    expect(split("agent", "--policy", "approve-all")).toEqual([
      ...N, "agent", "--", "--policy", "approve-all",
    ]);
  });

  it("keeps --max-cost/--max-time BEFORE the `--` so commander parses them", () => {
    expect(split("agent", "--max-cost", "5", "-p", "task")).toEqual([
      ...N, "agent", "--max-cost", "5", "--", "-p", "task",
    ]);
    expect(
      split("agent", "--max-cost", "5", "--max-time", "30m", "--policy", "reject"),
    ).toEqual([
      ...N, "agent", "--max-cost", "5", "--max-time", "30m", "--", "--policy", "reject",
    ]);
  });

  it("handles the --flag=value form of the budget options", () => {
    expect(split("agent", "--max-time=30m", "-p", "task")).toEqual([
      ...N, "agent", "--max-time=30m", "--", "-p", "task",
    ]);
  });

  it("leaves argv untouched when the user already wrote `--`", () => {
    for (const words of [
      ["agent", "--max-cost", "5", "--", "-p", "task"],
      ["agent", "--", "-p", "task"],
    ]) {
      expect(split(...words)).toEqual([...N, ...words]);
    }
  });

  it("is a no-op for a subcommand with no policy", () => {
    expect(split("run", "foo.agency", "--max-cost", "5")).toEqual([
      ...N, "run", "foo.agency", "--max-cost", "5",
    ]);
  });
});

describe("remote management command registration", () => {
  const CONTEXT = expect.objectContaining({
    config: expect.any(Object),
    configPath: expect.any(String),
  });

  function exitOverrideAll(cmd: Command): void {
    cmd.exitOverride();
    for (const sub of cmd.commands) {
      exitOverrideAll(sub);
    }
  }

  beforeEach(() => {
    for (const fn of Object.values(remoteRecipeMocks)) {
      fn.mockReset();
    }
  });

  it("remote whoami forwards options and context", async () => {
    await createProgram().parseAsync([
      "node", "agency", "remote", "whoami", "--host", "https://h", "--api-key-env", "ACCOUNT_KEY",
    ]);
    expect(remoteRecipeMocks.runWhoami).toHaveBeenCalledWith(
      { host: "https://h", apiKeyEnv: "ACCOUNT_KEY" },
      CONTEXT,
    );
  });

  it("remote projects defaults to list", async () => {
    await createProgram().parseAsync([
      "node", "agency", "remote", "projects", "--host", "https://h", "--api-key-env", "ACCOUNT_KEY",
    ]);
    expect(remoteRecipeMocks.runProjectsList).toHaveBeenCalledWith(
      { host: "https://h", apiKeyEnv: "ACCOUNT_KEY" },
      CONTEXT,
    );
    expect(remoteRecipeMocks.runProjectsCreate).not.toHaveBeenCalled();
  });

  it("remote projects list runs explicitly", async () => {
    await createProgram().parseAsync(["node", "agency", "remote", "projects", "list"]);
    expect(remoteRecipeMocks.runProjectsList).toHaveBeenCalledTimes(1);
  });

  it("remote projects create forwards the slug and options", async () => {
    await createProgram().parseAsync([
      "node", "agency", "remote", "projects", "create", "foo",
      "--name", "Foo", "--description", "Text", "--host", "https://h", "--api-key-env", "ACCOUNT_KEY",
    ]);
    expect(remoteRecipeMocks.runProjectsCreate).toHaveBeenCalledWith(
      "foo",
      { name: "Foo", description: "Text", host: "https://h", apiKeyEnv: "ACCOUNT_KEY" },
      CONTEXT,
    );
  });

  it("remote keys defaults to list", async () => {
    await createProgram().parseAsync([
      "node", "agency", "remote", "keys", "--host", "https://h", "--api-key-env", "ACCOUNT_KEY",
    ]);
    expect(remoteRecipeMocks.runKeysList).toHaveBeenCalledWith(
      { host: "https://h", apiKeyEnv: "ACCOUNT_KEY" },
      CONTEXT,
    );
  });

  it("remote keys list runs explicitly", async () => {
    await createProgram().parseAsync(["node", "agency", "remote", "keys", "list"]);
    expect(remoteRecipeMocks.runKeysList).toHaveBeenCalledTimes(1);
  });

  it("remote keys create forwards the name and --project", async () => {
    await createProgram().parseAsync([
      "node", "agency", "remote", "keys", "create", "ci",
      "--project", "foo", "--host", "https://h", "--api-key-env", "ACCOUNT_KEY",
    ]);
    expect(remoteRecipeMocks.runKeysCreate).toHaveBeenCalledWith(
      "ci",
      { project: "foo", host: "https://h", apiKeyEnv: "ACCOUNT_KEY" },
      CONTEXT,
    );
  });

  it("projects create requires --name", async () => {
    const program = createProgram();
    exitOverrideAll(program);
    await expect(
      program.parseAsync(["node", "agency", "remote", "projects", "create", "foo"]),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
    expect(remoteRecipeMocks.runProjectsCreate).not.toHaveBeenCalled();
  });

  it("keys create requires --project", async () => {
    const program = createProgram();
    exitOverrideAll(program);
    await expect(
      program.parseAsync(["node", "agency", "remote", "keys", "create", "ci"]),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
    expect(remoteRecipeMocks.runKeysCreate).not.toHaveBeenCalled();
  });

  it("remote pull forwards --out/--force and context", async () => {
    await createProgram().parseAsync([
      "node", "agency", "remote", "pull", "--out", "/o", "--force", "--project", "p",
    ]);
    expect(remoteRecipeMocks.runPull).toHaveBeenCalledWith(
      { out: "/o", force: true, project: "p" },
      CONTEXT,
    );
  });

  it("remote logs --json forwards a fetch/json mode", async () => {
    await createProgram().parseAsync(["node", "agency", "remote", "logs", "--json", "--project", "p"]);
    expect(remoteRecipeMocks.runLogs).toHaveBeenCalledWith(
      { kind: "fetch", traceId: undefined, output: "json" },
      { json: true, project: "p" },
      CONTEXT,
    );
  });

  it("remote logs <id> --json forwards the trace id", async () => {
    await createProgram().parseAsync(["node", "agency", "remote", "logs", "t1", "--json"]);
    expect(remoteRecipeMocks.runLogs).toHaveBeenCalledWith(
      { kind: "fetch", traceId: "t1", output: "json" },
      { json: true },
      CONTEXT,
    );
  });

  it("remote logs --list forwards a list mode", async () => {
    await createProgram().parseAsync(["node", "agency", "remote", "logs", "--list"]);
    expect(remoteRecipeMocks.runLogs).toHaveBeenCalledWith(
      { kind: "list", json: false },
      { list: true },
      CONTEXT,
    );
  });

  it("remote logs <id> --list is rejected and runs no recipe", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      createProgram().parseAsync(["node", "agency", "remote", "logs", "foo", "--list"]),
    ).rejects.toThrow("exit 1");
    expect(remoteRecipeMocks.runLogs).not.toHaveBeenCalled();
    exit.mockRestore();
    err.mockRestore();
  });

  it("remote logs viewer mode on a non-TTY exits before the recipe, suggesting --json", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const messages: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      messages.push(a.join(" "));
    });
    // vitest runs without a TTY, so plain `remote logs` (viewer) trips the precondition.
    await expect(
      createProgram().parseAsync(["node", "agency", "remote", "logs", "--project", "p"]),
    ).rejects.toThrow("exit 1");
    expect(remoteRecipeMocks.runLogs).not.toHaveBeenCalled();
    expect(messages.join("\n")).toContain("--json");
    exit.mockRestore();
    err.mockRestore();
  });
});
