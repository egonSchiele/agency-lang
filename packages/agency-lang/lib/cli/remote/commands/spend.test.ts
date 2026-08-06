import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RemoteCommandContext } from "./util.js";

const hoisted = vi.hoisted(() => {
  class AccountRequestError extends Error {}
  class AccountScopeError extends AccountRequestError {}
  class ProjectRequestError extends Error {}
  const accountClient = { getAccountSpend: vi.fn() };
  const projectClient = { getSpend: vi.fn() };
  return {
    AccountRequestError,
    AccountScopeError,
    ProjectRequestError,
    accountClient,
    projectClient,
    createAccountClient: vi.fn(() => accountClient),
    createProjectClient: vi.fn(() => projectClient),
  };
});

vi.mock("../../statelog/accountClient.js", () => ({
  createAccountClient: hoisted.createAccountClient,
  AccountRequestError: hoisted.AccountRequestError,
  AccountScopeError: hoisted.AccountScopeError,
}));
vi.mock("../../statelog/projectClient.js", () => ({
  createProjectClient: hoisted.createProjectClient,
  ProjectRequestError: hoisted.ProjectRequestError,
}));

import { runSpend } from "./spend.js";

class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const usd = { inputCost: 0.3, outputCost: 0.2, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0.5, currency: "USD" };
const tok = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 12 };
const spend = { cost: usd, tokens: tok, invocationCount: 3, unpricedCallCount: 0, pricingComplete: true, usageComplete: true, breakdown: [], breakdownTruncated: false, otherSpend: { cost: { inputCost: 0, outputCost: 0, cachedInputCost: 0, cacheCreationInputCost: 0, hostedToolsCost: 0, totalCost: 0, currency: "USD" }, tokens: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 } } };
const accountRows = [{ projectSlug: "p", deletedAt: null, spend }];

let dir: string;
let configPath: string;
let logs: string[];
let stdout: string[];

function context(): RemoteCommandContext {
  return { config: { log: { host: "https://host.example" } }, configPath } as unknown as RemoteCommandContext;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-spend-"));
  configPath = path.join(dir, "agency.json");
  process.env.STATELOG_API_KEY = "secret";
  logs = [];
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => { stdout.push(String(chunk)); return true; }) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new ProcessExit(code ?? 0); }) as never);
  hoisted.createAccountClient.mockClear();
  hoisted.createProjectClient.mockClear();
  hoisted.accountClient.getAccountSpend.mockReset();
  hoisted.projectClient.getSpend.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STATELOG_API_KEY;
  vi.restoreAllMocks();
});

describe("runSpend", () => {
  it("no project → account rollup, passing the resolved window unchanged", async () => {
    hoisted.accountClient.getAccountSpend.mockResolvedValue(accountRows);
    await runSpend(undefined, { from: "1000", to: "2000" }, context());
    expect(hoisted.createAccountClient).toHaveBeenCalledWith("https://host.example", "secret");
    expect(hoisted.accountClient.getAccountSpend).toHaveBeenCalledWith(expect.objectContaining({ from: 1000, to: 2000 }));
    expect(logs.join("\n")).toContain("PROJECT");
  });

  it("<project> → per-project spend via the project client", async () => {
    hoisted.projectClient.getSpend.mockResolvedValue(spend);
    await runSpend("my-proj", { since: "7d" }, context());
    expect(hoisted.createProjectClient).toHaveBeenCalledWith("https://host.example", "my-proj", "secret");
    expect(hoisted.projectClient.getSpend).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("my-proj"); // slug is un-colored; the label is bold-wrapped
  });

  it("an invalid time flag exits without calling any client", async () => {
    await expect(runSpend(undefined, { since: "banana" }, context())).rejects.toBeInstanceOf(ProcessExit);
    expect(hoisted.createAccountClient).not.toHaveBeenCalled();
    expect(hoisted.createProjectClient).not.toHaveBeenCalled();
  });

  it("account path surfaces the project-scoped-key hint", async () => {
    hoisted.accountClient.getAccountSpend.mockRejectedValue(new hoisted.AccountScopeError("scope"));
    await expect(runSpend(undefined, {}, context())).rejects.toBeInstanceOf(ProcessExit);
  });

  it("--json writes exactly the value to stdout and logs nothing", async () => {
    hoisted.projectClient.getSpend.mockResolvedValue(spend);
    await runSpend("my-proj", { json: true }, context());
    expect(stdout.join("")).toBe(`${JSON.stringify(spend)}\n`);
    expect(logs).toEqual([]);
  });
});
