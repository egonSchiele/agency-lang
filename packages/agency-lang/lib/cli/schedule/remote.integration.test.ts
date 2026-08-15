// One vertical slice with nothing replaced but the network: real addRemote,
// real binding-based target resolution, real schedules client, stubbed global
// fetch. Proves the layers agree on the wire contract without contacting a
// server. `--no-deploy` keeps the slice off the pullSource/runDeploy paths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { addRemote } from "./remote.js";
import type { RemoteCommandContext } from "../remote/commands/util.js";

const KEY_ENV = "SCHEDULE_VERTICAL_TEST_KEY";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

const createdSchedule = {
  id: "sched-42",
  name: null,
  fileName: "daily",
  targetKind: "node",
  targetName: "refresh",
  args: {},
  cronExpr: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  nextRunAt: "2026-08-10T09:00:00.000Z",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

let dir: string;
let configPath: string;
let configBytes: string;
let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function context(): RemoteCommandContext {
  return { config: {}, configPath } as RemoteCommandContext;
}

const addOptions = {
  node: "refresh",
  every: "daily",
  timezone: "UTC",
  deploy: false,
  apiKeyEnv: KEY_ENV,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-vertical-"));
  configPath = path.join(dir, "agency.json");
  configBytes = `${JSON.stringify(
    { remote: { serveUrl: "https://h/serve/u/proj/daily.agency" } },
    null,
    2,
  )}\n`;
  fs.writeFileSync(configPath, configBytes, "utf-8");
  process.env[KEY_ENV] = "vertical-secret";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  delete process.env[KEY_ENV];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("addRemote vertical contract", () => {
  it("POSTs the exact create request derived from the binding and options", async () => {
    fetchMock.mockResolvedValue(response(200, { success: true, value: createdSchedule }));

    await addRemote("agents/daily.agency", addOptions, context());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://h/api/projects/proj/schedules");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer vertical-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      fileName: "daily",
      targetKind: "node",
      targetName: "refresh",
      args: {},
      cronExpr: "0 9 * * *",
      timezone: "UTC",
    });

    const output = logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(output).toContain("sched-42");
    // Server-authoritative: the slice must not have written any local state.
    expect(fs.readFileSync(configPath, "utf-8")).toBe(configBytes);
    expect(fs.readdirSync(dir)).toEqual(["agency.json"]);
  });

  it("fails cleanly on an HTTP-200 failure envelope", async () => {
    fetchMock.mockResolvedValue(
      response(200, { success: false, error: "Project already has the maximum of 20 schedules" }),
    );

    await expect(addRemote("agents/daily.agency", addOptions, context())).rejects.toThrow("exit:1");

    expect(logSpy).not.toHaveBeenCalled();
    const errors = errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(errors).toContain("Project already has the maximum of 20 schedules");
    expect(errors).not.toContain("vertical-secret");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(configBytes);
  });
});
