import type { Child, ServeKind } from "./localServe.js";
import type { RequestRules } from "./requestRules.js";
import { fits, memoryReserve, type MemorySnapshot } from "./availableMemory.js";
import { formatGB } from "../stdlib/localModels.js";

/** The model processes behind `agency local serve`. The pool owns one
 *  record per served model. It is the only code that starts or stops a
 *  model process, and the only code that writes a record. The front door
 *  asks it for a model to send a request to, and hands the model back when
 *  the request ends. */

/** What is fixed about a served model once it is planned.
 *
 *  model          the name requests use for it
 *  upstreamModel  the string its process was started with. A request's
 *                 `model` is rewritten to this, because mlx_lm.server
 *                 loads whatever model a request names
 *  label          how its process is named in a message, such as
 *                 "mlx_lm.server for org/a"
 *  rules          the request rules of its chat runtime, or null
 *  lazy           loaded on its first request, and stopped when another
 *                 lazy model needs the memory. A model that is not lazy
 *                 loads at startup and is never stopped to make room
 *  needBytes      the memory loading it is expected to take
 *  stopsOnClose   whether closing the connection to the process stops the
 *                 request with this body. See `ChatRuntimeSpec` */
export type ModelPlan = {
  model: string;
  upstreamModel: string;
  label: string;
  kind: ServeKind;
  rules: RequestRules | null;
  lazy: boolean;
  needBytes: number;
  stopsOnClose: (body: Record<string, unknown>) => boolean;
};

/** A model process and the port it listens on. */
export type Running = { child: Child; port: number };

/** What a model's process is doing. Each state has the fields that state
 *  has, so a record cannot say "ready" and hold no process.
 *
 *  A loading model has no process for the moment between the load
 *  starting and the spawn returning. `loaded` settles when the load ends,
 *  for requests that arrive during it. */
export type ModelState =
  | { state: "stopped" }
  | { state: "loading"; running: Running | null; loaded: Promise<void> }
  | { state: "ready"; running: Running }
  | { state: "failed"; error: string };

export type ModelRecord = {
  plan: ModelPlan;
  current: ModelState;
  requestsInProgress: number;
  /** When a request last started or ended, or the load finished. Null for
   *  a model that has never been loaded. */
  lastUsedAt: number | null;
};

/** One model as `status()` and `GET /v1/agency/status` report it. */
export type ModelStatus = {
  model: string;
  state: ModelState["state"];
  error: string | null;
  requestsInProgress: number;
  lastUsedAt: number | null;
};

/** A model held for one request. Its count of requests in progress is
 *  already raised, and `release` lowers it. A second call to `release`
 *  does nothing. */
export type Held = { plan: ModelPlan; port: number; release: () => void };

/** Why the pool will not hand out a model.
 *
 *  not-loaded         the model was unloaded, and nothing will load it
 *                     again until `load` is called
 *  load-failed        the load a request was waiting on failed
 *  not-enough-memory  a lazy model does not fit, and no loaded lazy model
 *                     is idle to be stopped for it
 *  stopping           the server is shutting down */
export type RefusalReason = "not-loaded" | "load-failed" | "not-enough-memory" | "stopping";

export class PoolRefusal extends Error {
  reason: RefusalReason;

  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** How long `stopAll` gives a process to exit after SIGTERM before it
 *  sends SIGKILL, and then how long it waits for that. */
export const STOP_GRACE_MS = 5000;

/** How long after a process exits the pool waits before calling it a
 *  failure. A terminal Ctrl-C reaches the model processes before it
 *  reaches this one, so an exit can arrive just before `stopAll` does. */
export const EXIT_GRACE_MS = 250;

export type PoolDeps = {
  /** Picks a port and starts the model's process. Returns as soon as the
   *  process exists, long before the model has loaded. */
  spawn: (plan: ModelPlan) => Promise<Running>;
  /** Resolves when the process answers. Rejects if it answers wrongly, or
   *  when `gone` resolves, which says a process exited. */
  waitReady: (plan: ModelPlan, running: Running, gone: Promise<string>) => Promise<void>;
  now: () => number;
  availableMemory: () => Promise<MemorySnapshot>;
  /** Load a lazy model even when the estimate says it does not fit. */
  allowOvercommit: boolean;
  log: (line: string) => void;
  /** Resolves after `ms`. Tests pass one that does not wait. */
  wait: (ms: number) => Promise<void>;
};

export type ModelPool = {
  /** The names of the served models, in plan order. */
  models: () => string[];
  status: () => ModelStatus[];
  plan: (model: string) => ModelPlan | undefined;
  /** Holds a loaded model for one request, waiting for a load in progress
   *  and starting one for a lazy model that is not loaded. Rejects with a
   *  `PoolRefusal` for any other model that is not loaded. */
  acquire: (model: string) => Promise<Held>;
  /** Starts a model's process and resolves when the model is ready. Does
   *  nothing for a model that is ready already. */
  load: (model: string) => Promise<void>;
  /** Stops a model's process and resolves when it has exited. A load in
   *  progress is ended, and the requests waiting on it are refused. */
  unload: (model: string) => Promise<void>;
  /** Refuses every later load and request, sends SIGTERM to every process,
   *  waits up to `STOP_GRACE_MS` for them to exit, sends SIGKILL to those
   *  still running, and waits for those exits. */
  stopAll: () => Promise<void>;
  /** Resolves with a message when a process dies after it was ready. */
  failure: Promise<string>;
};

/** Resolves with a description once the child exits. */
function exitOf(child: Child, label: string): Promise<string> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      const how = signal !== null ? `was killed by ${signal}` : `exited with ${code}`;
      resolve(`${label} ${how}`);
    });
  });
}

