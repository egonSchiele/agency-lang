import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _listHostedModels } from "@/stdlib/llm.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Command } from "@/vendor/commander/index.js";

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
const secretsRecipeMocks = vi.hoisted(() => ({
  runSecretsSet: vi.fn(),
  runSecretsList: vi.fn(),
  runSecretsRm: vi.fn(),
  runSecretsImport: vi.fn(),
}));
vi.mock("@/cli/remote/commands/secrets.js", () => secretsRecipeMocks);
vi.mock("@/cli/remote/commands/logs.js", () => ({ runLogs: remoteRecipeMocks.runLogs }));

// Remote schedule recipes are mocked so dispatch/normalization can be tested
// with real parseAsync; the LOCAL schedule functions are mocked too, so a test
// can prove which side of the backend branch ran.
const scheduleRemoteMocks = vi.hoisted(() => ({
  addRemote: vi.fn(),
  listRemote: vi.fn(),
  removeRemote: vi.fn(),
  editRemote: vi.fn(),
}));
vi.mock("@/cli/schedule/remote.js", () => scheduleRemoteMocks);

const scheduleLocalMocks = vi.hoisted(() => {
  class ScheduleExistsError extends Error {
    constructor(public readonly scheduleName: string) {
      super(`exists: ${scheduleName}`);
    }
  }
  return {
    scheduleAdd: vi.fn(),
    scheduleList: vi.fn(() => []),
    scheduleRemove: vi.fn(),
    scheduleEdit: vi.fn(),
    formatListTable: vi.fn(() => "TABLE"),
    promptScheduleOverwrite: vi.fn(),
    ScheduleExistsError,
  };
});
vi.mock("@/cli/schedule/index.js", () => scheduleLocalMocks);

import { createProgram, parseNonNegativeInt, parsePositiveInt, runCli } from "./agency.js";
import { confirmQuestion, promptSecretValue } from "@/cli/remote/confirmation.js";

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

    await runCli(["node", "agency", "mcp", "setup", "codex", "--codex-config", configPath], {
      resolveMcpCommand: () => ["node", "/tmp/agency.js", "mcp"],
    });

    expect(fs.readFileSync(configPath, "utf-8")).toContain("[mcp_servers.agency]");
    expect(fs.readFileSync(configPath, "utf-8")).toContain('command = "node"');
    logSpy.mockRestore();
  });

  it("uses the stable agency executable for default Codex MCP setup", async () => {
    const configPath = path.join(tmpDir, "config.toml");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "agency", "mcp", "setup", "codex", "--codex-config", configPath]);

    const written = fs.readFileSync(configPath, "utf-8");
    expect(written).toContain("[mcp_servers.agency]");
    expect(written).toContain('command = "agency"');
    expect(written).toContain('args = ["mcp"]');
    expect(written).not.toContain("/tmp/");
    logSpy.mockRestore();
  });
});

