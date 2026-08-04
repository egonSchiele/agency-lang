import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RemoteCommandContext } from "./util.js";

const hoisted = vi.hoisted(() => {
  class ProjectRequestError extends Error {}
  const client = { pullSource: vi.fn() };
  return { ProjectRequestError, client, createProjectClient: vi.fn(() => client) };
});
vi.mock("../../statelog/projectClient.js", () => ({
  createProjectClient: hoisted.createProjectClient,
  ProjectRequestError: hoisted.ProjectRequestError,
}));

const pullMocks = vi.hoisted(() => ({ planSourcePull: vi.fn(), applySourcePull: vi.fn() }));
vi.mock("../pullPlan.js", () => ({
  planSourcePull: pullMocks.planSourcePull,
  applySourcePull: pullMocks.applySourcePull,
}));

import { runPull } from "./pull.js";

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-pull-cmd-"));
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
  hoisted.client.pullSource.mockReset();
  pullMocks.planSourcePull.mockReset();
  pullMocks.applySourcePull.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STATELOG_API_KEY;
  vi.restoreAllMocks();
});

describe("runPull", () => {
  it("plans and applies, then prints the summary", async () => {
    hoisted.client.pullSource.mockResolvedValue([{ name: "a.agency", contents: "x" }]);
    pullMocks.planSourcePull.mockReturnValue({
      outputDir: "/out",
      files: [{ name: "a.agency", destination: "/out/a.agency", contents: "x", replace: false }],
    });
    await runPull({ project: "proj", host: "https://h", out: "/out" }, context());
    expect(pullMocks.applySourcePull).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("a.agency");
  });

  it("a plan violation exits non-zero and never applies", async () => {
    hoisted.client.pullSource.mockResolvedValue([{ name: "a.agency", contents: "x" }]);
    pullMocks.planSourcePull.mockImplementation(() => {
      throw new Error("refusing to overwrite existing files (pass --force): a.agency");
    });
    await expect(runPull({ project: "proj", host: "https://h" }, context())).rejects.toBeInstanceOf(
      ProcessExit,
    );
    expect(pullMocks.applySourcePull).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--force");
  });

  it("a mid-apply failure exits non-zero and prints the whole message to stderr", async () => {
    // The non-transactional contract: PullApplyError folds the committed files
    // into its message (covered in pullPlan.test.ts); the command must print
    // that whole message, so stderr names the already-written a.agency too.
    hoisted.client.pullSource.mockResolvedValue([{ name: "b.agency", contents: "y" }]);
    pullMocks.planSourcePull.mockReturnValue({ outputDir: "/out", files: [] });
    pullMocks.applySourcePull.mockImplementation(() => {
      throw new Error(
        "pull failed writing b.agency: EEXIST\nAlready written to disk (not rolled back): /out/a.agency",
      );
    });
    await expect(runPull({ project: "proj", host: "https://h" }, context())).rejects.toBeInstanceOf(
      ProcessExit,
    );
    expect(errors.join("\n")).toContain("/out/a.agency");
    expect(errors.join("\n")).toContain("b.agency");
  });

  it("an unavailable-source failure writes nothing", async () => {
    hoisted.client.pullSource.mockRejectedValue(
      new hoisted.ProjectRequestError("Deployed source is unavailable for one or more files"),
    );
    await expect(runPull({ project: "proj", host: "https://h" }, context())).rejects.toBeInstanceOf(
      ProcessExit,
    );
    expect(pullMocks.planSourcePull).not.toHaveBeenCalled();
    expect(pullMocks.applySourcePull).not.toHaveBeenCalled();
  });
});