/** The loaded lazy model that has been idle longest, or undefined when
 *  every loaded model is busy or is not lazy. A model that is not lazy is
 *  never stopped to make room. */
export function evictionCandidate(records: ModelRecord[]): ModelRecord | undefined {
  const idle = records.filter(
    (record) =>
      record.plan.lazy && record.current.state === "ready" && record.requestsInProgress === 0,
  );
  return idle.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
}

/** Why a loaded model was not stopped to make room: it is busy, or it is
 *  not lazy. */
function keptBecause(record: ModelRecord): string {
  return record.requestsInProgress > 0 ? "busy" : "not lazy";
}

function notEnoughMemoryMessage(
  plan: ModelPlan,
  memory: MemorySnapshot,
  loaded: ModelRecord[],
): string {
  const kept = loaded.map((record) => `${record.plan.model} (${keptBecause(record)})`);
  const now = kept.length === 0 ? "nothing" : kept.join(", ");
  return (
    `Not enough memory to load ${plan.model} (needs about ${formatGB(plan.needBytes)}, ` +
    `${formatGB(memory.available)} available).\nLoaded now: ${now}.`
  );
}

function notLoadedMessage(model: string): string {
  return `${model} was unloaded. Load it again with server.load("${model}"), or restart the server.`;
}

/** A queue that runs one job at a time, in the order they were added. A
 *  job that fails does not stop the ones after it. */
function createQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
  };
}

/** The record's process, when it has one. */
function runningOf(record: ModelRecord): Running | null {
  const current = record.current;
  return current.state === "ready" || current.state === "loading" ? current.running : null;
}

function statusOf(record: ModelRecord): ModelStatus {
  return {
    model: record.plan.model,
    state: record.current.state,
    error: record.current.state === "failed" ? record.current.error : null,
    requestsInProgress: record.requestsInProgress,
    lastUsedAt: record.lastUsedAt,
  };
}

/** Counts one request on the record, and returns the way to end it. */
function hold(record: ModelRecord, running: Running, now: () => number): Held {
  record.requestsInProgress += 1;
  record.lastUsedAt = now();
  let released = false;
  return {
    plan: record.plan,
    port: running.port,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      record.requestsInProgress -= 1;
      record.lastUsedAt = now();
    },
  };
}

/** Everything the pool's functions share. One is made per pool. */
type PoolState = {
  plans: ModelPlan[];
  records: Record<string, ModelRecord>;
  deps: PoolDeps;
  /** One entry per process that is running. A load waits on all of them,
   *  so any process dying ends the wait. */
  exits: Promise<string>[];
  /** The processes the pool itself told to stop. Their exits are not
   *  failures. */
  stoppedByPool: Child[];
  /** The models an `unload` is waiting to stop. A load of one of them
   *  gives up as early as it can, instead of finishing first. */
  stopRequested: string[];
  stopping: boolean;
  reportFailure: (why: string) => void;
};

/** Tells a process to stop, once, and remembers that the pool did. */
function kill(state: PoolState, running: Running): void {
  if (state.stoppedByPool.includes(running.child)) {
    return;
  }
  state.stoppedByPool.push(running.child);
  running.child.kill();
}

/** Resolves true when `exited` settles within `ms`, false otherwise. */
async function exitedWithin(
  state: PoolState,
  exited: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return Promise.race([exited.then(() => true), state.deps.wait(ms).then(() => false)]);
}

type Stopping = { process: Running; exited: Promise<string> };

