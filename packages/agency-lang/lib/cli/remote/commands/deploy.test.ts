import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { ExportedEndpointCount } from "../exportedEndpoints.js";

const deployFn = vi.fn();
const confirmFn = vi.fn(async () => true);
const countFn = vi.fn((): ExportedEndpointCount => ({ nodes: 1, functions: 0, imported: [] }));
vi.mock("../../deploy/deploy.js", () => ({ deploy: (...args: unknown[]) => deployFn(...args) }));
vi.mock("../../deploy/render.js", () => ({ renderOutcome: () => {} }));
vi.mock("../confirmation.js", () => ({
  confirmDeployWithoutExports: (...args: unknown[]) => confirmFn(...(args as [])),
}));
vi.mock("../exportedEndpoints.js", () => ({ countExportedEndpoints: () => countFn() }));

const { runDeploy } = await import("./deploy.js");

class ProcessExit extends Error {}

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-deploy-"));
  configPath = path.join(dir, "agency.json");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new ProcessExit();
  }) as never);
  deployFn.mockReset();
  confirmFn.mockReset().mockResolvedValue(true);
  countFn.mockReset().mockReturnValue({ nodes: 1, functions: 0, imported: [] });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const context = () => ({ config: {}, configPath });
const readRemote = () =>
  (JSON.parse(fs.readFileSync(configPath, "utf-8")) as { remote?: { serveUrl?: string } }).remote;

const deployedOutcome = {
  kind: "deployed",
  plan: {},
  endpointUrls: [
    "https://h/serve/u/proj/agent.agency/list",
    "https://h/serve/u/proj/agent.agency/node/main",
  ],
  manifest: undefined,
};

describe("runDeploy binding contract", () => {
  it("writes the binding to the context configPath on a deployed outcome", async () => {
    deployFn.mockResolvedValue(deployedOutcome);
    await runDeploy("agent.agency", {}, context());
    expect(readRemote()).toEqual({ serveUrl: "https://h/serve/u/proj/agent.agency" });
  });

  it("does not write a binding for a preview (dry-run) outcome", async () => {
    deployFn.mockResolvedValue({ kind: "preview", plan: {} });
    await runDeploy("agent.agency", { dryRun: true }, context());
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("exits and writes no binding on an error outcome", async () => {
    deployFn.mockResolvedValue({ kind: "error", error: "compile failed" });
    await expect(runDeploy("agent.agency", {}, context())).rejects.toBeInstanceOf(ProcessExit);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("runDeploy outcome contract", () => {
  it("returns 'deployed' when the binding is written", async () => {
    deployFn.mockResolvedValue(deployedOutcome);
    await expect(runDeploy("agent.agency", {}, context())).resolves.toBe("deployed");
    expect(readRemote()).toEqual({ serveUrl: "https://h/serve/u/proj/agent.agency" });
  });

  it("returns 'deployed' without a binding when no serve URL can be derived", async () => {
    deployFn.mockResolvedValue({
      kind: "deployed",
      plan: {},
      endpointUrls: ["not a serve url"],
      manifest: undefined,
    });
    await expect(runDeploy("agent.agency", {}, context())).resolves.toBe("deployed");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("returns 'preview' for a dry-run outcome", async () => {
    deployFn.mockResolvedValue({ kind: "preview", plan: {} });
    await expect(runDeploy("agent.agency", { dryRun: true }, context())).resolves.toBe("preview");
  });

  it("returns 'aborted' without deploying when the no-exports confirmation is declined", async () => {
    countFn.mockReturnValue({ nodes: 0, functions: 0, imported: [] });
    confirmFn.mockResolvedValue(false);
    await expect(runDeploy("agent.agency", {}, context())).resolves.toBe("aborted");
    expect(deployFn).not.toHaveBeenCalled();
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("names imported files whose exports are not served, with the re-export fix", async () => {
    countFn.mockReturnValue({
      nodes: 0,
      functions: 0,
      imported: [{ file: "lib.agency", names: ["helper", "greet"] }],
    });
    confirmFn.mockResolvedValue(false);
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    try {
      await runDeploy("agent.agency", {}, context());
    } finally {
      logSpy.mockRestore();
    }
    const text = logged.join("\n");
    expect(text).toContain("Only exports in the entry point (agent.agency) are served.");
    expect(text).toContain('export { helper, greet } from "./lib.agency"');
  });

  it("produces no outcome after an error exit", async () => {
    deployFn.mockResolvedValue({ kind: "error", error: "compile failed" });
    await expect(runDeploy("agent.agency", {}, context())).rejects.toBeInstanceOf(ProcessExit);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
