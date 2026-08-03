import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const deployFn = vi.fn();
vi.mock("../../deploy/deploy.js", () => ({ deploy: (...args: unknown[]) => deployFn(...args) }));
vi.mock("../../deploy/render.js", () => ({ renderOutcome: () => {} }));
// No-endpoint gate and export counting are covered elsewhere; here we exercise
// the binding-write contract, so let the deploy proceed with a nonzero count.
vi.mock("../confirmation.js", () => ({ confirmDeployWithoutExports: async () => true }));
vi.mock("../exportedEndpoints.js", () => ({ countExportedEndpoints: () => ({ nodes: 1, functions: 0 }) }));

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
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const context = () => ({ config: {}, configPath });
const readRemote = () =>
  (JSON.parse(fs.readFileSync(configPath, "utf-8")) as { remote?: { serveUrl?: string } }).remote;

describe("runDeploy binding contract", () => {
  it("writes the binding to the context configPath on a deployed outcome", async () => {
    deployFn.mockResolvedValue({
      kind: "deployed",
      plan: {},
      endpointUrls: [
        "https://h/serve/u/proj/agent.agency/list",
        "https://h/serve/u/proj/agent.agency/node/main",
      ],
      manifest: undefined,
    });
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
