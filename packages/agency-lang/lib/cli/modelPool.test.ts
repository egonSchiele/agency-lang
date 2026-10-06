import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Child } from "./localServe.js";
import {
  createModelPool,
  evictionCandidate,
  EXIT_GRACE_MS,
  STOP_GRACE_MS,
  PoolRefusal,
  type ModelPlan,
  type ModelPool,
  type ModelRecord,
  type PoolDeps,
  type Running,
} from "./modelPool.js";
import type { MemorySnapshot } from "./availableMemory.js";

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

const GIB = 1024 ** 3;

function planOf(model: string, extra: Partial<ModelPlan> = {}): ModelPlan {
  return {
    model,
    upstreamModel: `/models/${model}`,
    label: `the server for ${model}`,
    kind: "chat",
    rules: null,
    lazy: false,
    needBytes: 10 * GIB,
    ...extra,
  };
}

/** A machine with plenty of memory, for the tests that are not about it. */
const ROOMY: MemorySnapshot = { available: 1000 * GIB, total: 1000 * GIB };

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
      ...poolDeps(),
      availableMemory: async () => ROOMY,
    });
  });

  /** The dependencies every pool in this file shares: processes that are
   *  recorded, and loads a test settles by hand. */
  function poolDeps(): Omit<PoolDeps, "availableMemory"> {
    return {
      now: () => clock,
      allowOvercommit: false,
      log: () => {},
      wait: async () => {},
      spawn: async (): Promise<Running> => {
        const child = fakeChild();
        children.push(child);
        return { child, port: nextPort++ };
      },
      waitReady: (plan, _running, gone) =>
        Promise.race([
          new Promise<void>((resolve, reject) => {
            loads[plan.model] = { finish: resolve, fail: (message) => reject(new Error(message)) };
          }),
          gone.then((why) => Promise.reject(new Error(`${why} before it was ready.`))),
        ]),
    };
  }

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

  it("gives up a load that was unloaded before it spawned", async () => {
    const loading = pool.load("a").catch((err: Error) => err.message);
    const unloading = pool.unload("a");
    expect(await loading).toBe("the server for a was unloaded before it started.");
    await unloading;
    expect(children).toHaveLength(0);
    expect(stateOf("a")).toBe("stopped");
  });

  it("stops a load that was unloaded while it was spawning", async () => {
    let release: () => void = () => {};
    const slowPool = createModelPool([planOf("a")], {
      ...poolDeps(),
      availableMemory: async () => ROOMY,
      spawn: () =>
        new Promise<Running>((resolve) => {
          release = () => {
            const child = fakeChild();
            children.push(child);
            resolve({ child, port: 9000 });
          };
        }),
      waitReady: (_plan, _running, gone) =>
        gone.then((why) => Promise.reject(new Error(`${why} before it was ready.`))),
    });
    const loading = slowPool.load("a").catch((err: Error) => err.message);
    await settle();
    const unloading = slowPool.unload("a");
    release();
    expect(await loading).toBe("the server for a was killed by SIGTERM before it was ready.");
    await unloading;
    expect(children[0].kills).toBe(1);
    expect(slowPool.status()[0].state).toBe("stopped");
  });

  it("refuses a model named after an object property, like any other unknown name", async () => {
    await expect(pool.load("constructor")).rejects.toThrow("constructor is not served.");
    expect(pool.plan("toString")).toBeUndefined();
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

describe("evictionCandidate", () => {
  function record(model: string, extra: Partial<ModelRecord> & { lazy?: boolean }): ModelRecord {
    const { lazy, ...rest } = extra;
    const child: Child = { on: () => undefined, kill: () => undefined };
    return {
      plan: planOf(model, { lazy: lazy ?? true }),
      current: { state: "ready", running: { child, port: 1 } },
      requestsInProgress: 0,
      lastUsedAt: 100,
      ...rest,
    };
  }

  it("picks the loaded lazy model that has been idle longest", () => {
    const older = record("older", { lastUsedAt: 50 });
    const newer = record("newer", { lastUsedAt: 200 });
    expect(evictionCandidate([newer, older])).toBe(older);
  });

  it("skips a model with a request in progress", () => {
    const busy = record("busy", { lastUsedAt: 1, requestsInProgress: 1 });
    const idle = record("idle", { lastUsedAt: 900 });
    expect(evictionCandidate([busy, idle])).toBe(idle);
  });

  it("skips a model that is not lazy", () => {
    const pinned = record("pinned", { lastUsedAt: 1, lazy: false });
    expect(evictionCandidate([pinned])).toBeUndefined();
  });

  it("skips a model that is loading, stopped, or failed", () => {
    const stopped = record("stopped", { current: { state: "stopped" } });
    const failed = record("failed", { current: { state: "failed", error: "x" } });
    const loading = record("loading", {
      current: { state: "loading", running: null, loaded: Promise.resolve() },
    });
    expect(evictionCandidate([stopped, failed, loading])).toBeUndefined();
  });
});

describe("a lazy model", () => {
  let children: FakeChild[];
  let readings: MemorySnapshot[];
  let logged: string[];
  let clock: number;
  let overcommit: boolean;

  beforeEach(() => {
    children = [];
    readings = [];
    logged = [];
    clock = 1000;
    overcommit = false;
  });

  /** A pool whose loads finish at once, over a machine whose memory
   *  readings come from `readings`, the last one repeating. */
  function lazyPool(plans: ModelPlan[]): ModelPool {
    return createModelPool(plans, {
      now: () => clock,
      log: (line) => logged.push(line),
      wait: async () => {},
      get allowOvercommit() {
        return overcommit;
      },
      availableMemory: async () => {
        const next = readings.length > 1 ? readings.shift() : readings[0];
        return next ?? ROOMY;
      },
      spawn: async () => {
        const child = fakeChild();
        children.push(child);
        return { child, port: 9000 + children.length };
      },
      waitReady: async () => {},
    });
  }

  const stateOf = (pool: ModelPool, model: string) =>
    pool.status().find((row) => row.model === model)?.state;

  it("spawns nothing until a request asks for it, then loads and holds it", async () => {
    const pool = lazyPool([planOf("a", { lazy: true })]);
    expect(children).toHaveLength(0);
    const held = await pool.acquire("a");
    expect(children).toHaveLength(1);
    expect(held.port).toBe(9001);
    expect(stateOf(pool, "a")).toBe("ready");
  });

  it("spawns one process for two requests that arrive during the load", async () => {
    const pool = lazyPool([planOf("a", { lazy: true })]);
    const [first, second] = await Promise.all([pool.acquire("a"), pool.acquire("a")]);
    expect(children).toHaveLength(1);
    expect(first.port).toBe(second.port);
    expect(pool.status()[0].requestsInProgress).toBe(2);
  });

  it("stops the lazy model idle longest when the new one does not fit, then loads", async () => {
    const pool = lazyPool([
      planOf("old", { lazy: true }),
      planOf("recent", { lazy: true }),
      planOf("wanted", { lazy: true }),
    ]);
    (await pool.acquire("old")).release();
    clock = 2000;
    (await pool.acquire("recent")).release();
    // Short until one model is stopped, then roomy.
    readings = [{ available: 5 * GIB, total: 64 * GIB }, ROOMY];
    await pool.acquire("wanted");
    expect(stateOf(pool, "old")).toBe("stopped");
    expect(stateOf(pool, "recent")).toBe("ready");
    expect(stateOf(pool, "wanted")).toBe("ready");
    expect(children[0].kills).toBe(1);
    expect(logged.join("\n")).toContain("Stopping old to make room for wanted");
  });

  it("never stops a model with a request in progress, nor one that is not lazy", async () => {
    const pool = lazyPool([
      planOf("pinned", { lazy: false }),
      planOf("busy", { lazy: true }),
      planOf("wanted", { lazy: true }),
    ]);
    await pool.load("pinned");
    const held = await pool.acquire("busy");
    readings = [{ available: 5 * GIB, total: 64 * GIB }];
    const refused = await pool.acquire("wanted").catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PoolRefusal);
    expect((refused as PoolRefusal).reason).toBe("not-enough-memory");
    expect((refused as PoolRefusal).message).toBe(
      "Not enough memory to load wanted (needs about 10.74 GB, 5.37 GB available).\n" +
        "Loaded now: pinned (not lazy), busy (busy).",
    );
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.kills === 0)).toBe(true);
    held.release();
  });

  it("loads anyway when overcommit is allowed, and says so", async () => {
    overcommit = true;
    const pool = lazyPool([planOf("wanted", { lazy: true })]);
    readings = [{ available: 5 * GIB, total: 64 * GIB }];
    await pool.acquire("wanted");
    expect(children).toHaveLength(1);
    expect(logged.join("\n")).toContain("Loading anyway: AGENCY_ALLOW_MEMORY_OVERCOMMIT is set.");
  });

  it("is loaded again by the next request after its process dies, and the server goes on", async () => {
    const pool = lazyPool([planOf("a", { lazy: true })]);
    let reported = false;
    void pool.failure.then(() => {
      reported = true;
    });
    (await pool.acquire("a")).release();
    children[0].die(137);
    // The exit reaches the pool on the next turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stateOf(pool, "a")).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, EXIT_GRACE_MS + 20));
    expect(reported).toBe(false);
    await pool.acquire("a");
    expect(children).toHaveLength(2);
    expect(stateOf(pool, "a")).toBe("ready");
  });

  it("stamps a model warmed with load, so it is not the first to be stopped", async () => {
    const pool = lazyPool([planOf("warmed", { lazy: true }), planOf("used", { lazy: true })]);
    clock = 5000;
    await pool.load("warmed");
    clock = 1000;
    (await pool.acquire("used")).release();
    expect(pool.status().map((row) => row.lastUsedAt)).toEqual([5000, 1000]);
  });
});