describe("agency CLI command tree", () => {
  it("exposes optimize only at the top level, not as `eval optimize`", () => {
    const program = createProgram();
    const topLevelCommands = program.commands.map((command) => command.name());
    const evalCommand = program.commands.find((command) => command.name() === "eval");
    const evalCommands = evalCommand?.commands.map((command) => command.name()) ?? [];

    expect(topLevelCommands).toContain("optimize");
    expect(evalCommands).not.toContain("optimize");
  });

  it("`eval run` takes --trials as a positive integer", async () => {
    const program = createProgram();
    const evalCommand = program.commands.find((command) => command.name() === "eval");
    const runCommand = evalCommand?.commands.find((command) => command.name() === "run");
    expect(runCommand?.options.map((option) => option.long)).toContain("--trials");
    runCommand?.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(
      program.parseAsync(["eval", "run", "agent.agency", "--trials", "0"], { from: "user" }),
    ).rejects.toThrow(/positive integer/);
  });

  it("`eval upload` targets the project in agency.json only: no host, project, or key flags", () => {
    const program = createProgram();
    const evalCommand = program.commands.find((command) => command.name() === "eval");
    const upload = evalCommand?.commands.find((command) => command.name() === "upload");
    expect(upload).toBeDefined();
    const optionNames = upload?.options.map((option) => option.long) ?? [];
    expect(optionNames).not.toContain("--host");
    expect(optionNames).not.toContain("--project");
    expect(optionNames).not.toContain("--api-key-env");
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
    expect(typeof (logsCommand as unknown as { _actionHandler?: unknown })._actionHandler).toBe(
      "function",
    );
  });

  it("registers the remote command group with its subcommands", () => {
    const program = createProgram();
    const remote = program.commands.find((command) => command.name() === "remote");
    expect(remote).toBeDefined();
    expect(remote?.commands.map((command) => command.name()).sort()).toEqual([
      "call",
      "deploy",
      "keys",
      "logs",
      "ls",
      "open",
      "projects",
      "pull",
      "secrets",
      "spend",
      "whoami",
    ]);
  });

  it("forwards `remote spend <project>` args to runSpend", async () => {
    remoteRecipeMocks.runSpend.mockClear();
    const program = createProgram();
    await program.parseAsync(
      [
        "remote",
        "spend",
        "my-project",
        "--since",
        "7d",
        "--json",
        "--by-model",
        "--by-kind",
        "--host",
        "https://h",
        "--api-key-env",
        "SPEND_KEY",
      ],
      { from: "user" },
    );
    expect(remoteRecipeMocks.runSpend).toHaveBeenCalledTimes(1);
    const [project, options] = remoteRecipeMocks.runSpend.mock.calls[0];
    expect(project).toBe("my-project");
    expect(options).toMatchObject({
      since: "7d",
      json: true,
      byModel: true,
      byKind: true,
      host: "https://h",
      apiKeyEnv: "SPEND_KEY",
    });
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

describe.skipIf(!HAS_BUILT_CLI)(
  "compile --max-tool-call-rounds (integration, requires build)",
  () => {
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
  },
);

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

// The argv rewriter (splitCommandLine) is gone: the agent boundary is the
// vendored fork's immediate pass-through (lib/vendor/commander/boundary.test.ts)
// and the budget flags are the launcher pre-scan's
// (lib/cli/runBundledAgent.test.ts). Nothing splits argv before commander.

// Action-level proof that root -c provenance reaches the agent launch: a
// wrapper-only test could not catch the action dropping the flag.
describe("agent action provenance", () => {
  it("passes an explicit root -c path and exactly the forwarded tail", async () => {
    const launchAgent = vi.fn();
    const configPath = path.join(tmpDir, "agency.json");
    fs.writeFileSync(configPath, "{}\n");

    await runCli(["node", "agency", "-c", configPath, "agent", "--help"], {
      launchAgent,
    });

    expect(launchAgent).toHaveBeenCalledTimes(1);
    const [, forwarded, options] = launchAgent.mock.calls[0];
    expect(forwarded).toEqual(["--help"]);
    expect(options).toEqual({ explicitConfigPath: configPath });
  });

  it("passes no config path when -c was not written", async () => {
    const launchAgent = vi.fn();
    await runCli(["node", "agency", "agent", "--help"], { launchAgent });
    expect(launchAgent).toHaveBeenCalledTimes(1);
    expect(launchAgent.mock.calls[0][2]).toEqual({
      explicitConfigPath: undefined,
    });
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
      "node",
      "agency",
      "remote",
      "whoami",
      "--host",
      "https://h",
      "--api-key-env",
      "ACCOUNT_KEY",
    ]);
    expect(remoteRecipeMocks.runWhoami).toHaveBeenCalledWith(
      { host: "https://h", apiKeyEnv: "ACCOUNT_KEY" },
      CONTEXT,
    );
  });

  it("remote projects defaults to list", async () => {
    await createProgram().parseAsync([
      "node",
      "agency",
      "remote",
      "projects",
      "--host",
      "https://h",
      "--api-key-env",
      "ACCOUNT_KEY",
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
      "node",
      "agency",
      "remote",
      "projects",
      "create",
      "foo",
      "--name",
      "Foo",
      "--description",
      "Text",
      "--host",
      "https://h",
      "--api-key-env",
      "ACCOUNT_KEY",
    ]);
    expect(remoteRecipeMocks.runProjectsCreate).toHaveBeenCalledWith(
      "foo",
      { name: "Foo", description: "Text", host: "https://h", apiKeyEnv: "ACCOUNT_KEY" },
      CONTEXT,
    );
  });

  it("remote keys defaults to list", async () => {
    await createProgram().parseAsync([
      "node",
      "agency",
      "remote",
      "keys",
      "--host",
      "https://h",
      "--api-key-env",
      "ACCOUNT_KEY",
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
      "node",
      "agency",
      "remote",
      "keys",
      "create",
      "ci",
      "--project",
      "foo",
      "--host",
      "https://h",
      "--api-key-env",
      "ACCOUNT_KEY",
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

  describe("remote secrets", () => {
    beforeEach(() => {
      for (const mock of Object.values(secretsRecipeMocks)) mock.mockReset();
      secretsRecipeMocks.runSecretsSet.mockResolvedValue({ kind: "set" });
      secretsRecipeMocks.runSecretsImport.mockResolvedValue({ kind: "succeeded" });
    });

    afterEach(() => {
      process.exitCode = undefined;
    });

    it("set forwards the name, options, context, and the production io adapters", async () => {
      await createProgram().parseAsync([
        "node",
        "agency",
        "remote",
        "secrets",
        "set",
        "OPENAI_API_KEY",
        "--from-env",
        "SRC",
        "--project",
        "p",
      ]);
      expect(secretsRecipeMocks.runSecretsSet).toHaveBeenCalledTimes(1);
      const [name, opts, cmdContext, ioArg] = secretsRecipeMocks.runSecretsSet.mock.calls[0]!;
      expect(name).toBe("OPENAI_API_KEY");
      expect(opts).toMatchObject({ fromEnv: "SRC", project: "p" });
      expect(cmdContext).toEqual(CONTEXT);
      expect(ioArg.promptHidden).toBe(promptSecretValue);
      expect(typeof ioArg.readStdin).toBe("function");
      expect(typeof ioArg.stdinIsTty).toBe("boolean");
      expect(ioArg.env).toBe(process.env);
      expect(process.exitCode).toBeUndefined();
    });

    it("a canceled set maps to exit code 1", async () => {
      secretsRecipeMocks.runSecretsSet.mockResolvedValue({ kind: "canceled" });
      await createProgram().parseAsync([
        "node",
        "agency",
        "remote",
        "secrets",
        "set",
        "N",
        "--project",
        "p",
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("there is no --value flag", async () => {
      // Commander reports the unknown option and exits; vitest's process.exit
      // guard surfaces that as a rejection. What matters: the recipe never ran,
      // so a value passed via argv is never sent anywhere.
      await expect(
        createProgram().parseAsync([
          "node",
          "agency",
          "remote",
          "secrets",
          "set",
          "N",
          "--value",
          "leak",
        ]),
      ).rejects.toThrow();
      expect(secretsRecipeMocks.runSecretsSet).not.toHaveBeenCalled();
    });

    it("list routes with target options; ls is an alias", async () => {
      await createProgram().parseAsync([
        "node",
        "agency",
        "remote",
        "secrets",
        "list",
        "--project",
        "p",
      ]);
      expect(secretsRecipeMocks.runSecretsList).toHaveBeenCalledWith({ project: "p" }, CONTEXT);
      await createProgram().parseAsync([
        "node",
        "agency",
        "remote",
        "secrets",
        "ls",
        "--project",
        "p",
      ]);
      expect(secretsRecipeMocks.runSecretsList).toHaveBeenCalledTimes(2);
    });

    it("rm forwards the positional name", async () => {
      await createProgram().parseAsync([
        "node",
        "agency",
        "remote",
        "secrets",
        "rm",
        "OPENAI_API_KEY",
        "--project",
        "p",
      ]);
      expect(secretsRecipeMocks.runSecretsRm).toHaveBeenCalledWith(
        "OPENAI_API_KEY",
        { project: "p" },
        CONTEXT,
      );
    });

    it("import forwards the optional file and the production confirm adapter", async () => {
      await createProgram().parseAsync([
        "node",
        "agency",
        "remote",
        "secrets",
        "import",
        "prod.env",
        "--project",
        "p",
      ]);
      const [file, , , ioArg] = secretsRecipeMocks.runSecretsImport.mock.calls[0]!;
      expect(file).toBe("prod.env");
      expect(ioArg.confirm).toBe(confirmQuestion);
      expect(process.exitCode).toBeUndefined();
    });

    it.each([["declined"], ["failed"]])("an import that %s maps to exit code 1", async (kind) => {
      secretsRecipeMocks.runSecretsImport.mockResolvedValue({ kind });
      await createProgram().parseAsync(["node", "agency", "remote", "secrets", "import"]);
      expect(process.exitCode).toBe(1);
    });

    it("a succeeded import leaves the exit code unset", async () => {
      secretsRecipeMocks.runSecretsImport.mockResolvedValue({ kind: "succeeded" });
      await createProgram().parseAsync(["node", "agency", "remote", "secrets", "import"]);
      expect(process.exitCode).toBeUndefined();
    });
  });

  it("remote pull forwards --out/--force and context", async () => {
    await createProgram().parseAsync([
      "node",
      "agency",
      "remote",
      "pull",
      "--out",
      "/o",
      "--force",
      "--project",
      "p",
    ]);
    expect(remoteRecipeMocks.runPull).toHaveBeenCalledWith(
      { out: "/o", force: true, project: "p" },
      CONTEXT,
    );
  });

  it("remote logs --json forwards a fetch/json mode", async () => {
    await createProgram().parseAsync([
      "node",
      "agency",
      "remote",
      "logs",
      "--json",
      "--project",
      "p",
    ]);
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

describe("--model wiring", () => {
  const [firstCatalogModel, secondCatalogModel] = _listHostedModels().map((model) => model.name);
  if (firstCatalogModel === undefined || secondCatalogModel === undefined) {
    throw new Error("the hosted text catalog needs at least two models");
  }

  /** Parse an argv and hand back the RunOptions the `run` action would see. */
  async function runOptionsFor(words: string[]): Promise<Record<string, unknown>> {
    const program = createProgram({});
    const run = program.commands.find((cmd) => cmd.name() === "run");
    if (run === undefined) {
      throw new Error("no run command");
    }
    let captured: Record<string, unknown> = {};
    run.action(() => {
      captured = run.opts();
    });
    program.exitOverride();
    run.exitOverride();
    // `from: "user"` means every element is a user argument — commander does
    // NOT strip a leading node/script pair in this mode. Passing them would
    // send "node" through the hidden default command instead of testing `run`.
    await program.parseAsync(words, { from: "user" });
    return captured;
  }

  it("resolves a bare model", async () => {
    const opts = await runOptionsFor(["run", "--model", firstCatalogModel, "f.agency"]);
    expect(opts.model).toEqual({ model: firstCatalogModel });
  });

  it("resolves a prefixed model", async () => {
    const opts = await runOptionsFor([
      "run",
      "--model",
      "openrouter/anthropic/claude-sonnet-4",
      "f.agency",
    ]);
    expect(opts.model).toEqual({
      model: "anthropic/claude-sonnet-4",
      explicitProvider: "openrouter",
    });
  });

  it("takes the last value when the flag is repeated", async () => {
    // Commander passes the PREVIOUS parsed value as the parser's second
    // argument. Without the adapter, that object lands in `catalogNames`.
    // Both values stay bare on purpose: a prefixed second value returns
    // before consulting the catalog and would prove nothing.
    const opts = await runOptionsFor([
      "run",
      "--model",
      firstCatalogModel,
      "--model",
      secondCatalogModel,
      "f.agency",
    ]);
    expect(opts.model).toEqual({ model: secondCatalogModel });
  });

  it("rejects an unknown bare model", async () => {
    await expect(
      runOptionsFor(["run", "--model", "definitely-not-a-hosted-model", "f.agency"]),
    ).rejects.toThrow();
  });
});

describe("schedule --backend remote dispatch", () => {
  class ExitError extends Error {}

  const parse = (args: string[]) =>
    createProgram().parseAsync(["node", "agency", "schedule", ...args]);

  const expectContext = expect.objectContaining({
    config: expect.anything(),
    configPath: expect.any(String),
  });

  beforeEach(() => {
    for (const mock of Object.values(scheduleRemoteMocks)) mock.mockReset();
    scheduleLocalMocks.scheduleAdd.mockReset();
    scheduleLocalMocks.scheduleList.mockReset().mockReturnValue([]);
    scheduleLocalMocks.scheduleRemove.mockReset();
    scheduleLocalMocks.scheduleEdit.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitError();
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers without tripping the duplicate-flag guard", () => {
    expect(() => createProgram()).not.toThrow();
  });

  it("routes add to addRemote with normalized options and a config context", async () => {
    await parse([
      "add",
      "daily.agency",
      "--backend",
      "remote",
      "--node",
      "refresh",
      "--every",
      "daily",
      "--timezone",
      "UTC",
      "--arg",
      "a=1",
      "--data",
      '{"b":2}',
      "--name",
      "mine",
      "--host",
      "https://h",
      "--project",
      "proj",
      "--api-key-env",
      "K",
    ]);
    expect(scheduleRemoteMocks.addRemote).toHaveBeenCalledTimes(1);
    const [file, options, context] = scheduleRemoteMocks.addRemote.mock.calls[0]!;
    expect(file).toBe("daily.agency");
    expect(options).toMatchObject({
      node: "refresh",
      every: "daily",
      timezone: "UTC",
      arg: ["a=1"],
      data: '{"b":2}',
      name: "mine",
      host: "https://h",
      project: "proj",
      apiKeyEnv: "K",
      deploy: true,
    });
    expect(context).toEqual(expectContext);
    expect(scheduleLocalMocks.scheduleAdd).not.toHaveBeenCalled();
  });

  it("--no-deploy arrives as deploy:false; absence as deploy:true", async () => {
    await parse([
      "add",
      "a.agency",
      "--backend",
      "remote",
      "--node",
      "n",
      "--every",
      "daily",
      "--no-deploy",
    ]);
    expect(scheduleRemoteMocks.addRemote.mock.calls[0]![1]).toMatchObject({ deploy: false });

    scheduleRemoteMocks.addRemote.mockClear();
    await parse(["add", "a.agency", "--backend", "remote", "--node", "n", "--every", "daily"]);
    expect(scheduleRemoteMocks.addRemote.mock.calls[0]![1]).toMatchObject({ deploy: true });
  });

  it("--function and --cron values are preserved", async () => {
    await parse([
      "add",
      "a.agency",
      "--backend",
      "remote",
      "--function",
      "sum",
      "--cron",
      "*/5 * * * *",
    ]);
    expect(scheduleRemoteMocks.addRemote.mock.calls[0]![1]).toMatchObject({
      function: "sum",
      cron: "*/5 * * * *",
    });
  });

  it("routes list to listRemote and never touches the local registry path", async () => {
    await parse(["list", "--backend", "remote"]);
    expect(scheduleRemoteMocks.listRemote).toHaveBeenCalledTimes(1);
    expect(scheduleRemoteMocks.listRemote).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "remote" }),
      expectContext,
    );
    expect(scheduleLocalMocks.scheduleList).not.toHaveBeenCalled();
  });

  it("the ls alias routes to listRemote", async () => {
    await parse(["ls", "--backend", "remote"]);
    expect(scheduleRemoteMocks.listRemote).toHaveBeenCalledTimes(1);
  });

  it("routes remove to removeRemote with the positional id", async () => {
    await parse(["remove", "id123", "--backend", "remote"]);
    expect(scheduleRemoteMocks.removeRemote).toHaveBeenCalledWith(
      "id123",
      expect.objectContaining({ backend: "remote" }),
      expectContext,
    );
    expect(scheduleLocalMocks.scheduleRemove).not.toHaveBeenCalled();
  });

  it("the rm alias routes to removeRemote", async () => {
    await parse(["rm", "id123", "--backend", "remote"]);
    expect(scheduleRemoteMocks.removeRemote).toHaveBeenCalledTimes(1);
  });

  it("routes edit to editRemote with the positional id and independent enabled flags", async () => {
    await parse(["edit", "id123", "--backend", "remote", "--enabled"]);
    expect(scheduleRemoteMocks.editRemote).toHaveBeenCalledTimes(1);
    const [id, options] = scheduleRemoteMocks.editRemote.mock.calls[0]!;
    expect(id).toBe("id123");
    expect(options).toMatchObject({ enabled: true });
    expect(options.disabled).toBeUndefined();
    expect(scheduleLocalMocks.scheduleEdit).not.toHaveBeenCalled();

    scheduleRemoteMocks.editRemote.mockClear();
    await parse(["edit", "id123", "--backend", "remote", "--disabled"]);
    const disabledOptions = scheduleRemoteMocks.editRemote.mock.calls[0]![1];
    expect(disabledOptions).toMatchObject({ disabled: true });
    expect(disabledOptions.enabled).toBeUndefined();
  });

  it("awaits the remote recipe before completing the command", async () => {
    let resolveAdd!: () => void;
    scheduleRemoteMocks.addRemote.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = () => resolve();
        }),
    );
    const parsing = parse([
      "add",
      "a.agency",
      "--backend",
      "remote",
      "--node",
      "n",
      "--every",
      "daily",
    ]).then(() => "done");
    await Promise.resolve();
    await Promise.resolve();
    await expect(Promise.race([parsing, Promise.resolve("pending")])).resolves.toBe("pending");
    resolveAdd();
    await expect(parsing).resolves.toBe("done");
  });

  it("default local add still dispatches to the local function", async () => {
    await parse(["add", "a.agency", "--every", "daily"]);
    expect(scheduleLocalMocks.scheduleAdd).toHaveBeenCalledTimes(1);
    expect(scheduleRemoteMocks.addRemote).not.toHaveBeenCalled();
  });

  it("github add still dispatches to the local function", async () => {
    await parse(["add", "a.agency", "--every", "daily", "--backend", "github"]);
    expect(scheduleLocalMocks.scheduleAdd).toHaveBeenCalledTimes(1);
    expect(scheduleLocalMocks.scheduleAdd.mock.calls[0]![0]).toMatchObject({ backend: "github" });
    expect(scheduleRemoteMocks.addRemote).not.toHaveBeenCalled();
  });

  it("an unknown backend on add calls neither path", async () => {
    await expect(
      parse(["add", "a.agency", "--every", "daily", "--backend", "bogus"]),
    ).rejects.toBeInstanceOf(ExitError);
    expect(scheduleLocalMocks.scheduleAdd).not.toHaveBeenCalled();
    expect(scheduleRemoteMocks.addRemote).not.toHaveBeenCalled();
  });

  it("github is not a valid backend for list", async () => {
    await expect(parse(["list", "--backend", "github"])).rejects.toBeInstanceOf(ExitError);
    expect(scheduleLocalMocks.scheduleList).not.toHaveBeenCalled();
    expect(scheduleRemoteMocks.listRemote).not.toHaveBeenCalled();
  });

  it.each([
    [["add", "a.agency", "--every", "daily", "--node", "n"]],
    [["add", "a.agency", "--every", "daily", "--backend", "github", "--no-deploy"]],
    [["add", "a.agency", "--every", "daily", "--backend", "github", "--timezone", "UTC"]],
    [["edit", "x", "--timezone", "UTC"]],
    [["list", "--project", "p"]],
    // The inverse direction: flags the remote backend cannot honor must fail
    // loudly rather than be silently discarded.
    [
      [
        "add",
        "a.agency",
        "--backend",
        "remote",
        "--node",
        "n",
        "--every",
        "daily",
        "--env-file",
        ".env",
      ],
    ],
    [
      [
        "add",
        "a.agency",
        "--backend",
        "remote",
        "--node",
        "n",
        "--every",
        "daily",
        "--secret",
        "S",
      ],
    ],
    [["add", "a.agency", "--backend", "remote", "--node", "n", "--every", "daily", "--write"]],
    [["add", "a.agency", "--backend", "remote", "--node", "n", "--every", "daily", "--no-pin"]],
    [["edit", "x", "--backend", "remote", "--enabled", "--env-file", ".env"]],
  ])("rejects backend-inapplicable flags: %j", async (args) => {
    await expect(parse(args)).rejects.toBeInstanceOf(ExitError);
    expect(scheduleLocalMocks.scheduleAdd).not.toHaveBeenCalled();
    expect(scheduleLocalMocks.scheduleEdit).not.toHaveBeenCalled();
    expect(scheduleLocalMocks.scheduleList).not.toHaveBeenCalled();
    for (const mock of Object.values(scheduleRemoteMocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});
