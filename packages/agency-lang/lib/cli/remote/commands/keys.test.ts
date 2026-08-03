import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RemoteCommandContext } from "./util.js";

const hoisted = vi.hoisted(() => {
  class AccountRequestError extends Error {}
  class AccountScopeError extends AccountRequestError {}
  const client = { listKeys: vi.fn(), createProjectKey: vi.fn() };
  return { AccountRequestError, AccountScopeError, client, createAccountClient: vi.fn(() => client) };
});

vi.mock("../../statelog/accountClient.js", () => ({
  createAccountClient: hoisted.createAccountClient,
  AccountRequestError: hoisted.AccountRequestError,
  AccountScopeError: hoisted.AccountScopeError,
}));

import { runKeysList, runKeysCreate } from "./keys.js";

class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

let dir: string;
let configPath: string;
let logs: string[];
let errors: string[];

function context(): RemoteCommandContext {
  return { config: { log: { host: "https://host.example" } }, configPath };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-keys-"));
  configPath = path.join(dir, "agency.json");
  process.env.STATELOG_API_KEY = "secret";
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExit(code ?? 0);
  }) as never);
  hoisted.createAccountClient.mockClear();
  hoisted.client.listKeys.mockReset();
  hoisted.client.createProjectKey.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STATELOG_API_KEY;
  vi.restoreAllMocks();
});

describe("runKeysList", () => {
  it("prints keys", async () => {
    hoisted.client.listKeys.mockResolvedValue([
      { id: "k1", name: "CI", scope: "project", projectId: "my-proj", createdAt: "2026-08-03" },
    ]);
    await runKeysList({}, context());
    expect(logs.join("\n")).toContain("my-proj");
  });

  it("renders the empty state", async () => {
    hoisted.client.listKeys.mockResolvedValue([]);
    await runKeysList({}, context());
    expect(logs.join("\n")).toContain("No API keys yet.");
  });
});

describe("runKeysCreate", () => {
  it("forwards the public slug and prints the one-time key with a warning", async () => {
    hoisted.client.createProjectKey.mockResolvedValue({
      id: "k1",
      name: "CI",
      scope: "project",
      projectId: "my-proj",
      createdAt: "2026-08-03",
      plainKey: "plain-once",
    });
    await runKeysCreate("CI", { project: "my-proj" }, context());
    expect(hoisted.client.createProjectKey).toHaveBeenCalledWith({ name: "CI", projectId: "my-proj" });
    const out = logs.join("\n");
    expect(out).toContain("plain-once");
    expect(out).toContain("will not be shown again");
  });

  it("names the resolved env var on a scope error", async () => {
    process.env.MYKEY = "secret2";
    hoisted.client.createProjectKey.mockRejectedValue(new hoisted.AccountScopeError("scope"));
    await expect(
      runKeysCreate("CI", { project: "my-proj", apiKeyEnv: "MYKEY" }, context()),
    ).rejects.toBeInstanceOf(ProcessExit);
    expect(errors.join("\n")).toContain("$MYKEY");
    delete process.env.MYKEY;
  });
});