/** Sends SIGTERM to every process, at once, and marks every record
 *  stopped. A process that is still loading is included, so a load in
 *  progress ends. */
function signalEverything(state: PoolState): Stopping[] {
  return Object.values(state.records).flatMap((record) => {
    const process = runningOf(record);
    record.current = { state: "stopped" };
    if (process === null) {
      return [];
    }
    const exited = exitOf(process.child, record.plan.label);
    kill(state, process);
    return [{ process, exited }];
  });
}

/** Waits for the signalled processes: a grace period, then SIGKILL for
 *  the rest and a wait for their exits, which a SIGKILL brings. Runs on
 *  the queue, so a process spawned by a load that was in progress when
 *  the first signal went out is signalled here too. */
async function waitForExits(state: PoolState, signalled: Stopping[]): Promise<void> {
  const exits = [...signalled, ...signalEverything(state)];
  const allExited = Promise.all(exits.map((exit) => exit.exited));
  if (await exitedWithin(state, allExited, STOP_GRACE_MS)) {
    return;
  }
  const stubborn = await Promise.all(
    exits.map(async (exit) => ((await exitedWithin(state, exit.exited, 0)) ? null : exit)),
  );
  for (const exit of stubborn) {
    if (exit !== null) {
      exit.process.child.kill("SIGKILL");
    }
  }
  await allExited;
}

/** A process exited. If it is still its record's process and the pool
 *  did not stop it, the record has failed. One that had finished loading
 *  is also reported through `failure`, after the grace period. */
function onExit(state: PoolState, record: ModelRecord, running: Running, why: string): void {
  if (runningOf(record) !== running || state.stoppedByPool.includes(running.child)) {
    return;
  }
  const wasReady = record.current.state === "ready";
  record.current = { state: "failed", error: `${why}.` };
  // A lazy model is loaded again by its next request, so its death is
  // not the end of the server.
  if (!wasReady || record.plan.lazy) {
    return;
  }
  setTimeout(() => {
    if (!state.stopping) {
      state.reportFailure(`${why}.`);
    }
  }, EXIT_GRACE_MS);
}

/** Runs on the queue. Stops the record's process, if it has one, and
 *  waits for it to exit. */
async function stopRecord(state: PoolState, record: ModelRecord): Promise<void> {
  const index = state.stopRequested.indexOf(record.plan.model);
  if (index !== -1) {
    state.stopRequested.splice(index, 1);
  }
  const running = runningOf(record);
  // Stopped before the signal, so no request is handed a process that is
  // on its way out.
  record.current = { state: "stopped" };
  if (running !== null) {
    const exited = exitOf(running.child, record.plan.label);
    kill(state, running);
    await exited;
  }
}

/** Runs on the queue, before a lazy model's spawn. Stops idle lazy
 *  models, longest idle first, until the model fits with the reserve left
 *  free. With nothing left to stop, refuses. */
async function makeRoom(state: PoolState, record: ModelRecord): Promise<void> {
  const { deps } = state;
  for (;;) {
    const memory = await deps.availableMemory();
    if (fits(record.plan.needBytes, memory)) {
      return;
    }
    const records = Object.values(state.records);
    const candidate = evictionCandidate(records);
    if (candidate === undefined) {
      const loaded = records.filter((other) => other.current.state === "ready");
      const message = notEnoughMemoryMessage(record.plan, memory, loaded);
      if (deps.allowOvercommit) {
        deps.log(`${message}\nLoading anyway: AGENCY_ALLOW_MEMORY_OVERCOMMIT is set.`);
        return;
      }
      throw new PoolRefusal("not-enough-memory", message);
    }
    deps.log(
      `Stopping ${candidate.plan.model} to make room for ${record.plan.model} ` +
        `(${formatGB(memory.available)} available, ${formatGB(memoryReserve(memory))} kept free).`,
    );
    await stopRecord(state, candidate);
  }
}

/** Starts the record's process and watches for its exit. */
async function spawnRecord(state: PoolState, record: ModelRecord): Promise<Running> {
  const running = await state.deps.spawn(record.plan);
  const exited = exitOf(running.child, record.plan.label);
  state.exits.push(exited);
  void exited.then((why) => {
    state.exits = state.exits.filter((exit) => exit !== exited);
    onExit(state, record, running, why);
  });
  return running;
}

