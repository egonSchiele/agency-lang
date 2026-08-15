import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RemoteCommandContext } from "./util.js";

const hoisted = vi.hoisted(() => {
  class ProjectRequestError extends Error {}
  const client = { listTraces: vi.fn(), traceLogs: vi.fn() };
  return { ProjectRequestError, client, createProjectClient: vi.fn(() => client) };
});
vi.mock("../../statelog/projectClient.js", () => ({
  createProjectClient: hoisted.createProjectClient,
  ProjectRequestError: hoisted.ProjectRequestError,
}));

const viewMocks = vi.hoisted(() => ({ openViewer: vi.fn() }));
vi.mock("../../logsView.js", () => ({ openViewer: viewMocks.openViewer }));

import { runLogs } from "./logs.js";

class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

let dir: string;
let configPath: string;
let logs: string[];
let errors: string[];
let stdout: string[];

function context(): RemoteCommandContext {
  return { config: {}, configPath };
}
const opts = { project: "proj", host: "https://h" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-logs-"));
  configPath = path.join(dir, "agency.json");
  process.env.STATELOG_API_KEY = "secret";
  logs = [];
  errors = [];
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => errors.push(a.join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation((text: unknown) => {
    stdout.push(String(text));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExit(code ?? 0);
  }) as never);
  hoisted.createProjectClient.mockClear();
  hoisted.client.listTraces.mockReset();
  hoisted.client.traceLogs.mockReset();
  viewMocks.openViewer.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STATELOG_API_KEY;
  vi.restoreAllMocks();
});

describe("runLogs", () => {
  it("list mode renders the trace table", async () => {
    hoisted.client.listTraces.mockResolvedValue([{ id: "t1", createdAt: "x" }]);
    await runLogs({ kind: "list", json: false }, opts, context());
    expect(logs.join("\n")).toContain("t1");
    expect(viewMocks.openViewer).not.toHaveBeenCalled();
  });

  it("list --json prints one JSON array to stdout only", async () => {
    hoisted.client.listTraces.mockResolvedValue([{ id: "t1", createdAt: "x" }]);
    await runLogs({ kind: "list", json: true }, opts, context());
    expect(stdout).toEqual([`${JSON.stringify([{ id: "t1", createdAt: "x" }])}\n`]);
    expect(logs).toEqual([]);
  });

  it("fetch viewer for an explicit trace opens the viewer with the mapped JSONL", async () => {
    hoisted.client.traceLogs.mockResolvedValue([
      { traceId: "t1", spanId: null, parentSpanId: null, data: { type: "debug", message: "x" } },
    ]);
    await runLogs({ kind: "fetch", traceId: "t1", output: "viewer" }, opts, context());
    expect(hoisted.client.traceLogs).toHaveBeenCalledWith("t1");
    expect(viewMocks.openViewer).toHaveBeenCalledWith({
      jsonl: JSON.stringify({
        trace_id: "t1",
        span_id: null,
        parent_span_id: null,
        data: { type: "debug", message: "x" },
      }),
      terminalInput: "current-stdin",
    });
  });

  it("fetch viewer with no explicit trace opens the latest", async () => {
    hoisted.client.listTraces.mockResolvedValue([{ id: "latest", createdAt: "x" }]);
    hoisted.client.traceLogs.mockResolvedValue([]);
    await runLogs({ kind: "fetch", traceId: undefined, output: "viewer" }, opts, context());
    expect(hoisted.client.traceLogs).toHaveBeenCalledWith("latest");
    expect(viewMocks.openViewer).toHaveBeenCalled();
  });

  it("fetch --json prints the normalized array to stdout and never opens the viewer", async () => {
    hoisted.client.traceLogs.mockResolvedValue([
      { traceId: "t1", spanId: "s", parentSpanId: null, data: { type: "toolCall" } },
    ]);
    await runLogs({ kind: "fetch", traceId: "t1", output: "json" }, opts, context());
    expect(stdout).toEqual([
      `${JSON.stringify([{ trace_id: "t1", span_id: "s", parent_span_id: null, data: { type: "toolCall" } }])}\n`,
    ]);
    expect(viewMocks.openViewer).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("fetch with no traces exits non-zero, writing no JSON", async () => {
    hoisted.client.listTraces.mockResolvedValue([]);
    await expect(
      runLogs({ kind: "fetch", traceId: undefined, output: "json" }, opts, context()),
    ).rejects.toBeInstanceOf(ProcessExit);
    expect(errors.join("\n")).toContain("No traces yet");
    expect(stdout).toEqual([]);
  });

  it("preserves a 'Trace not found' failure verbatim", async () => {
    hoisted.client.traceLogs.mockRejectedValue(new hoisted.ProjectRequestError("Trace not found"));
    await expect(
      runLogs({ kind: "fetch", traceId: "gone", output: "viewer" }, opts, context()),
    ).rejects.toBeInstanceOf(ProcessExit);
    expect(errors.join("\n")).toContain("Trace not found");
  });
});
