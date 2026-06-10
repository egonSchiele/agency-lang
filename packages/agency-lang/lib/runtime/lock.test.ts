import { describe, expect, it, vi } from "vitest";
import { acquireLocalLock, runLocalLock } from "./lock.js";
import { RuntimeContext } from "./state/context.js";

function makeCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runLocalLock", () => {
  it("serializes concurrent bodies for the same lock name", async () => {
    const ctx = makeCtx();
    const events: string[] = [];

    await Promise.all([
      runLocalLock(ctx, "resource", async () => {
        events.push("a:start");
        await sleep(20);
        events.push("a:end");
      }),
      runLocalLock(ctx, "resource", async () => {
        events.push("b:start");
        await sleep(1);
        events.push("b:end");
      }),
    ]);

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("allows different lock names to run concurrently", async () => {
    const ctx = makeCtx();
    const events: string[] = [];

    await Promise.all([
      runLocalLock(ctx, "a", async () => {
        events.push("a:start");
        await sleep(20);
        events.push("a:end");
      }),
      runLocalLock(ctx, "b", async () => {
        events.push("b:start");
        await sleep(1);
        events.push("b:end");
      }),
    ]);

    expect(events).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });

  it("throws immediately on same-owner reentrancy", async () => {
    const ctx = makeCtx();

    await expect(
      runLocalLock(ctx, "resource", async () =>
        runLocalLock(ctx, "resource", async () => "nested", { ownerId: "same-owner" }),
      { ownerId: "same-owner" }),
    ).rejects.toThrow(/already holds lock 'resource'/);
  });

  it("allows one owner to hold different lock names at the same time", async () => {
    const ctx = makeCtx();

    await expect(
      runLocalLock(ctx, "a", async () =>
        runLocalLock(ctx, "b", async () => "nested", { ownerId: "same-owner" }),
      { ownerId: "same-owner" }),
    ).resolves.toBe("nested");
  });

  it("times out while waiting without blocking later waiters", async () => {
    const ctx = makeCtx();
    const releaseFirst = await acquireLocalLock(ctx, "resource", { ownerId: "first" });

    const timedOut = runLocalLock(ctx, "resource", async () => "never", {
      ownerId: "second",
      timeoutMs: 5,
    });

    await expect(timedOut).rejects.toThrow(/Timed out waiting for lock 'resource'/);

    const later = runLocalLock(ctx, "resource", async () => "later", { ownerId: "third" });
    releaseFirst();

    await expect(later).resolves.toBe("later");
  });

  it("warns when waiting longer than warnAfterMs", async () => {
    const ctx = makeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const releaseFirst = await acquireLocalLock(ctx, "resource", { ownerId: "first" });

    const waiting = runLocalLock(ctx, "resource", async () => "done", {
      ownerId: "second",
      warnAfterMs: 5,
    });

    await sleep(10);
    releaseFirst();
    await waiting;

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Still waiting for lock 'resource'"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("waiter second"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("current owner first"));
    warn.mockRestore();
  });
});
