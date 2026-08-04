import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RemoteCommandContext } from "./util.js";

const hoisted = vi.hoisted(() => {
  class ProjectRequestError extends Error {}
  const client = {
    inspectAgent: vi.fn(),
    pullSource: vi.fn(),
    listTraces: vi.fn(),
    traceLogs: vi.fn(),
  };
  return { ProjectRequestError, client, createProjectClient: vi.fn(() => client) };
});
vi.mock("../../statelog/projectClient.js", () => ({
  createProjectClient: hoisted.createProjectClient,
  ProjectRequestError: hoisted.ProjectRequestError,
}));

import { runInspect } from "./inspect.js";

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
  return { config: {}, configPath };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-inspect-"));
  configPath = path.join(dir, "agency.json");
  process.env.STATELOG_API_KEY = "secret";
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => errors.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExit(code ?? 0);
  }) as never);
  hoisted.createProjectClient.mockClear();
  for (const fn of Object.values(hoisted.client)) fn.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STATELOG_API_KEY;
  vi.restoreAllMocks();
});

describe("runInspect", () => {
  it("builds the client from the resolved target and renders metadata", async () => {
    hoisted.client.inspectAgent.mockResolvedValue({
      entryPoint: "main.agency",
      lastUploadAt: "t",
      files: [{ name: "main.agency", nodeNames: ["main"], createdAt: "t", updatedAt: "t" }],
    });
    await runInspect({ project: "proj", host: "https://h" }, context());
    expect(hoisted.createProjectClient).toHaveBeenCalledWith("https://h", "proj", "secret");
    expect(logs.join("\n")).toContain("main.agency");
  });

  it("exits cleanly on a client error — message, no stack", async () => {
    hoisted.client.inspectAgent.mockRejectedValue(new hoisted.ProjectRequestError("boom"));
    await expect(runInspect({ project: "proj", host: "https://h" }, context())).rejects.toBeInstanceOf(
      ProcessExit,
    );
    expect(errors.join("\n")).toContain("boom");
    expect(errors.join("\n")).not.toContain("\n    at ");
  });
});
