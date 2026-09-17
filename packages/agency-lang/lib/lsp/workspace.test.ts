import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { configFileDir, getWorkspaceForFile, invalidateWorkspace } from "./workspace.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

describe("configFileDir", () => {
  it("returns the directory of either config file", () => {
    expect(configFileDir("/proj/agency.json")).toBe("/proj");
    expect(configFileDir("/proj/agency.local.json")).toBe("/proj");
  });

  it("returns null for other files", () => {
    expect(configFileDir("/proj/main.agency")).toBeNull();
    expect(configFileDir("/proj/myagency.json")).toBeNull();
  });
});

describe("getWorkspaceForFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agency-lsp-")));
  });
  afterEach(() => {
    invalidateWorkspace(dir);
    vi.restoreAllMocks();
    expect(safeDeleteDirectoryWithin(os.tmpdir(), dir).success).toBe(true);
  });

  const agencyFile = () => {
    const file = path.join(dir, "main.agency");
    fs.writeFileSync(file, "node main() {}\n");
    return file;
  };

  it("merges agency.local.json into the workspace config", () => {
    fs.writeFileSync(
      path.join(dir, "agency.json"),
      JSON.stringify({ outDir: "base", verbose: false }),
    );
    fs.writeFileSync(path.join(dir, "agency.local.json"), JSON.stringify({ outDir: "local" }));

    const workspace = getWorkspaceForFile(agencyFile());

    expect(workspace.root).toBe(dir);
    expect(workspace.config).toEqual({ verbose: false, outDir: "local" });
  });

  it("logs a config error instead of dropping it", () => {
    fs.writeFileSync(path.join(dir, "agency.local.json"), "{ not json");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const workspace = getWorkspaceForFile(agencyFile());

    expect(workspace.config).toEqual({});
    expect(err).toHaveBeenCalledWith(expect.stringContaining("agency.local.json"));
  });
});
