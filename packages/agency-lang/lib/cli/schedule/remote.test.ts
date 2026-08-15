import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveScheduleAdd,
  resolveSchedulePatch,
  addRemote,
  listRemote,
  removeRemote,
  editRemote,
} from "./remote.js";
import { ScheduleRequestError } from "../statelog/schedulesClient.js";
import type { RemoteSchedule } from "../statelog/schedulesClient.js";
import type { RemoteCommandContext } from "../remote/commands/util.js";
import { color } from "@/utils/termcolors.js";

const createMock = vi.fn();
const listMock = vi.fn();
const patchMock = vi.fn();
const deleteMock = vi.fn();
const clientFactoryMock = vi.fn((..._factoryArgs: unknown[]) => ({
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

const runDeployMock = vi.fn();
vi.mock("../remote/commands/deploy.js", () => ({
  runDeploy: (...deployArgs: unknown[]) => runDeployMock(...deployArgs),
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
  return errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
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
  runDeployMock.mockReset();
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
      {
        ...baseOptions,
        node: undefined,
        function: "summarize",
        every: undefined,
        cron: "*/5 * * * *",
      },
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
    expect(resolveScheduleAdd("a.agency", { ...baseOptions, name: "mine" }, "UTC").input.name).toBe(
      "mine",
    );
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
    ["both targets", { ...baseOptions, function: "also" }, /--node <name> or --function <name>/],
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

  it("guides toward rerunning without --no-deploy when the agent is not on the server", async () => {
    createMock.mockRejectedValue(new ScheduleRequestError("Agent 'daily' not found", 200));
    await expect(
      addRemote("agents/daily.agency", { ...baseOptions, deploy: false }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("Agent 'daily' not found");
    expect(errorOutput()).toContain("without --no-deploy");
    // The standalone deploy command resolves its target differently and must
    // not be suggested here.
    expect(errorOutput()).not.toContain("agency remote deploy");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("passes an unknown-target server error through unchanged", async () => {
    createMock.mockRejectedValue(new ScheduleRequestError('Unknown node "refresh" in daily', 200));
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

describe("addRemote deployment policy", () => {
  const agentNotFound = () => new ScheduleRequestError("Agent 'daily' not found", 200);

  it("creates directly, with no deploy, when the agent is on the server", async () => {
    createMock.mockResolvedValue(returnedSchedule);
    await addRemote("agents/daily.agency", baseOptions, context);
    expect(runDeployMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("deploys and retries once, in order, when the server says the agent is missing", async () => {
    createMock.mockRejectedValueOnce(agentNotFound()).mockResolvedValueOnce(returnedSchedule);
    runDeployMock.mockResolvedValue("deployed");
    await addRemote("agents/daily.agency", baseOptions, context);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(runDeployMock).toHaveBeenCalledTimes(1);
    const firstCreate = createMock.mock.invocationCallOrder[0]!;
    const deployOrder = runDeployMock.mock.invocationCallOrder[0]!;
    const retryCreate = createMock.mock.invocationCallOrder[1]!;
    expect(firstCreate).toBeLessThan(deployOrder);
    expect(deployOrder).toBeLessThan(retryCreate);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved target and the same context to runDeploy", async () => {
    createMock.mockRejectedValueOnce(agentNotFound()).mockResolvedValueOnce(returnedSchedule);
    runDeployMock.mockResolvedValue("deployed");
    await addRemote("agents/daily.agency", baseOptions, context);
    expect(runDeployMock).toHaveBeenCalledWith(
      "agents/daily.agency",
      { host: "https://h", project: "proj", apiKeyEnv: KEY_ENV },
      context,
    );
  });

  it("redeploy deploys before the first create attempt", async () => {
    runDeployMock.mockResolvedValue("deployed");
    createMock.mockResolvedValue(returnedSchedule);
    await addRemote("agents/daily.agency", { ...baseOptions, redeploy: true }, context);
    expect(runDeployMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(runDeployMock.mock.invocationCallOrder[0]!).toBeLessThan(
      createMock.mock.invocationCallOrder[0]!,
    );
  });

  it("no-deploy never deploys, even when the agent is missing", async () => {
    createMock.mockRejectedValue(agentNotFound());
    await expect(
      addRemote("agents/daily.agency", { ...baseOptions, deploy: false }, context),
    ).rejects.toThrow("exit:1");
    expect(runDeployMock).not.toHaveBeenCalled();
    expect(errorOutput()).toContain("without --no-deploy");
  });

  it.each([["aborted"], ["preview"]])(
    "a %s deploy outcome does not retry the create",
    async (outcome) => {
      createMock.mockRejectedValue(agentNotFound());
      runDeployMock.mockResolvedValue(outcome);
      await expect(addRemote("agents/daily.agency", baseOptions, context)).rejects.toThrow(
        "exit:1",
      );
      expect(errorOutput()).toContain("Deploy did not complete");
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
    },
  );

  it("a deploy that exits does not retry the create", async () => {
    createMock.mockRejectedValue(agentNotFound());
    runDeployMock.mockRejectedValue(new Error("exit:1"));
    await expect(addRemote("agents/daily.agency", baseOptions, context)).rejects.toThrow("exit:1");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("an unknown-target failure deploys nothing (the file exists; the node does not)", async () => {
    createMock.mockRejectedValue(new ScheduleRequestError('Unknown node "refresh" in daily', 200));
    await expect(addRemote("agents/daily.agency", baseOptions, context)).rejects.toThrow("exit:1");
    expect(runDeployMock).not.toHaveBeenCalled();
    expect(errorOutput()).toContain('Unknown node "refresh" in daily');
  });

  it("a not-found message for a DIFFERENT agent does not trigger a deploy", async () => {
    createMock.mockRejectedValue(new ScheduleRequestError("Agent 'other' not found", 200));
    await expect(addRemote("agents/daily.agency", baseOptions, context)).rejects.toThrow("exit:1");
    expect(runDeployMock).not.toHaveBeenCalled();
  });

  it("a retry failure after a deploy surfaces once with no further retry", async () => {
    createMock
      .mockRejectedValueOnce(agentNotFound())
      .mockRejectedValueOnce(new ScheduleRequestError("cap reached", 200));
    runDeployMock.mockResolvedValue("deployed");
    await expect(addRemote("agents/daily.agency", baseOptions, context)).rejects.toThrow("exit:1");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(runDeployMock).toHaveBeenCalledTimes(1);
    expect(errorOutput()).toContain("cap reached");
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("resolveSchedulePatch", () => {
  it("maps a preset to cronExpr", () => {
    expect(resolveSchedulePatch({ every: "hourly" })).toStrictEqual({ cronExpr: "0 * * * *" });
  });

  it("maps a raw cron to cronExpr", () => {
    expect(resolveSchedulePatch({ cron: "*/10 * * * *" })).toStrictEqual({
      cronExpr: "*/10 * * * *",
    });
  });

  it("maps timezone alone", () => {
    expect(resolveSchedulePatch({ timezone: "Asia/Kolkata" })).toStrictEqual({
      timezone: "Asia/Kolkata",
    });
  });

  it("maps enabled alone", () => {
    expect(resolveSchedulePatch({ enabled: true })).toStrictEqual({ enabled: true });
  });

  it("maps disabled alone", () => {
    expect(resolveSchedulePatch({ disabled: true })).toStrictEqual({ enabled: false });
  });

  it("combines cron, timezone, and disabled into one exact patch", () => {
    expect(resolveSchedulePatch({ every: "daily", timezone: "UTC", disabled: true })).toStrictEqual(
      { cronExpr: "0 9 * * *", timezone: "UTC", enabled: false },
    );
  });

  it("a timezone-only patch has no cronExpr key", () => {
    expect(Object.keys(resolveSchedulePatch({ timezone: "UTC" }))).toEqual(["timezone"]);
  });

  it.each([
    ["both cadences", { every: "daily", cron: "0 * * * *" }, /--every <preset> or --cron/],
    [
      "enabled with disabled",
      { enabled: true, disabled: true },
      /--enabled conflicts with --disabled/,
    ],
    ["an empty edit", {}, /Nothing to change/],
    ["invalid cron", { cron: "nope" }, /Invalid cron expression/],
    ["invalid preset", { every: "fortnightly" }, /Unknown preset/],
  ])("rejects %s", (_label, options, expected) => {
    expect(() => resolveSchedulePatch(options)).toThrow(expected);
  });
});

describe("listRemote", () => {
  const second = {
    ...returnedSchedule,
    id: "sched2",
    name: "second",
    fileName: "report",
    targetKind: "function" as const,
    targetName: "sum",
    cronExpr: "*/5 * * * *",
    timezone: "Asia/Kolkata",
    enabled: false,
  };

  it("renders the exact table in server order", async () => {
    listMock.mockResolvedValue([returnedSchedule, second]);
    await listRemote({ project: "proj", apiKeyEnv: KEY_ENV }, context);
    const expected = [
      "ID".padEnd(8) +
        "Name".padEnd(8) +
        "Target".padEnd(14) +
        "Agent".padEnd(8) +
        "Cron".padEnd(13) +
        "Timezone".padEnd(14) +
        "Enabled",
      "s1".padEnd(8) +
        "-".padEnd(8) +
        "node:refresh".padEnd(14) +
        "daily".padEnd(8) +
        "0 9 * * *".padEnd(13) +
        "UTC".padEnd(14) +
        "yes",
      "sched2".padEnd(8) +
        "second".padEnd(8) +
        "function:sum".padEnd(14) +
        "report".padEnd(8) +
        "*/5 * * * *".padEnd(13) +
        "Asia/Kolkata".padEnd(14) +
        "no",
    ].join("\n");
    expect(logSpy).toHaveBeenCalledWith(expected);
  });

  it("renders the friendly empty-state line", async () => {
    listMock.mockResolvedValue([]);
    await listRemote({ project: "proj", apiKeyEnv: KEY_ENV }, context);
    expect(logSpy).toHaveBeenCalledWith(
      "No remote schedules. Use 'agency schedule add <file> --backend remote' to create one.",
    );
  });

  it("prints no partial table when the list request fails", async () => {
    listMock.mockRejectedValue(new ScheduleRequestError("boom", 500));
    await expect(listRemote({ project: "proj", apiKeyEnv: KEY_ENV }, context)).rejects.toThrow(
      "exit:1",
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorOutput()).toContain("boom");
  });
});

describe("removeRemote", () => {
  it("deletes by the exact server id and reports success", async () => {
    deleteMock.mockResolvedValue({ deleted: true });
    await removeRemote("id/one", { project: "proj", apiKeyEnv: KEY_ENV }, context);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith("id/one");
    expect(logSpy).toHaveBeenCalledWith(`${color.green("Removed")} schedule id/one.`);
  });

  it("maps a not-found failure to id-specific guidance", async () => {
    deleteMock.mockRejectedValue(new ScheduleRequestError("Schedule not found", 200));
    await expect(
      removeRemote("nope", { project: "proj", apiKeyEnv: KEY_ENV }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain('No schedule with id "nope"');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("passes an ordinary failure through without success output", async () => {
    deleteMock.mockRejectedValue(new ScheduleRequestError("db down", 500));
    await expect(
      removeRemote("s1", { project: "proj", apiKeyEnv: KEY_ENV }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("db down");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("a project 404 passes through unchanged, not as schedule-id guidance", async () => {
    deleteMock.mockRejectedValue(new ScheduleRequestError("Project not found", 404));
    await expect(
      removeRemote("s1", { project: "gone", apiKeyEnv: KEY_ENV }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("Project not found");
    expect(errorOutput()).not.toContain("No schedule with id");
  });
});

describe("editRemote", () => {
  it("patches the exact server id with the exact resolved patch", async () => {
    patchMock.mockResolvedValue({ ...returnedSchedule, enabled: false });
    await editRemote(
      "id/one",
      { project: "proj", apiKeyEnv: KEY_ENV, disabled: true, timezone: "UTC" },
      context,
    );
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith("id/one", { timezone: "UTC", enabled: false });
    expect(logSpy).toHaveBeenCalledWith(`${color.green("Updated")} schedule id/one.`);
  });

  it("fails validation before any patch call", async () => {
    await expect(
      editRemote("s1", { project: "proj", apiKeyEnv: KEY_ENV }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("Nothing to change");
    expect(patchMock).not.toHaveBeenCalled();
    expect(clientFactoryMock).not.toHaveBeenCalled();
  });

  it("rejects both cadence flags before any patch call", async () => {
    await expect(
      editRemote(
        "s1",
        { project: "proj", apiKeyEnv: KEY_ENV, every: "daily", cron: "0 * * * *" },
        context,
      ),
    ).rejects.toThrow("exit:1");
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("maps not-found to id-specific guidance and prints no success", async () => {
    patchMock.mockRejectedValue(new ScheduleRequestError("Schedule not found", 200));
    await expect(
      editRemote("nope", { project: "proj", apiKeyEnv: KEY_ENV, enabled: true }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain('No schedule with id "nope"');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("a project 404 passes through unchanged, not as schedule-id guidance", async () => {
    patchMock.mockRejectedValue(new ScheduleRequestError("Project not found", 404));
    await expect(
      editRemote("s1", { project: "gone", apiKeyEnv: KEY_ENV, enabled: true }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("Project not found");
    expect(errorOutput()).not.toContain("No schedule with id");
  });

  it("passes an ordinary failure through", async () => {
    patchMock.mockRejectedValue(new ScheduleRequestError("Invalid input: bad tz", 200));
    await expect(
      editRemote("s1", { project: "proj", apiKeyEnv: KEY_ENV, timezone: "Nope/Nope" }, context),
    ).rejects.toThrow("exit:1");
    expect(errorOutput()).toContain("Invalid input: bad tz");
  });
});