/** Runs on the queue. */
async function loadRecord(state: PoolState, record: ModelRecord): Promise<void> {
  if (record.current.state === "ready") {
    return;
  }
  if (state.stopRequested.includes(record.plan.model)) {
    const message = `${record.plan.label} was unloaded before it started.`;
    record.current = { state: "failed", error: message };
    throw new Error(message);
  }
  let settle: { resolve: () => void; reject: (err: Error) => void } | undefined;
  const loaded = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A load nobody is waiting on still must not be an unhandled rejection.
  loaded.catch(() => {});
  record.current = { state: "loading", running: null, loaded };
  let running: Running | null = null;
  try {
    if (record.plan.lazy) {
      await makeRoom(state, record);
    }
    running = await spawnRecord(state, record);
    record.current = { state: "loading", running, loaded };
    // An unload or a shutdown that arrived during the spawn: stop now.
    if (state.stopRequested.includes(record.plan.model) || state.stopping) {
      const exited = exitOf(running.child, record.plan.label);
      kill(state, running);
      throw new Error(`${await exited} before it was ready.`);
    }
    await state.deps.waitReady(record.plan, running, Promise.race(state.exits));
    record.current = { state: "ready", running };
    record.lastUsedAt = state.deps.now();
    settle?.resolve();
  } catch (err) {
    if (running !== null) {
      kill(state, running);
    }
    // A load that ended because the server is stopping is not a failure.
    record.current = state.stopping
      ? { state: "stopped" }
      : { state: "failed", error: (err as Error).message };
    settle?.reject(err as Error);
    throw err;
  }
}

export function createModelPool(plans: ModelPlan[], deps: PoolDeps): ModelPool {
  let reportFailure: (why: string) => void = () => {};
  const failure = new Promise<string>((resolve) => {
    reportFailure = resolve;
  });
  const state: PoolState = {
    plans,
    records: Object.fromEntries(
      plans.map((plan) => [
        plan.model,
        { plan, current: { state: "stopped" }, requestsInProgress: 0, lastUsedAt: null },
      ]),
    ),
    deps,
    exits: [],
    stoppedByPool: [],
    stopRequested: [],
    stopping: false,
    reportFailure: (why) => reportFailure(why),
  };
  // Every change of state runs on this queue, one at a time, so a load
  // and an unload of the same model cannot interleave.
  const onQueue = createQueue();

  function recordOf(model: string): ModelRecord {
    // hasOwn, so a name such as "constructor" is not served either.
    const record = Object.hasOwn(state.records, model) ? state.records[model] : undefined;
    if (record === undefined) {
      throw new Error(`${model} is not served. Served: ${plans.map((p) => p.model).join(", ")}.`);
    }
    return record;
  }

  function refuseIfStopping(): void {
    if (state.stopping) {
      throw new PoolRefusal("stopping", "This server is shutting down.");
    }
  }

  async function acquire(model: string): Promise<Held> {
    const record = recordOf(model);
    refuseIfStopping();
    const needsLoad = record.current.state === "stopped" || record.current.state === "failed";
    if (record.plan.lazy && needsLoad) {
      try {
        await onQueue(() => loadRecord(state, record));
      } catch (err) {
        if (err instanceof PoolRefusal) {
          throw err;
        }
        throw new PoolRefusal("load-failed", (err as Error).message);
      }
    }
    if (record.current.state === "loading") {
      try {
        await record.current.loaded;
      } catch (err) {
        throw new PoolRefusal("load-failed", (err as Error).message);
      }
    }
    // Read again: the state may have changed while the load was awaited.
    const current = record.current;
    if (current.state !== "ready") {
      throw new PoolRefusal("not-loaded", notLoadedMessage(model));
    }
    return hold(record, current.running, deps.now);
  }

  async function unload(model: string): Promise<void> {
    const record = recordOf(model);
    // A load in progress holds the queue until it ends, so end it now. Its
    // wait rejects when the process exits. A load that has not spawned yet
    // sees the request and gives up when it does.
    state.stopRequested.push(model);
    const running = record.current.state === "loading" ? record.current.running : null;
    if (running !== null) {
      kill(state, running);
    }
    return onQueue(() => stopRecord(state, record));
  }

  function stopAll(): Promise<void> {
    state.stopping = true;
    // Signal now, not on the queue: a load in progress holds the queue,
    // and the signal is what ends it.
    const exits = signalEverything(state);
    return onQueue(() => waitForExits(state, exits));
  }

  return {
    models: () => plans.map((plan) => plan.model),
    status: () => Object.values(state.records).map(statusOf),
    plan: (model) => (Object.hasOwn(state.records, model) ? state.records[model].plan : undefined),
    acquire,
    load: async (model) => {
      const record = recordOf(model);
      refuseIfStopping();
      return onQueue(() => loadRecord(state, record));
    },
    unload,
    stopAll,
    failure,
  };
}
