import type { Child, ServeKind } from "./localServe.js";
import type { RequestRules } from "./requestRules.js";

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
 *  rules          the request rules of its chat runtime, or null */
export type ModelPlan = {
  model: string;
  upstreamModel: string;
  label: string;
  kind: ServeKind;
  rules: RequestRules | null;
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
 *  not-loaded   the model was unloaded, and nothing will load it again
 *               until `load` is called
 *  load-failed  the load a request was waiting on failed */
export type RefusalReason = "not-loaded" | "load-failed";

export class PoolRefusal extends Error {
  reason: RefusalReason;

  constructor(reason: RefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

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
};

export type ModelPool = {
  /** The names of the served models, in plan order. */
  models: () => string[];
  status: () => ModelStatus[];
  plan: (model: string) => ModelPlan | undefined;
  /** Holds a loaded model for one request, waiting for a load in progress.
   *  Rejects with a `PoolRefusal` for a model that is not loaded. */
  acquire: (model: string) => Promise<Held>;
  /** Starts a model's process and resolves when the model is ready. Does
   *  nothing for a model that is ready already. */
  load: (model: string) => Promise<void>;
  /** Stops a model's process and resolves when it has exited. A load in
   *  progress is ended, and the requests waiting on it are refused. */
  unload: (model: string) => Promise<void>;
  /** Signals every process to stop. Does not wait for them to exit. */
  stopAll: () => void;
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

export function createModelPool(plans: ModelPlan[], deps: PoolDeps): ModelPool {
  const records: Record<string, ModelRecord> = Object.fromEntries(
    plans.map((plan) => [
      plan.model,
      { plan, current: { state: "stopped" }, requestsInProgress: 0, lastUsedAt: null },
    ]),
  );
  /** One entry per process that is running. A load waits on all of them,
   *  so any process dying ends the wait. */
  let exits: Promise<string>[] = [];
  /** The processes the pool itself told to stop. Their exits are not
   *  failures. */
  const stoppedByPool: Child[] = [];
  /** The models an `unload` is waiting to stop. A load of one of them
   *  gives up as early as it can, instead of finishing first. */
  const stopRequested: string[] = [];
  let stopping = false;
  let reportFailure: (why: string) => void = () => {};
  const failure = new Promise<string>((resolve) => {
    reportFailure = resolve;
  });
  // Every change of state runs on this queue, one at a time, so a load
  // and an unload of the same model cannot interleave.
  const onQueue = createQueue();

  function recordOf(model: string): ModelRecord {
    // hasOwn, so a name such as "constructor" is not served either.
    const record = Object.hasOwn(records, model) ? records[model] : undefined;
    if (record === undefined) {
      throw new Error(`${model} is not served. Served: ${plans.map((p) => p.model).join(", ")}.`);
    }
    return record;
  }

  /** Tells a process to stop, once, and remembers that the pool did. */
  function kill(running: Running): void {
    if (stoppedByPool.includes(running.child)) {
      return;
    }
    stoppedByPool.push(running.child);
    running.child.kill();
  }

  /** A process exited. If it is still its record's process and the pool
   *  did not stop it, the record has failed. One that had finished loading
   *  is also reported through `failure`, after the grace period. */
  function onExit(record: ModelRecord, running: Running, why: string): void {
    if (runningOf(record) !== running || stoppedByPool.includes(running.child)) {
      return;
    }
    const wasReady = record.current.state === "ready";
    record.current = { state: "failed", error: `${why}.` };
    if (!wasReady) {
      return;
    }
    setTimeout(() => {
      if (!stopping) {
        reportFailure(`${why}.`);
      }
    }, EXIT_GRACE_MS);
  }

  /** Runs on the queue. */
  async function loadRecord(record: ModelRecord): Promise<void> {
    if (record.current.state === "ready") {
      return;
    }
    if (stopRequested.includes(record.plan.model)) {
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
      running = await deps.spawn(record.plan);
      const started = running;
      record.current = { state: "loading", running: started, loaded };
      const exited = exitOf(started.child, record.plan.label);
      exits.push(exited);
      void exited.then((why) => {
        exits = exits.filter((exit) => exit !== exited);
        onExit(record, started, why);
      });
      // An unload that arrived during the spawn: stop now, and the wait
      // below ends when the process exits.
      if (stopRequested.includes(record.plan.model)) {
        kill(started);
      }
      await deps.waitReady(record.plan, started, Promise.race(exits));
      record.current = { state: "ready", running: started };
      record.lastUsedAt = deps.now();
      settle?.resolve();
    } catch (err) {
      if (running !== null) {
        kill(running);
      }
      record.current = { state: "failed", error: (err as Error).message };
      settle?.reject(err as Error);
      throw err;
    }
  }

  /** Runs on the queue. Stops the record's process, if it has one, and
   *  waits for it to exit. */
  async function stopRecord(record: ModelRecord): Promise<void> {
    const index = stopRequested.indexOf(record.plan.model);
    if (index !== -1) {
      stopRequested.splice(index, 1);
    }
    const running = runningOf(record);
    if (running !== null) {
      const exited = exitOf(running.child, record.plan.label);
      kill(running);
      await exited;
    }
    record.current = { state: "stopped" };
  }

  async function acquire(model: string): Promise<Held> {
    const record = recordOf(model);
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
    stopRequested.push(model);
    const running = record.current.state === "loading" ? record.current.running : null;
    if (running !== null) {
      kill(running);
    }
    return onQueue(() => stopRecord(record));
  }

  function stopAll(): void {
    stopping = true;
    for (const record of Object.values(records)) {
      const running = runningOf(record);
      if (running !== null) {
        kill(running);
        record.current = { state: "stopped" };
      }
    }
  }

  return {
    models: () => plans.map((plan) => plan.model),
    status: () => Object.values(records).map(statusOf),
    plan: (model) => (Object.hasOwn(records, model) ? records[model].plan : undefined),
    acquire,
    load: async (model) => {
      const record = recordOf(model);
      return onQueue(() => loadRecord(record));
    },
    unload,
    stopAll,
    failure,
  };
}
