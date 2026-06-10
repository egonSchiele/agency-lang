import { nanoid } from "nanoid";
import type { RuntimeContext } from "./state/context.js";

const DEFAULT_WARN_AFTER_MS = 30_000;

export type WithLockOptions = {
  ownerId?: string;
  timeoutMs?: number;
  warnAfterMs?: number;
};

export type LockRelease = () => void;

function ownerFor(opts: WithLockOptions): string {
  return opts.ownerId ?? `lock-owner:${nanoid()}`;
}

export function lockReleaserKey(name: string, ownerId: string): string {
  return `${name}\0${ownerId}`;
}

function createTimeout(name: string, ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Timed out waiting for lock '${name}' after ${ms}ms`));
    }, ms);
  });
}

function startWarnTimer(name: string, ownerId: string, warnAfterMs: number): NodeJS.Timeout | null {
  if (warnAfterMs <= 0) return null;
  return setTimeout(() => {
    console.warn(`Still waiting for lock '${name}' after ${warnAfterMs}ms (owner ${ownerId})`);
  }, warnAfterMs);
}

function rememberReleaser(ctx: RuntimeContext<any>, name: string, ownerId: string, release: LockRelease): void {
  ctx.lockReleasers[lockReleaserKey(name, ownerId)] = release;
}

function forgetReleaser(ctx: RuntimeContext<any>, name: string, ownerId: string): void {
  delete ctx.lockReleasers[lockReleaserKey(name, ownerId)];
}

function rememberWaiter(ctx: RuntimeContext<any>, name: string, ownerId: string): void {
  const waiters = ctx.lockWaiters[name] ?? [];
  ctx.lockWaiters[name] = [...waiters, ownerId];
}

function forgetWaiter(ctx: RuntimeContext<any>, name: string, ownerId: string): void {
  const waiters = ctx.lockWaiters[name] ?? [];
  const next = waiters.filter((id) => id !== ownerId);
  if (next.length === 0) {
    delete ctx.lockWaiters[name];
  } else {
    ctx.lockWaiters[name] = next;
  }
}

export async function acquireLocalLock(
  ctx: RuntimeContext<any>,
  name: string,
  opts: WithLockOptions = {},
): Promise<LockRelease> {
  const ownerId = ownerFor(opts);
  const currentOwner = ctx.lockOwners[name];
  if (currentOwner === ownerId) {
    throw new Error(`Owner '${ownerId}' already holds lock '${name}'`);
  }

  const previous = ctx.locks[name] ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => current);
  ctx.locks[name] = chain;
  rememberWaiter(ctx, name, ownerId);

  let timedOut = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (ctx.lockOwners[name] === ownerId) {
      delete ctx.lockOwners[name];
    }
    forgetReleaser(ctx, name, ownerId);
    releaseCurrent();
  };

  const warnTimer = startWarnTimer(
    name,
    ownerId,
    opts.warnAfterMs ?? DEFAULT_WARN_AFTER_MS,
  );

  try {
    const waitForPrevious = previous.catch(() => undefined);
    if (opts.timeoutMs !== undefined) {
      await Promise.race([waitForPrevious, createTimeout(name, opts.timeoutMs)]);
    } else {
      await waitForPrevious;
    }
  } catch (err) {
    timedOut = true;
    forgetWaiter(ctx, name, ownerId);
    previous.finally(release);
    throw err;
  } finally {
    if (warnTimer) clearTimeout(warnTimer);
  }

  if (timedOut) {
    release();
    throw new Error(`Timed out waiting for lock '${name}'`);
  }

  ctx.lockOwners[name] = ownerId;
  forgetWaiter(ctx, name, ownerId);
  rememberReleaser(ctx, name, ownerId, release);
  chain.finally(() => {
    if (ctx.locks[name] === chain) {
      delete ctx.locks[name];
    }
  });
  return release;
}

export async function runLocalLock<T>(
  ctx: RuntimeContext<any>,
  name: string,
  fn: () => T | Promise<T>,
  opts: WithLockOptions = {},
): Promise<T> {
  const release = await acquireLocalLock(ctx, name, opts);
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function withLockOnCtx<T>(
  ctx: RuntimeContext<any>,
  name: string,
  fn: () => T | Promise<T>,
  opts: WithLockOptions = {},
): Promise<T> {
  return runLocalLock(ctx, name, fn, opts);
}
