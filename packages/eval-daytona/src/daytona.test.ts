import { expect, it } from "vitest";

import { createDaytonaSandbox, deleteDaytonaSandbox, listDaytonaSandboxes } from "./daytona.js";
import { SandboxTimeoutError } from "./types.js";

type Recorded = {
  creates: { params: Record<string, unknown>; options: Record<string, unknown> }[];
  execs: { command: string; timeout: number | undefined }[];
  sessions: string[];
  sessionCommands: { command: string; runAsync?: boolean }[];
  deleted: string[];
  listQueries: unknown[];
};

function fakeClient(
  overrides: { failCreates?: number; createError?: () => Error; exec?: () => unknown; clock?: number[] } = {},
) {
  const recorded: Recorded = { creates: [], execs: [], sessions: [], sessionCommands: [], deleted: [], listQueries: [] };
  let failures = overrides.failCreates ?? 0;
  const remote = (id: string, labels: Record<string, string>) => ({
    id,
    state: "started",
    createdAt: "2026-11-24T00:00:00Z",
    labels,
    process: {
      async executeCommand(command: string, _cwd?: string, _env?: Record<string, string>, timeout?: number) {
        recorded.execs.push({ command, timeout });
        return (overrides.exec?.() ?? { exitCode: 3, result: "bad" }) as { exitCode: number; result: string };
      },
      async createSession(id: string) {
        recorded.sessions.push(id);
      },
      async executeSessionCommand(_id: string, request: { command: string; runAsync?: boolean }) {
        recorded.sessionCommands.push(request);
        return {};
      },
    },
    fs: {
      async uploadFile() {},
      async downloadFile() {
        return Buffer.from("x");
      },
    },
  });
  const client = {
    async create(params: Record<string, unknown>, options: Record<string, unknown>) {
      recorded.creates.push({ params, options });
      if (failures > 0) {
        failures -= 1;
        throw overrides.createError?.() ?? new Error("quota exceeded");
      }
      return remote("one", (params.labels ?? {}) as Record<string, string>);
    },
    async get(id: string) {
      return remote(id, {});
    },
    async *list(query?: { labels?: Record<string, string> }) {
      recorded.listQueries.push(query);
      yield remote("one", { suite: "s", mode: "run" });
      yield remote("two", { suite: "other" });
    },
    async delete(sandbox: { id: string }) {
      recorded.deleted.push(sandbox.id);
    },
  };
  const clock = [...(overrides.clock ?? [])];
  const now = overrides.clock === undefined ? undefined : () => clock.shift() ?? 0;
  return { recorded, deps: { client, sleep: async () => {}, now } };
}

