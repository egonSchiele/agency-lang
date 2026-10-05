import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Child } from "./localServe.js";
import {
  createModelPool,
  EXIT_GRACE_MS,
  PoolRefusal,
  type ModelPlan,
  type ModelPool,
  type Running,
} from "./modelPool.js";

/** A model process that exits when it is told to stop, as a real one
 *  does, and can be made to die on its own. */
type FakeChild = Child & { kills: number; die: (code: number) => void };

function fakeChild(): FakeChild {
  const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const child: FakeChild = {
    kills: 0,
    on: (_event, listener) => listeners.push(listener),
    kill: () => {
      child.kills += 1;
      listeners.forEach((listener) => listener(null, "SIGTERM"));
    },
    die: (code) => listeners.forEach((listener) => listener(code, null)),
  };
  return child;
}

function planOf(model: string): ModelPlan {
  return {
    model,
    upstreamModel: `/models/${model}`,
    label: `the server for ${model}`,
    kind: "chat",
    rules: null,
  };
}

describe("createModelPool", () => {
  let children: FakeChild[];
  let nextPort: number;
  let clock: number;
  /** Each load waits on the entry for its model. A test settles it. */
  let loads: Record<string, { finish: () => void; fail: (message: string) => void }>;
  let pool: ModelPool;

  beforeEach(() => {
    children = [];
    nextPort = 9000;
    clock = 1000;
    loads = {};
    pool = createModelPool([planOf("a"), planOf("b")], {
      now: () => clock,
      spawn: async (): Promise<Running> => {
        const child = fakeChild();
        children.push(child);
        return { child, port: nextPort++ };
      },
      waitUntilLoaded: (plan, _running, gone) =>
        Promise.race([
          new Promise<void>((resolve, reject) => {
            loads[plan.model] = { finish: resolve, fail: (message) => reject(new Error(message)) };
          }),
          gone.then((why) => Promise.reject(new Error(`${why} before it was ready.`))),
        ]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the pool's queued work run up to its next wait. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stateOf = (model: string) => pool.status().find((row) => row.model === model)?.state;

  /** Loads a model to ready. */
  async function loadReady(model: string): Promise<void> {
    const loading = pool.load(model);
    await settle();
    loads[model].finish();
    await loading;
  }

  it("lists its models in plan order, all stopped at first", () => {
    expect(pool.models()).toEqual(["a", "b"]);
    expect(pool.status()).toEqual([
      { model: "a", state: "stopped", error: null, requestsInProgress: 0, lastUsedAt: null },
      { model: "b", state: "stopped", error: null, requestsInProgress: 0, lastUsedAt: null },
    ]);
  });

  it("moves a model from stopped through loading to ready, and stamps when it was loaded", async () => {
    const loading = pool.load("a");
    await settle();
    expect(stateOf("a")).toBe("loading");
    clock = 2000;
    loads.a.finish();
    await loading;
    expect(pool.status()[0]).toEqual({
      model: "a",
      state: "ready",
      error: null,
      requestsInProgress: 0,
      lastUsedAt: 2000,
    });
  });

  it("spawns one process for two loads of one model", async () => {
    const first = pool.load("a");
    const second = pool.load("a");
    await settle();
    loads.a.finish();
    await Promise.all([first, second]);
    expect(children).toHaveLength(1);
  });

  it("loads one model at a time", async () => {
    const first = pool.load("a");
    const second = pool.load("b");
    await settle();
    expect(children).toHaveLength(1);
    expect(stateOf("b")).toBe("stopped");
    loads.a.finish();
    await first;
    await settle();
    expect(children).toHaveLength(2);
    loads.b.finish();
    await second;
  });

  it("holds a ready model for a request, and gives it back once", async () => {
    await loadReady("a");
    clock = 3000;
    const held = await pool.acquire("a");
    expect(held.port).toBe(9000);
    expect(held.plan.upstreamModel).toBe("/models/a");
    expect(pool.status()[0]).toMatchObject({ requestsInProgress: 1, lastUsedAt: 3000 });
    clock = 4000;
    held.release();
    held.release();
    expect(pool.status()[0]).toMatchObject({ requestsInProgress: 0, lastUsedAt: 4000 });
  });

  it("makes a request for a loading model wait for the load", async () => {
    const loading = pool.load("a");
    await settle();
    const waiting = pool.acquire("a");
    loads.a.finish();
    await loading;
    expect((await waiting).port).toBe(9000);
    expect(pool.status()[0].requestsInProgress).toBe(1);
  });

  it("refuses a request for a model that is not loaded, and says how to load it", async () => {
    const refused = await pool.acquire("a").catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PoolRefusal);
    expect((refused as PoolRefusal).reason).toBe("not-loaded");
    expect((refused as PoolRefusal).message).toBe(
      'a was unloaded. Load it again with server.load("a"), or restart the server.',
    );
  });

  it("stops a model's process on unload and waits for it to exit", async () => {
    await loadReady("a");
    await pool.unload("a");
    expect(children[0].kills).toBe(1);
    expect(stateOf("a")).toBe("stopped");
  });

  it("starts a new process on a new port when a model is loaded again", async () => {
    await loadReady("a");
    await pool.unload("a");
    await loadReady("a");
    expect(children).toHaveLength(2);
    expect((await pool.acquire("a")).port).toBe(9001);
  });

  it("ends a load in progress on unload, and refuses the requests waiting on it", async () => {
    const loading = pool.load("a").catch((err: Error) => err.message);
    await settle();
    const waiting = pool.acquire("a").catch((err: unknown) => err);
    await pool.unload("a");
    expect(children[0].kills).toBe(1);
    expect(await loading).toBe("the server for a was killed by SIGTERM before it was ready.");
    const refused = await waiting;
    expect(refused).toBeInstanceOf(PoolRefusal);
    expect((refused as PoolRefusal).reason).toBe("load-failed");
    expect(stateOf("a")).toBe("stopped");
  });

  it("marks a model failed, with the reason, when its load fails", async () => {
    const loading = pool.load("a").catch((err: Error) => err.message);
    await settle();
    loads.a.fail("the server for a answered 500 to the readiness request: no");
    expect(await loading).toBe("the server for a answered 500 to the readiness request: no");
    expect(pool.status()[0]).toMatchObject({
      state: "failed",
      error: "the server for a answered 500 to the readiness request: no",
    });
    // The process that failed to load is not left running.
    expect(children[0].kills).toBe(1);
  });

  it("ends a load when a process that was already running dies", async () => {
    await loadReady("a");
    const loading = pool.load("b").catch((err: Error) => err.message);
    await settle();
    children[0].die(9);
    expect(await loading).toBe("the server for a exited with 9 before it was ready.");
  });

  it("reports a process that dies after it was ready, once the grace period has passed", async () => {
    await loadReady("a");
    vi.useFakeTimers();
    let reported: string | undefined;
    void pool.failure.then((why) => {
      reported = why;
    });
    children[0].die(137);
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS - 1);
    expect(reported).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(reported).toBe("the server for a exited with 137.");
    expect(pool.status()[0]).toMatchObject({
      state: "failed",
      error: "the server for a exited with 137.",
    });
  });

  it("does not report a process the pool stopped itself", async () => {
    await loadReady("a");
    await loadReady("b");
    vi.useFakeTimers();
    let reported = false;
    void pool.failure.then(() => {
      reported = true;
    });
    const unloading = pool.unload("a");
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS * 2);
    await unloading;
    pool.stopAll();
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS * 2);
    expect(reported).toBe(false);
    expect(children.map((child) => child.kills)).toEqual([1, 1]);
  });

  it("does not report a process that died just before stopAll, as on Ctrl-C", async () => {
    await loadReady("a");
    vi.useFakeTimers();
    let reported = false;
    void pool.failure.then(() => {
      reported = true;
    });
    children[0].die(130);
    pool.stopAll();
    await vi.advanceTimersByTimeAsync(EXIT_GRACE_MS * 2);
    expect(reported).toBe(false);
  });

  it("refuses a model it was never given", async () => {
    await expect(pool.load("c")).rejects.toThrow("c is not served. Served: a, b.");
    await expect(pool.unload("c")).rejects.toThrow("c is not served. Served: a, b.");
  });
});