describe("stopAll", () => {
  /** A process that exits on SIGKILL only, and a record of the waits the
   *  pool asked for. */
  function stubbornChild(): FakeChild & { signals: string[] } {
    const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    const child: FakeChild & { signals: string[] } = {
      kills: 0,
      signals: [],
      on: (_event, listener) => listeners.push(listener),
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        child.kills += 1;
        child.signals.push(signal);
        if (signal === "SIGKILL") {
          listeners.forEach((listener) => listener(null, "SIGKILL"));
        }
      },
      die: (code) => listeners.forEach((listener) => listener(code, null)),
    };
    return child;
  }

  it("sends SIGKILL to a process that ignores SIGTERM, after the grace period", async () => {
    const waits: number[] = [];
    const child = stubbornChild();
    const pool = createModelPool([planOf("a")], {
      now: Date.now,
      allowOvercommit: false,
      log: () => {},
      availableMemory: async () => ROOMY,
      wait: async (ms) => {
        waits.push(ms);
      },
      spawn: async () => ({ child, port: 9000 }),
      waitReady: async () => {},
    });
    await pool.load("a");
    await pool.stopAll();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(waits[0]).toBe(STOP_GRACE_MS);
    expect(pool.status()[0].state).toBe("stopped");
  });

  it("resolves only once every process has exited", async () => {
    const children: FakeChild[] = [];
    let release: () => void = () => {};
    const pool = createModelPool([planOf("a"), planOf("b")], {
      now: Date.now,
      allowOvercommit: false,
      log: () => {},
      availableMemory: async () => ROOMY,
      // The grace period never ends in this test, so SIGKILL is never sent.
      wait: () => new Promise(() => {}),
      spawn: async () => {
        // Exits a moment after SIGTERM, when the test lets it.
        const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
        const child: FakeChild = {
          kills: 0,
          on: (_event, listener) => listeners.push(listener),
          kill: () => {
            child.kills += 1;
            release = () => listeners.forEach((listener) => listener(null, "SIGTERM"));
          },
          die: () => {},
        };
        children.push(child);
        return { child, port: 9000 + children.length };
      },
      waitReady: async () => {},
    });
    await pool.load("a");
    let closed = false;
    const stopping = pool.stopAll().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(children[0].kills).toBe(1);
    expect(closed).toBe(false);
    release();
    await stopping;
    expect(closed).toBe(true);
  });

  it("ends a load in progress, and refuses loads and requests from then on", async () => {
    const child = fakeChild();
    const pool = createModelPool([planOf("a"), planOf("b")], {
      now: Date.now,
      allowOvercommit: false,
      log: () => {},
      availableMemory: async () => ROOMY,
      wait: async () => {},
      spawn: async () => ({ child, port: 9000 }),
      waitReady: (_plan, _running, gone) =>
        gone.then((why) => Promise.reject(new Error(`${why} before it was ready.`))),
    });
    const loading = pool.load("a").catch((err: Error) => err.message);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await pool.stopAll();
    expect(child.kills).toBe(1);
    expect(await loading).toBe("the server for a was killed by SIGTERM before it was ready.");
    expect(pool.status()[0].state).toBe("stopped");
    const refused = await pool.acquire("b").catch((err: unknown) => err);
    expect((refused as PoolRefusal).reason).toBe("stopping");
    await expect(pool.load("b")).rejects.toThrow("This server is shutting down.");
  });
});
