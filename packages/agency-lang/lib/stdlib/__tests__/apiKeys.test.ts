import { describe, expect, it, vi } from "vitest";
import type { Command, Host, HostEnv, OperatingSystem, RunResult } from "../../host/host.js";
import { apiKeyVariables, keychainWarning, loadApiKeys, saveApiKey } from "../apiKeys.js";
import { exited, failed, hostOn } from "./fakeSubprocess.js";

/** A `HostEnv` over a plain object, so no test touches `process.env`. */
function memoryEnv(initial: Record<string, string> = {}): HostEnv {
  const values: Record<string, string> = { ...initial };
  return {
    get: (name) => values[name] ?? null,
    set: (name, value) => {
      values[name] = value;
    },
    all: () => ({ ...values }),
  };
}

type Run = { args: string[]; input: string | undefined };

/** A host on `os` whose programs answer with `answer`, recording each run.
 *  Nothing reaches the real keyring. */
function keyringHost(args: {
  os?: OperatingSystem;
  env?: HostEnv;
  answer?: (run: Run) => Promise<RunResult>;
}): { host: Host; runs: Run[] } {
  const runs: Run[] = [];
  const real = hostOn(args.os ?? "macos");
  const answer = args.answer ?? (async () => failed("not found", 44));
  const run = async (command: Command, options?: { input?: string }): Promise<RunResult> => {
    const recorded = {
      args: command.kind === "program" ? command.args : [],
      input: options?.input,
    };
    runs.push(recorded);
    return answer(recorded);
  };
  return {
    host: { ...real, env: args.env ?? memoryEnv(), subprocess: { ...real.subprocess, run } },
    runs,
  };
}

/** The account a `security find-generic-password` run asks for. */
function accountOf(run: Run): string {
  return run.args[run.args.indexOf("-a") + 1];
}

describe("loadApiKeys", () => {
  it("loads a key that isn't in the environment", async () => {
    const env = memoryEnv();
    const { host } = keyringHost({
      env,
      answer: async (run) =>
        accountOf(run) === "ANTHROPIC_API_KEY"
          ? exited("", 'password: "sk-1"\n')
          : failed("not found", 44),
    });
    const result = await loadApiKeys({ host });
    expect(env.get("ANTHROPIC_API_KEY")).toBe("sk-1");
    expect(result).toEqual({ loaded: ["ANTHROPIC_API_KEY"], failed: null });
  });

  it("never reads a variable that is already set", async () => {
    const env = memoryEnv({ OPENAI_API_KEY: "mine" });
    const { host, runs } = keyringHost({ env });
    await loadApiKeys({ host });
    expect(runs.some((run) => run.args.includes("OPENAI_API_KEY"))).toBe(false);
    expect(env.get("OPENAI_API_KEY")).toBe("mine");
  });

  it("after a missing first lookup, reads the rest at once", async () => {
    const env = memoryEnv({ ANTHROPIC_API_KEY: "set" });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const { host, runs } = keyringHost({
      env,
      answer: async () => {
        started++;
        if (started > 1) {
          // Hold every lookup after the first until all of them started:
          // read one at a time, the second would never let the third start.
          await released;
        }
        return failed("not found", 44);
      },
    });
    const unset = apiKeyVariables().filter((variable) => variable !== "ANTHROPIC_API_KEY");
    const loading = loadApiKeys({ host });
    await vi.waitFor(() => expect(started).toBe(unset.length), { timeout: 1000 });
    release();
    expect(await loading).toEqual({ loaded: [], failed: null });
    expect(runs.map(accountOf).sort()).toEqual([...unset].sort());
  });

  it("stops after a failed first lookup", async () => {
    const { host, runs } = keyringHost({
      answer: async () => ({ ...failed("", null), timedOut: true }),
    });
    const result = await loadApiKeys({ host, timeoutMs: 10 });
    expect(runs).toHaveLength(1);
    expect(result.loaded).toEqual([]);
    expect(result.failed).not.toBeNull();
  });

  it("reads nothing where there is no keyring", async () => {
    const { host, runs } = keyringHost({ os: "windows" });
    expect(await loadApiKeys({ host })).toEqual({ loaded: [], failed: null });
    expect(runs).toHaveLength(0);
  });

  it("is quiet where the keyring command isn't installed", async () => {
    const { host, runs } = keyringHost({
      os: "linux",
      env: memoryEnv({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }),
      answer: async () => {
        throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
      },
    });
    expect(await loadApiKeys({ host })).toEqual({ loaded: [], failed: null });
    expect(runs).toHaveLength(1);
  });

  it("reads nothing on Linux with no D-Bus session", async () => {
    const { host, runs } = keyringHost({ os: "linux" });
    expect(await loadApiKeys({ host })).toEqual({ loaded: [], failed: null });
    expect(runs).toHaveLength(0);
  });
});

describe("keychainWarning", () => {
  it("warns when the keychain failed and there's no key at all", () => {
    expect(keychainWarning({ result: { loaded: [], failed: "locked" }, env: memoryEnv() })).toBe(
      "Couldn't read API keys from the keychain: locked",
    );
  });

  it("is quiet when a key is set anyway", () => {
    const env = memoryEnv({ ANTHROPIC_API_KEY: "sk" });
    expect(keychainWarning({ result: { loaded: [], failed: "locked" }, env })).toBeNull();
  });

  it("is quiet when nothing failed", () => {
    expect(keychainWarning({ result: { loaded: [], failed: null }, env: memoryEnv() })).toBeNull();
  });
});

describe("saveApiKey", () => {
  it("refuses a name that isn't a provider variable", async () => {
    const { host, runs } = keyringHost({});
    await expect(saveApiKey({ host, variable: "PATH", value: "x" })).rejects.toThrow(
      "Not an API key variable: PATH",
    );
    expect(runs).toHaveLength(0);
  });

  it("stores under agency-lang and the variable's name", async () => {
    const { host, runs } = keyringHost({ answer: async () => exited() });
    await saveApiKey({ host, variable: "ANTHROPIC_API_KEY", value: "sk-1" });
    expect(runs).toHaveLength(1);
    expect(runs[0].input).toContain('"-s" "agency-lang" "-a" "ANTHROPIC_API_KEY"');
  });
});
