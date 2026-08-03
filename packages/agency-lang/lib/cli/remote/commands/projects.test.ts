import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RemoteCommandContext } from "./util.js";

const hoisted = vi.hoisted(() => {
  class AccountRequestError extends Error {}
  class AccountScopeError extends AccountRequestError {}
  const client = {
    listProjects: vi.fn(),
    createProject: vi.fn(),
  };
  return { AccountRequestError, AccountScopeError, client, createAccountClient: vi.fn(() => client) };
});

vi.mock("../../statelog/accountClient.js", () => ({
  createAccountClient: hoisted.createAccountClient,
  AccountRequestError: hoisted.AccountRequestError,
  AccountScopeError: hoisted.AccountScopeError,
}));

import { runProjectsList, runProjectsCreate } from "./projects.js";

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-projects-"));
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
  hoisted.client.listProjects.mockReset();
  hoisted.client.createProject.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STATELOG_API_KEY;
  delete process.env.MYKEY;
  vi.restoreAllMocks();
});

describe("runProjectsList", () => {
  it("builds the client from the resolved target and prints projects", async () => {
    hoisted.client.listProjects.mockResolvedValue([
      { projectId: "p", name: "P", description: null },
    ]);
    await runProjectsList({}, context());
    expect(hoisted.createAccountClient).toHaveBeenCalledWith("https://host.example", "secret");
    expect(logs.join("\n")).toContain("p");
  });

  it("renders the empty state", async () => {
    hoisted.client.listProjects.mockResolvedValue([]);
    await runProjectsList({}, context());
    expect(logs.join("\n")).toContain("No projects yet.");
  });

  it("names the resolved env var on a scope error", async () => {
    process.env.MYKEY = "secret2";
    hoisted.client.listProjects.mockRejectedValue(new hoisted.AccountScopeError("scope"));
    await expect(runProjectsList({ apiKeyEnv: "MYKEY" }, context())).rejects.toBeInstanceOf(
      ProcessExit,
    );
    expect(errors.join("\n")).toContain("$MYKEY");
    expect(errors.join("\n")).not.toContain("$STATELOG_API_KEY");
  });

  it("exits once with a generic request error's message", async () => {
    hoisted.client.listProjects.mockRejectedValue(new hoisted.AccountRequestError("server failed"));
    await expect(runProjectsList({}, context())).rejects.toBeInstanceOf(ProcessExit);
    expect(errors.join("\n")).toContain("server failed");
  });
});

describe("runProjectsCreate", () => {
  it("forwards name, slug, and description", async () => {
    hoisted.client.createProject.mockResolvedValue({
      projectId: "foo",
      name: "Foo",
      description: "d",
    });
    await runProjectsCreate("foo", { name: "Foo", description: "d" }, context());
    expect(hoisted.client.createProject).toHaveBeenCalledWith({
      name: "Foo",
      projectId: "foo",
      description: "d",
    });
    expect(logs.join("\n")).toContain("foo");
  });

  it.each(["Upper", "has space", "", "a".repeat(21)])(
    "rejects an invalid project id before any client construction: %s",
    async (badId) => {
      await expect(runProjectsCreate(badId, { name: "Name" }, context())).rejects.toBeInstanceOf(
        ProcessExit,
      );
      expect(hoisted.createAccountClient).not.toHaveBeenCalled();
    },
  );
});
