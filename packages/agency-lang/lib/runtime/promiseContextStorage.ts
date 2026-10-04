/**
 * The class every runtime context variable is built from. It keeps a value
 * attached to a chain of `async` calls while other chains run in between,
 * and it needs nothing from Node, so it works in a browser.
 *
 * How it works. The current context is one module-level variable,
 * `currentFrame`. Two things keep it right across a pause:
 *
 *   1. The build rewrites every `async` function into promise code, so each
 *      `await x` becomes `Promise.resolve(x).then(resume)`.
 *   2. `Promise.prototype.then` is replaced with a version that remembers
 *      `currentFrame` when it is called and puts it back while the callback
 *      runs.
 *
 * So a function that pauses at an `await` gets its own context back when it
 * wakes up.
 *
 * Code that was not rewritten, such as a dependency, still works as a callee:
 * its caller's context is saved by the caller's own `.then`. Inside that
 * code, after its first real `await`, the context is empty.
 *
 * A callback that is not a promise callback or a timer runs with an empty
 * context. An event listener is the common case. Wrap such a callback with
 * `bindToCurrentFrame` when you register it.
 *
 * See docs/dev/runtime/portable-context-spike.md for the mechanism and
 * docs/dev/runtime/running-without-node.md for why Agency uses this class
 * on every target.
 */

/**
 * One value per context variable, keyed by its id. A frame is never changed
 * after it is made: `run` builds a new one. That is what lets a paused
 * function hold on to its frame by reference.
 */
type Frame = Record<number, unknown>;

const EMPTY_FRAME: Frame = Object.freeze({});

let currentFrame: Frame = EMPTY_FRAME;
let nextStoreId = 0;
let installed = false;

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Return `fn` wrapped so it runs inside the frame that is current right now.
 * Use it for a callback that something other than a promise or a timer will
 * call later, such as an event listener.
 */
export function bindToCurrentFrame<F>(fn: F): F {
  if (typeof fn !== "function") {
    return fn;
  }
  const captured = currentFrame;
  const original = fn as unknown as AnyFunction;
  const bound: AnyFunction = function (this: unknown, ...args: unknown[]) {
    const previous = currentFrame;
    currentFrame = captured;
    try {
      return original.apply(this, args);
    } finally {
      currentFrame = previous;
    }
  };
  return bound as unknown as F;
}

type Scheduler = (callback: AnyFunction, ...rest: unknown[]) => unknown;

/** Replace a global that takes a callback first, such as `setTimeout`. */
function patchScheduler(owner: Record<string, unknown>, name: string): void {
  const original = owner[name];
  if (typeof original !== "function") {
    return;
  }
  const scheduler = original as Scheduler;
  const patched: Scheduler = function (this: unknown, callback, ...rest) {
    return scheduler.call(this, bindToCurrentFrame(callback), ...rest);
  };
  // Node hangs extra properties on these (`setTimeout.__promisify__`).
  Object.assign(patched, original);
  owner[name] = patched;
}

/**
 * Install the `.then` wrapper and the timer wrappers. Runs once, the first
 * time a context variable is created.
 */
function install(): void {
  if (installed) {
    return;
  }
  installed = true;

  const originalThen = Promise.prototype.then;
  const patchedThen = function (
    this: Promise<unknown>,
    onFulfilled?: unknown,
    onRejected?: unknown,
  ): Promise<unknown> {
    return originalThen.call(
      this,
      bindToCurrentFrame(onFulfilled) as never,
      bindToCurrentFrame(onRejected) as never,
    );
  };
  Promise.prototype.then = patchedThen as typeof Promise.prototype.then;

  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]) {
    patchScheduler(globals, name);
  }
  const nodeProcess = globals["process"] as Record<string, unknown> | undefined;
  if (nodeProcess !== undefined) {
    patchScheduler(nodeProcess, "nextTick");
  }
}

export class PromiseContextStorage<T> {
  private readonly id: number;

  constructor() {
    install();
    this.id = nextStoreId++;
  }

  getStore(): T | undefined {
    return currentFrame[this.id] as T | undefined;
  }

  run<R>(store: T, fn: () => R): R {
    const previous = currentFrame;
    currentFrame = { ...previous, [this.id]: store };
    try {
      return fn();
    } finally {
      currentFrame = previous;
    }
  }

  exit<R>(fn: () => R): R {
    return this.run(undefined as T, fn);
  }
}

/**
 * Throw if `fn` is a real `async` function, meaning no build step rewrote
 * it. Such a function reads an empty context after its first `await`, and
 * some reads treat empty as a normal answer: the call-depth guard would count
 * every call as the first, so runaway recursion would never be stopped.
 *
 * The check reads the function's tag and never names the `AsyncFunction`
 * constructor, because the rewrite would turn any `async function` written
 * here into a plain one.
 */
export function assertAsyncRewritten(fn: unknown, label: string): void {
  if (Object.prototype.toString.call(fn) === "[object AsyncFunction]") {
    throw new Error(
      `${label} is a real async function. Agency keeps its context by ` +
        "rewriting async functions into promise code, and this one was not " +
        "rewritten. Compile it with the Agency compiler. See " +
        "docs/dev/runtime/portable-context-spike.md.",
    );
  }
}

/** True when no frame is active. Tests use this to check nothing leaked. */
export function isOutsideEveryFrame(): boolean {
  return currentFrame === EMPTY_FRAME;
}
