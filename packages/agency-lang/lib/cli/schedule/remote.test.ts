import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveScheduleAdd, addRemote } from "./remote.js";
import { ScheduleRequestError } from "../statelog/schedulesClient.js";
import type { RemoteSchedule } from "../statelog/schedulesClient.js";
import type { RemoteCommandContext } from "../remote/commands/util.js";
import { color } from "@/utils/termcolors.js";

const createMock = vi.fn();
const listMock = vi.fn();
const patchMock = vi.fn();
const deleteMock = vi.fn();
const clientFactoryMock = vi.fn(() => ({
  create: createMock,
  list: listMock,
  patch: patchMock,
  delete: deleteMock,
}));

vi.mock("../statelog/schedulesClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../statelog/schedulesClient.js")>();
  return {
    ...original,
    createSchedulesClient: (...factoryArgs: unknown[]) => clientFactoryMock(...factoryArgs),
  };
});

// The server-authoritative boundary: no remote recipe may ever construct the
// local registry.
vi.mock("./registry.js", () => ({
  Registry: class {
    constructor() {
      throw new Error("Registry must not be touched by remote scheduling");
    }
  },
}));

const KEY_ENV = "SCHEDULE_REMOTE_TEST_KEY";

const context: RemoteCommandContext = {
  config: { log: { host: "https://h" } },
  configPath: "/nonexistent-schedule-remote-test/agency.json",
} as RemoteCommandContext;

const hostlessContext: RemoteCommandContext = {
  config: {},
  configPath: "/nonexistent-schedule-remote-test/agency.json",
} as RemoteCommandContext;

const baseOptions = {
  project: "proj",
  apiKeyEnv: KEY_ENV,
  node: "refresh",
  every: "daily",
  timezone: "UTC",
};

