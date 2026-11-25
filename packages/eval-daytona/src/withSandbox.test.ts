import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FakeSandbox } from "./fakeSandbox.js";
import { deleteAllSandboxes, resetForTests, withSandbox } from "./withSandbox.js";

let clock = 1_000_000;

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

it("deletes the sandbox after use", async () => {
  const sandbox = new FakeSandbox();
  expect(
    await withSandbox(
      async () => sandbox,
      async () => 7,
    ),
  ).toBe(7);
  expect(sandbox.deleted).toBe(true);
});
it("deletes the sandbox when use throws, and rethrows", async () => {
  const sandbox = new FakeSandbox();
  await expect(
    withSandbox(
      async () => sandbox,
      async () => {
        throw new Error("boom");
      },
    ),
  ).rejects.toThrow("boom");
  expect(sandbox.deleted).toBe(true);
});
it("keeps the sandbox and logs its id when asked", async () => {
  const sandbox = new FakeSandbox();
  const lines: string[] = [];
  await withSandbox(
    async () => sandbox,
    async () => 1,
    { keep: true, log: (line) => lines.push(line) },
  );
  expect(sandbox.deleted).toBe(false);
  expect(lines.join("\n")).toContain("fake");
});
it("deleteAllSandboxes deletes every live sandbox, kept ones included", async () => {
  const one = new FakeSandbox();
  const two = new FakeSandbox();
  const hang = () => new Promise<never>(() => {});
  void withSandbox(async () => one, hang);
  void withSandbox(async () => two, hang, { keep: true });
  await tick();
  const logged: string[] = [];
  await deleteAllSandboxes((line) => logged.push(line));
  expect([one.deleted, two.deleted]).toEqual([true, true]);
  expect(logged[0]).toBe("deleting 2 sandboxes");
});
it("deleteAllSandboxes waits for a sandbox that is still being created, then deletes it", async () => {
  const sandbox = new FakeSandbox();
  let finishCreating: (value: FakeSandbox) => void = () => {};
  const creation = new Promise<FakeSandbox>((resolve) => {
    finishCreating = resolve;
  });
  void withSandbox(
    () => creation,
    () => new Promise<never>(() => {}),
  );
  const deleting = deleteAllSandboxes(() => {});
  await tick();
  expect(sandbox.deleted).toBe(false);
  finishCreating(sandbox);
  await deleting;
  expect(sandbox.deleted).toBe(true);
});
it("installs no signal handlers", async () => {
  const before = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
  await withSandbox(
    async () => new FakeSandbox(),
    async () => 1,
  );
  expect(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM")).toBe(before);
});
it("keeps the original error when the delete also fails", async () => {
  const sandbox = new FakeSandbox();
  sandbox.delete = async () => {
    throw new Error("delete failed");
  };
  await expect(
    withSandbox(
      async () => sandbox,
      async () => {
        throw new Error("boom");
      },
    ),
  ).rejects.toThrow("boom");
});
