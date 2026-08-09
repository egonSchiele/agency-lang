import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runFilesList, formatFilesTable } from "./files.js";
import type { ProjectFile } from "../../statelog/projectClient.js";
import type { RemoteCommandContext } from "./util.js";

const listFilesMock = vi.fn();
vi.mock("../../statelog/projectClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../statelog/projectClient.js")>();
  return {
    ...original,
    createProjectClient: (...clientArgs: unknown[]) => {
      clientFactoryMock(...clientArgs);
      return { listFiles: (...a: unknown[]) => listFilesMock(...a) };
    },
  };
});
const clientFactoryMock = vi.fn();

const KEY_ENV = "FILES_LIST_TEST_KEY";

const context: RemoteCommandContext = {
  config: { log: { host: "https://h" } },
  configPath: "/nonexistent-files-list-test/agency.json",
} as RemoteCommandContext;

const options = { project: "proj", apiKeyEnv: KEY_ENV };

const daily: ProjectFile = {
  id: "f1",
  fileName: "daily",
  nodeNames: ["main", "refresh"],
  hasSource: true,
  bundleEntrypoints: ["daily"],
  updatedAt: "2026-08-09T12:34:56.000Z",
};

const legacy: ProjectFile = {
  id: "f2",
  fileName: "old-probe",
  nodeNames: [],
  hasSource: false,
  bundleEntrypoints: [],
  updatedAt: "2026-05-01T00:00:00.000Z",
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env[KEY_ENV] = "secret-key";
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  delete process.env[KEY_ENV];
  vi.restoreAllMocks();
  listFilesMock.mockReset();
  clientFactoryMock.mockClear();
});

describe("formatFilesTable", () => {
  it("renders the exact table, marking untracked bundles and missing source", () => {
    const expected = [
      "Name".padEnd(11) + "Nodes".padEnd(15) + "Bundles".padEnd(13) + "Source".padEnd(9) +
        "Updated",
      "daily".padEnd(11) + "main, refresh".padEnd(15) + "daily".padEnd(13) + "yes".padEnd(9) +
        "2026-08-09",
      "old-probe".padEnd(11) + "-".padEnd(15) + "(untracked)".padEnd(13) + "MISSING".padEnd(9) +
        "2026-05-01",
    ].join("\n");
    expect(formatFilesTable([daily, legacy])).toBe(expected);
  });

  it("renders the friendly empty state", () => {
    expect(formatFilesTable([])).toBe("No files deployed to this project.");
  });
});

describe("runFilesList", () => {
  it("lists via the resolved target and prints the table", async () => {
    listFilesMock.mockResolvedValue([daily]);
    await runFilesList(options, context);
    expect(clientFactoryMock).toHaveBeenCalledWith("https://h", "proj", "secret-key");
    expect(listFilesMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(formatFilesTable([daily]));
  });

  it("exits with the client's message on failure, printing no table", async () => {
    listFilesMock.mockRejectedValue(new Error("this statelog host does not support the file listing API (upgrade the host)"));
    await expect(runFilesList(options, context)).rejects.toThrow("exit:1");
    expect(logSpy).not.toHaveBeenCalled();
    const errors = errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(errors).toContain("does not support the file listing API");
    expect(errors).not.toContain("secret-key");
  });

  it("exits on target-resolution failure before creating a client", async () => {
    await expect(
      runFilesList(
        { project: undefined, apiKeyEnv: KEY_ENV },
        { config: {}, configPath: "/nonexistent-files-list-test/agency.json" } as RemoteCommandContext,
      ),
    ).rejects.toThrow("exit:1");
    expect(clientFactoryMock).not.toHaveBeenCalled();
  });
});