const returnedSchedule: RemoteSchedule = {
  id: "s1",
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

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function errorOutput(): string {
  return errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

beforeEach(() => {
  process.env[KEY_ENV] = "secret-key";
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  delete process.env[KEY_ENV];
  vi.restoreAllMocks();
  createMock.mockReset();
  listMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
  clientFactoryMock.mockClear();
});

describe("resolveScheduleAdd", () => {
  it("resolves a node target with a preset cadence", () => {
    const resolved = resolveScheduleAdd("agents/daily.agency", baseOptions, "Asia/Kolkata");
    expect(resolved).toEqual({
      input: {
        fileName: "daily",
        target: { kind: "node", name: "refresh" },
        args: {},
        cronExpr: "0 9 * * *",
        timezone: "UTC",
      },
      deployMode: "if-missing",
    });
  });

  it("resolves a function target with a raw cron", () => {
    const resolved = resolveScheduleAdd(
      "daily.agency",
      { ...baseOptions, node: undefined, function: "summarize", every: undefined, cron: "*/5 * * * *" },
      "UTC",
    );
    expect(resolved.input.target).toEqual({ kind: "function", name: "summarize" });
    expect(resolved.input.cronExpr).toBe("*/5 * * * *");
  });

  it("derives fileName from a nested path without the extension", () => {
    const resolved = resolveScheduleAdd("some/deep/dir/report.agency", baseOptions, "UTC");
    expect(resolved.input.fileName).toBe("report");
  });

  it("defaults the timezone only when no explicit timezone is given", () => {
    const explicit = resolveScheduleAdd("a.agency", baseOptions, "Asia/Kolkata");
    expect(explicit.input.timezone).toBe("UTC");
    const defaulted = resolveScheduleAdd(
      "a.agency",
      { ...baseOptions, timezone: undefined },
      "Asia/Kolkata",
    );
    expect(defaulted.input.timezone).toBe("Asia/Kolkata");
  });

  it("includes the optional name only when given", () => {
    expect(resolveScheduleAdd("a.agency", baseOptions, "UTC").input).not.toHaveProperty("name");
    expect(
      resolveScheduleAdd("a.agency", { ...baseOptions, name: "mine" }, "UTC").input.name,
    ).toBe("mine");
  });

  it("builds args exactly as buildArgs does (--arg over --data, JSON coercion)", () => {
    const resolved = resolveScheduleAdd(
      "a.agency",
      { ...baseOptions, arg: ["count=3", "x=override"], data: '{"x":1,"keep":"y"}' },
      "UTC",
    );
    expect(resolved.input.args).toEqual({ x: "override", keep: "y", count: 3 });
  });

  it("maps redeploy and no-deploy to deploy modes", () => {
    expect(resolveScheduleAdd("a.agency", baseOptions, "UTC").deployMode).toBe("if-missing");
    expect(
      resolveScheduleAdd("a.agency", { ...baseOptions, redeploy: true }, "UTC").deployMode,
    ).toBe("always");
    expect(
      resolveScheduleAdd("a.agency", { ...baseOptions, deploy: false }, "UTC").deployMode,
    ).toBe("never");
    expect(
      resolveScheduleAdd("a.agency", { ...baseOptions, redeploy: true, deploy: true }, "UTC")
        .deployMode,
    ).toBe("always");
  });

  it.each([
    ["neither target", { ...baseOptions, node: undefined }, /--node <name> or --function <name>/],
    [
      "both targets",
      { ...baseOptions, function: "also" },
      /--node <name> or --function <name>/,
    ],
    [
      "neither cadence",
      { ...baseOptions, every: undefined },
      /--every <preset> or --cron <expression>/,
    ],
    [
      "both cadences",
      { ...baseOptions, cron: "0 * * * *" },
      /--every <preset> or --cron <expression>/,
    ],
    ["invalid preset", { ...baseOptions, every: "fortnightly" }, /Unknown preset/],
    [
      "invalid cron",
      { ...baseOptions, every: undefined, cron: "not a cron" },
      /Invalid cron expression/,
    ],
    ["malformed --arg", { ...baseOptions, arg: ["novalue"] }, /--arg must be name=value/],
    ["non-object --data", { ...baseOptions, data: "[1]" }, /--data must be a JSON object/],
    [
      "redeploy with no-deploy",
      { ...baseOptions, redeploy: true, deploy: false },
      /--redeploy conflicts with --no-deploy/,
    ],
  ])("rejects %s", (_label, options, expected) => {
    expect(() => resolveScheduleAdd("a.agency", options, "UTC")).toThrow(expected);
  });
});

describe("addRemote", () => {
  it("creates the schedule and renders the created id, target, cadence, and timezone", async () => {
    createMock.mockResolvedValue(returnedSchedule);
    await addRemote("agents/daily.agency", { ...baseOptions, deploy: false }, context);
    expect(clientFactoryMock).toHaveBeenCalledTimes(1);
    expect(clientFactoryMock).toHaveBeenCalledWith("https://h", "proj", "secret-key");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      fileName: "daily",
      target: { kind: "node", name: "refresh" },
      args: {},
      cronExpr: "0 9 * * *",
      timezone: "UTC",
    });
    expect(logSpy).toHaveBeenCalledWith(
      `${color.green("Created")} schedule s1: node refresh in daily (0 9 * * *, timezone UTC)`,
    );
  });

  it("guides toward deploy when the agent is not on the server", async () => {
    createMock.mockRejectedValue(new ScheduleRequestError("Agent 'daily' not found", 200));
    await expect(
      addRemote("agents/daily.agency", { ...baseOptions, deploy: false }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("Agent 'daily' not found");
    expect(errorOutput()).toContain("agency remote deploy agents/daily.agency");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("passes an unknown-target server error through unchanged", async () => {
    createMock.mockRejectedValue(
      new ScheduleRequestError('Unknown node "refresh" in daily', 200),
    );
    await expect(
      addRemote("daily.agency", { ...baseOptions, deploy: false }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain('Unknown node "refresh" in daily');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it.each([[401], [403]])("adds full-access-key guidance on HTTP %d", async (status) => {
    createMock.mockRejectedValue(new ScheduleRequestError("not allowed", status));
    await expect(
      addRemote("daily.agency", { ...baseOptions, deploy: false }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("not allowed");
    expect(errorOutput()).toContain("full-access");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("passes an ordinary server error through", async () => {
    createMock.mockRejectedValue(
      new ScheduleRequestError("Project already has the maximum of 20 schedules", 200),
    );
    await expect(
      addRemote("daily.agency", { ...baseOptions, deploy: false }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("Project already has the maximum of 20 schedules");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("never prints the API key on failure", async () => {
    createMock.mockRejectedValue(new ScheduleRequestError("boom", 500));
    await expect(
      addRemote("daily.agency", { ...baseOptions, deploy: false }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).not.toContain("secret-key");
  });

  it("exits on target-resolution failure before creating a client", async () => {
    await expect(
      addRemote(
        "daily.agency",
        { ...baseOptions, deploy: false, project: undefined },
        hostlessContext,
      ),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("No statelog host");
    expect(clientFactoryMock).not.toHaveBeenCalled();
  });

  it("reports option validation errors before target resolution", async () => {
    await expect(
      addRemote(
        "daily.agency",
        { ...baseOptions, deploy: false, function: "also", project: undefined },
        hostlessContext,
      ),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("--node <name> or --function <name>");
    expect(errorOutput()).not.toContain("No statelog host");
    expect(clientFactoryMock).not.toHaveBeenCalled();
  });
});
