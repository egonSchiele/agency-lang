import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RemoteCommandContext } from "./util.js";

const hoisted = vi.hoisted(() => {
  class AccountRequestError extends Error {}
  class AccountScopeError extends AccountRequestError {}
  const client = { whoami: vi.fn() };
  return {
    AccountRequestError,
    AccountScopeError,
    client,
    createAccountClient: vi.fn(() => client),
  };
});

vi.mock("../../statelog/accountClient.js", () => ({
  createAccountClient: hoisted.createAccountClient,
  AccountRequestError: hoisted.AccountRequestError,
  AccountScopeError: hoisted.AccountScopeError,
}));

import { runWhoami } from "./whoami.js";

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-whoami-"));
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
  hoisted.client.whoami.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STATELOG_API_KEY;
  vi.restoreAllMocks();
});

describe("runWhoami", () => {
  it("builds the client from the resolved target and prints user and host", async () => {
    hoisted.client.whoami.mockResolvedValue({ userId: "user-1" });
    await runWhoami({ host: "https://host.example" }, context());
    expect(hoisted.createAccountClient).toHaveBeenCalledWith("https://host.example", "secret");
    const out = logs.join("\n");
    expect(out).toContain("user-1");
    expect(out).toContain("https://host.example");
  });

  it("exits cleanly on a client error", async () => {
    hoisted.client.whoami.mockRejectedValue(new hoisted.AccountRequestError("boom"));
    await expect(runWhoami({}, context())).rejects.toBeInstanceOf(ProcessExit);
    expect(errors.join("\n")).toContain("boom");
  });
});