it("creates with the defaults", async () => {
  const { recorded, deps } = fakeClient();
  await createDaytonaSandbox({ image: "node:22", labels: { suite: "s" } }, deps);
  expect(recorded.creates).toEqual([
    {
      params: {
        image: "node:22",
        labels: { suite: "s" },
        resources: { cpu: 4, memory: 8, disk: 10 },
        autoStopInterval: 120,
        autoDeleteInterval: 240,
      },
      options: { timeout: 600 },
    },
  ]);
});
it("tries the creation a second time", async () => {
  const { recorded, deps } = fakeClient({ failCreates: 1 });
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  expect(recorded.creates).toHaveLength(2);
  expect(sandbox.id).toBe("one");
});
it("throws the second failure", async () => {
  const { deps } = fakeClient({ failCreates: 2 });
  await expect(createDaytonaSandbox({ image: "node:22" }, deps)).rejects.toThrow("quota");
});
it("returns a non-zero exit as a result", async () => {
  const { deps } = fakeClient();
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  expect(await sandbox.exec("false")).toEqual({ exitCode: 3, output: "bad" });
});
it("runs the line with bash", async () => {
  const { recorded, deps } = fakeClient();
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  await sandbox.exec("echo 'a b'");
  expect(recorded.execs[0].command).toBe(`bash -c 'echo '\\''a b'\\'''`);
});
it("passes timeoutSec, defaulting to 600", async () => {
  const { recorded, deps } = fakeClient();
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  await sandbox.exec("a");
  await sandbox.exec("b", { timeoutSec: 30 });
  expect(recorded.execs.map((e) => e.timeout)).toEqual([600, 30]);
});
it("throws SandboxTimeoutError when the SDK reports a timeout after the full limit", async () => {
  class DaytonaProcessExecutionTimeoutError extends Error {}
  const { deps } = fakeClient({
    clock: [0, 1000],
    exec: () => {
      throw new DaytonaProcessExecutionTimeoutError("deadline");
    },
  });
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  const error = await sandbox.exec("sleep 9", { timeoutSec: 1 }).catch((e) => e);
  expect(error).toBeInstanceOf(SandboxTimeoutError);
  expect(error.message).toBe("sleep 9 did not finish within 1s");
});
it("passes on a connection timeout that came back at once: the command did not run long", async () => {
  class DaytonaConnectionTimeoutError extends Error {}
  const { deps } = fakeClient({
    clock: [0, 50],
    exec: () => {
      throw new DaytonaConnectionTimeoutError("connect timed out");
    },
  });
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  const error = await sandbox.exec("make", { timeoutSec: 2700 }).catch((e) => e);
  expect(error).toBeInstanceOf(DaytonaConnectionTimeoutError);
  expect(error).not.toBeInstanceOf(SandboxTimeoutError);
});
it("passes on a connection timeout even after the full limit", async () => {
  class DaytonaConnectionTimeoutError extends Error {}
  const { deps } = fakeClient({
    clock: [0, 5000],
    exec: () => {
      throw new DaytonaConnectionTimeoutError("read timed out");
    },
  });
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  const error = await sandbox.exec("make", { timeoutSec: 1 }).catch((e) => e);
  expect(error).toBeInstanceOf(DaytonaConnectionTimeoutError);
});
it("deletes the sandbox a timed-out creation left behind, then tries again", async () => {
  const { recorded, deps } = fakeClient({
    failCreates: 1,
    createError: () => Object.assign(new Error("create timed out"), { sandboxId: "orphan" }),
  });
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  expect(recorded.deleted).toEqual(["orphan"]);
  expect(recorded.creates).toHaveLength(2);
  expect(sandbox.id).toBe("one");
});
it("does not retry an error that will not change, such as a bad key", async () => {
  class DaytonaAuthenticationError extends Error {}
  const { recorded, deps } = fakeClient({
    failCreates: 1,
    createError: () => new DaytonaAuthenticationError("invalid API key"),
  });
  await expect(createDaytonaSandbox({ image: "node:22" }, deps)).rejects.toThrow("invalid API key");
  expect(recorded.creates).toHaveLength(1);
});
it("asks the server to filter the listing by label", async () => {
  const { recorded, deps } = fakeClient();
  await listDaytonaSandboxes({ suite: "s" }, deps);
  expect(recorded.listQueries).toEqual([{ labels: { suite: "s" } }]);
});
it("rethrows any other SDK error as it is", async () => {
  class DaytonaBadGatewayError extends Error {}
  const { deps } = fakeClient({
    exec: () => {
      throw new DaytonaBadGatewayError("502");
    },
  });
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  const error = await sandbox.exec("ls").catch((e) => e);
  expect(error).toBeInstanceOf(DaytonaBadGatewayError);
  expect(error).not.toBeInstanceOf(SandboxTimeoutError);
});
it("starts a background command in a new session, asynchronously", async () => {
  const { recorded, deps } = fakeClient();
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  await sandbox.startBackground("sleep 1");
  expect(recorded.sessions).toHaveLength(1);
  expect(recorded.sessionCommands).toEqual([{ command: "sleep 1", runAsync: true }]);
});
it("deletes through the client", async () => {
  const { recorded, deps } = fakeClient();
  const sandbox = await createDaytonaSandbox({ image: "node:22" }, deps);
  await sandbox.delete();
  expect(recorded.deleted).toEqual(["one"]);
});
it("lists only sandboxes carrying every given label", async () => {
  const { deps } = fakeClient();
  const found = await listDaytonaSandboxes({ suite: "s" }, deps);
  expect(found).toEqual([
    { id: "one", state: "started", createdAt: "2026-11-24T00:00:00Z", labels: { suite: "s", mode: "run" } },
  ]);
});
it("deletes a sandbox by id", async () => {
  const { recorded, deps } = fakeClient();
  await deleteDaytonaSandbox("abc", deps);
  expect(recorded.deleted).toEqual(["abc"]);
});
