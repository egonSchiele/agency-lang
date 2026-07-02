/**
 * IPC-mode interrupt handling for subprocess execution.
 * When AGENCY_IPC=1 is set, interrupts are sent to the parent process
 * over Node's built-in IPC channel instead of being returned as Interrupt[].
 */

import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { fork } from "child_process";
import type { ForkOptions } from "child_process";
import { rmSync, writeFileSync, mkdirSync } from "fs";
import { nanoid } from "nanoid";
import type { AgencyConfig } from "../config.js";
import { getRuntimeContext } from "./asyncContext.js";
import { gatherChainOutcome, type HandlerChainOutcome } from "./interrupts.js";
import {
  acquireLocalLock,
  lockReleaserKey,
  type LockRelease,
  type WithLockOptions,
} from "./lock.js";
import { failure, type ResultFailure } from "./result.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolved filesystem path to the subprocess bootstrap script. */
export const subprocessBootstrapPath = path.join(__dirname, "subprocess-bootstrap.js");

export function isIpcMode(): boolean {
  return process.env.AGENCY_IPC === "1";
}

// ── Resource limits ──
// Hardcoded ceilings clamp any user-supplied limit value to a safe maximum.
// See docs/superpowers/specs/2026-05-09-subprocess-resource-limits-design.md.

const LIMIT_CEILINGS = {
  wallClock: 60 * 60 * 1000,           // 1h in ms
  memory: 4 * 1024 * 1024 * 1024,      // 4gb in bytes
  ipcPayload: 1024 * 1024 * 1024,      // 1gb in bytes
  stdout: 100 * 1024 * 1024,           // 100mb in bytes
} as const;

export type RunLimits = {
  wallClock: number;
  memory: number;
  ipcPayload: number;
  stdout: number;
};

export function clampLimits(input: RunLimits): RunLimits {
  const out = { ...input };
  for (const key of Object.keys(LIMIT_CEILINGS) as (keyof typeof LIMIT_CEILINGS)[]) {
    if (input[key] > LIMIT_CEILINGS[key]) {
      ipcLog("send", { type: "limit_clamped", limit: key, requested: input[key], clamped: LIMIT_CEILINGS[key] });
      out[key] = LIMIT_CEILINGS[key];
    }
  }
  return out;
}

/**
 * Build a structured limit-exceeded Result.failure that the Agency-side
 * `try _run(...)` will pass through (without converting to an Error string).
 * `limit` is the canonical name (e.g. "wall_clock", "memory", "ipc_payload",
 * "stdout"). `threshold` is the configured cap; `value` is what was observed
 * when the violation was detected. `extras` carries optional fields like
 * `samplePrefix` for IPC payload violations.
 */
export function makeLimitFailure(
  limit: string,
  threshold: number,
  value: number,
  extras: Record<string, any> = {},
): ResultFailure {
  const message = `Subprocess exceeded ${limit} limit of ${threshold} (used ${value})`;
  // Always emit an ipcLog line on violation, regardless of AGENCY_IPC_DEBUG.
  // Per spec: the failure value AND the log line are both observability
  // channels for limit violations.
  const line = `[ipc:${role}] ${new Date().toISOString().slice(11, 23)} send limit_violation limit=${limit} value=${value} threshold=${threshold}\n`;
  process.stderr.write(line);
  return failure({
    reason: "limit_exceeded",
    limit,
    threshold,
    value,
    message,
    ...extras,
  });
}

let subprocessIpcPayloadLimit = Infinity;

export function setSubprocessIpcPayloadLimit(limit: number): void {
  subprocessIpcPayloadLimit = limit;
}

function serializedByteLength(value: any): { ok: true; serialized: string; byteLength: number } | { ok: false; error: string } {
  try {
    const serialized = JSON.stringify(value);
    return { ok: true, serialized, byteLength: Buffer.byteLength(serialized, "utf8") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function buildIpcPayloadLimitError(threshold: number, value: number, samplePrefix = ""): IpcErrorMessage {
  return {
    type: "error",
    error: JSON.stringify({
      reason: "limit_exceeded",
      limit: "ipc_payload",
      threshold,
      value,
      message: `IPC payload (${value} bytes) exceeded ipcPayload limit of ${threshold}`,
      samplePrefix,
    }),
  };
}

// ── IPC Debug Logger ──
// Toggle with AGENCY_IPC_DEBUG=1. Logs every IPC message to stderr
// with direction, timestamp, and message type. Truncates large payloads.

const ipcDebug = process.env.AGENCY_IPC_DEBUG === "1";
const role = isIpcMode() ? "child" : "parent";

function truncate(val: any, maxLen = 200): string {
  const s = typeof val === "string" ? val : JSON.stringify(val);
  if (s == null) return "undefined";
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

export function ipcLog(direction: "send" | "recv", msg: any): void {
  if (!ipcDebug) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const type = msg?.type ?? "unknown";
  let detail: string;
  if (type === "interrupt") detail = `effect=${msg.interrupt?.effect}`;
  else if (type === "decision") detail = `outcome=${msg.outcome?.kind}`;
  else if (type === "result") detail = `data=${truncate(msg.value?.data)}`;
  else if (type === "error") detail = `error=${truncate(msg.error)}`;
  else if (type === "run") detail = `node=${msg.node} script=${msg.scriptPath}`;
  else detail = truncate(msg);
  process.stderr.write(`[ipc:${role}] ${ts} ${direction} ${type} ${detail}\n`);
}

export type IpcInterruptMessage = {
  type: "interrupt";
  /** The child's interrupt-level id, preserved verbatim end-to-end: it keys
   * the decision reply and both processes' statelog events, and — when the
   * interrupt ultimately surfaces to the user — the resume response. */
  interruptId: string;
  interrupt: {
    effect: string;
    message: string;
    data: any;
    origin: string;
  };
};

export type IpcResultMessage = {
  type: "result";
  value: any;
};

export type IpcErrorMessage = {
  type: "error";
  error: string;
};

/** The parent's reply to a relayed interrupt: its handler chain OUTCOME,
 * not a verdict. The child merges this with its own local outcome and
 * decides (see `mergeChainOutcomes` in interrupts.ts). */
export type IpcDecisionMessage = {
  type: "decision";
  interruptId: string;
  outcome: HandlerChainOutcome;
};

export type IpcLockAcquireMessage = {
  type: "lockAcquire";
  requestId: string;
  name: string;
  ownerId?: string;
  timeoutMs?: number;
  warnAfterMs?: number;
};

export type IpcLockGrantedMessage = {
  type: "lockGranted";
  requestId: string;
  error?: string;
};

export type IpcLockReleaseMessage = {
  type: "lockRelease";
  requestId: string;
  name: string;
  ownerId?: string;
};

export type SubprocessToParent =
  | IpcInterruptMessage
  | IpcResultMessage
  | IpcErrorMessage
  | IpcLockAcquireMessage
  | IpcLockReleaseMessage;
export type ParentToSubprocess = IpcDecisionMessage | IpcLockGrantedMessage;

const sessionLockOwners: Record<string, string[]> = {};

export function registerSessionLock(
  ctx: { lockReleasers: Record<string, LockRelease> },
  sessionId: string,
  releaserKey: string,
  release: LockRelease,
): void {
  ctx.lockReleasers[releaserKey] = release;
  const releaserKeys = sessionLockOwners[sessionId] ?? [];
  if (!releaserKeys.includes(releaserKey)) {
    sessionLockOwners[sessionId] = [...releaserKeys, releaserKey];
  }
}

function releaseSessionOwner(
  ctx: { lockReleasers: Record<string, LockRelease> },
  sessionId: string,
  releaserKey: string,
): void {
  const release = ctx.lockReleasers[releaserKey];
  if (release) {
    release();
  }
  delete ctx.lockReleasers[releaserKey];
  const releaserKeys = sessionLockOwners[sessionId] ?? [];
  const next = releaserKeys.filter((key) => key !== releaserKey);
  if (next.length === 0) {
    delete sessionLockOwners[sessionId];
  } else {
    sessionLockOwners[sessionId] = next;
  }
}

export function cleanupSessionLocks(
  ctx: { lockReleasers: Record<string, LockRelease> },
  sessionId: string,
): void {
  const releaserKeys = [...(sessionLockOwners[sessionId] ?? [])];
  for (const releaserKey of releaserKeys) {
    releaseSessionOwner(ctx, sessionId, releaserKey);
  }
}

/**
 * Send an interrupt to the parent process and await the parent's handler
 * chain OUTCOME (not a verdict — the child merges and decides). The parent
 * always replies explicitly; the child never infers from silence.
 * `interruptId` is the child's interrupt-level id, used verbatim as the
 * message id so decision routing and statelog correlation share one key.
 */
export async function sendInterruptToParent(
  interruptData: {
    effect: string;
    message: string;
    data: any;
    origin: string;
  },
  interruptId: string,
): Promise<HandlerChainOutcome> {
  if (typeof process.send !== "function") {
    throw new Error(
      "sendInterruptToParent called without an IPC channel. This function can only be used inside a forked subprocess (AGENCY_IPC=1).",
    );
  }
  const outMsg = {
    type: "interrupt",
    interruptId,
    interrupt: interruptData,
  } satisfies IpcInterruptMessage;
  const serialized = serializedByteLength(outMsg);
  if (!serialized.ok) {
    const value = `Failed to serialize interrupt payload: ${serialized.error}`;
    process.send!({ type: "error", error: value } satisfies IpcErrorMessage);
    return { kind: "rejected", value };
  }
  if (serialized.byteLength > subprocessIpcPayloadLimit) {
    const errorMsg = buildIpcPayloadLimitError(
      subprocessIpcPayloadLimit,
      serialized.byteLength,
      serialized.serialized.slice(0, 1024),
    );
    process.send!(errorMsg);
    return { kind: "rejected", value: errorMsg.error };
  }
  ipcLog("send", outMsg);
  return new Promise((resolve) => {
    const handler = (msg: any) => {
      if (msg.type === "decision" && msg.interruptId === interruptId) {
        process.removeListener("message", handler);
        ipcLog("recv", msg);
        resolve(msg.outcome as HandlerChainOutcome);
      }
    };
    process.on("message", handler);
    // Safe to assert — guarded by typeof check at function entry
    process.send!(outMsg);
  });
}

export async function sendLockAcquireToParent(
  name: string,
  opts: WithLockOptions = {},
): Promise<LockRelease> {
  if (typeof process.send !== "function") {
    throw new Error(
      "sendLockAcquireToParent called without an IPC channel. This function can only be used inside a forked subprocess (AGENCY_IPC=1).",
    );
  }
  const outMsg = {
    type: "lockAcquire",
    requestId: nanoid(),
    name,
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.warnAfterMs !== undefined ? { warnAfterMs: opts.warnAfterMs } : {}),
  } satisfies IpcLockAcquireMessage;
  ipcLog("send", outMsg);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      process.removeListener("message", handler);
      process.removeListener("disconnect", onDisconnect);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const handler = (msg: any) => {
      if (msg.type === "lockGranted" && msg.requestId === outMsg.requestId) {
        if (settled) return;
        settled = true;
        cleanup();
        ipcLog("recv", msg);
        if (msg.error) {
          reject(new Error(msg.error));
          return;
        }
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          const releaseMsg = {
            type: "lockRelease",
            requestId: outMsg.requestId,
            name,
            ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
          } satisfies IpcLockReleaseMessage;
          ipcLog("send", releaseMsg);
          if (typeof process.send === "function" && process.connected !== false) {
            process.send(releaseMsg);
          }
        });
      }
    };
    const onDisconnect = () => {
      fail(new Error(`IPC channel closed while waiting for lock '${name}'`));
    };
    process.on("message", handler);
    process.once("disconnect", onDisconnect);
    process.send!(outMsg);
  });
}

/**
 * Mutable per-call state shared by all the subprocess event handlers.
 * Bundled into one object so helpers can be extracted to module scope
 * without each one needing 8 closure parameters.
 */
type RunSession = {
  sessionId: string;
  child: ReturnType<typeof fork>;
  limits: RunLimits;
  ctx: any;
  stateStack: any;
  compiledPath: string;
  resolvePromise: (v: any) => void;
  rejectPromise: (v: any) => void;
  settled: boolean;
  startedAt: number;
  wallClockTimer: NodeJS.Timeout | null;
  stdoutBytes: number;
  stoppedForwarding: boolean;
  configOverrides?: Partial<AgencyConfig>;
};

export type RunInstruction = {
  type: "run";
  scriptPath: string;
  node: string;
  args: Record<string, any>;
  ipcPayload?: number;
  configOverrides?: Partial<AgencyConfig>;
};

export function buildRunInstruction(args: {
  scriptPath: string;
  node: string;
  args: Record<string, any>;
  limits: RunLimits;
  configOverrides?: Partial<AgencyConfig>;
}): RunInstruction {
  return {
    type: "run",
    scriptPath: args.scriptPath,
    node: args.node,
    args: args.args,
    ipcPayload: args.limits.ipcPayload,
    ...(args.configOverrides ? { configOverrides: args.configOverrides } : {}),
  };
}

export function buildForkOptions(args: { limits: RunLimits; cwd?: string }): ForkOptions {
  const memoryMb = Math.max(1, Math.floor(args.limits.memory / (1024 * 1024)));
  return {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, AGENCY_IPC: "1" },
    execArgv: [`--max-old-space-size=${memoryMb}`],
    ...(args.cwd ? { cwd: args.cwd } : {}),
  };
}

/** Write the compiled JS to a fresh .agency-tmp/<nanoid>/ dir (under cwd so
 * Node resolves agency-lang package imports via the project's node_modules)
 * and return the script path. Called at every fork — initial run and resume
 * alike — and paired with cleanupTempDir when the session settles. */
export function materializeCompiledScript(compiled: { moduleId: string; code: string }): string {
  const tempDir = path.join(process.cwd(), ".agency-tmp", nanoid());
  mkdirSync(tempDir, { recursive: true });
  const scriptPath = path.join(tempDir, `${compiled.moduleId}.js`);
  writeFileSync(scriptPath, compiled.code, "utf-8");
  return scriptPath;
}

/**
 * Best-effort delete of the per-run compile output directory.
 *
 * SAFETY: we only delete `tempDir` if it resolves to a *strict descendant*
 * of `<cwd>/.agency-tmp/`. The `path.resolve` collapses any `..` segments,
 * so a malicious `compiledPath` like `/anything/../../../etc/passwd` ends
 * up outside the allowed prefix and the rmSync is skipped. The trailing
 * `+ path.sep` on the prefix prevents two attacks:
 *   - deleting `.agency-tmp/` itself (tempDir == allowedPrefix would fail
 *     the strict-prefix check),
 *   - matching a sibling directory like `.agency-tmpevil/` that shares
 *     the prefix string but is a different path.
 * Even if a malicious caller bypassed everything else, the worst they can
 * do is recursively rm a subdirectory of `<cwd>/.agency-tmp/` — never
 * `~`, `/`, or anything outside the project's tmp area.
 */
function cleanupTempDir(compiledPath: string): void {
  try {
    const tempDir = path.resolve(dirname(compiledPath));
    const allowedPrefix = path.resolve(process.cwd(), ".agency-tmp");
    if (tempDir.startsWith(allowedPrefix + path.sep)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (_) {
    // Ignore cleanup failures
  }
}

function clearTimer(s: RunSession): void {
  if (s.wallClockTimer) {
    clearTimeout(s.wallClockTimer);
    s.wallClockTimer = null;
  }
}

function settle(s: RunSession, fn: (v: any) => void, value: any): void {
  if (s.settled) return;
  s.settled = true;
  clearTimer(s);
  cleanupSessionLocks(s.ctx, s.sessionId);
  cleanupTempDir(s.compiledPath);
  fn(value);
}

/**
 * Hard-kill path used when a limit violation is detected: kill child, then
 * settle by resolving with the structured limit failure. Skips the kill if
 * we've already settled so we don't signal a process the parent has lost
 * track of.
 */
function settleWithLimitFailure(
  s: RunSession,
  limit: string,
  threshold: number,
  value: number,
  extras: Record<string, any> = {},
): void {
  if (s.settled) return;
  try { s.child.kill("SIGKILL"); } catch (_) { /* already gone */ }
  settle(s, s.resolvePromise, makeLimitFailure(limit, threshold, value, extras));
}

function trySendDecision(s: RunSession, msg: any): void {
  try {
    if (s.child.connected) {
      ipcLog("send", msg);
      s.child.send(msg);
    }
  } catch (_) {
    // IPC channel closed — subprocess is gone
    settle(s, s.rejectPromise, new Error("IPC channel closed while sending decision to subprocess"));
  }
}

/**
 * Attach a byte-counting forwarder to one of the child's pipe streams. Bytes
 * pass through to `dst` until the cumulative `stdout` limit is hit, at which
 * point we write a truncation marker, stop forwarding, kill the child, and
 * settle with a stdout limit failure.
 */
function attachStdoutForwarder(
  s: RunSession,
  src: NodeJS.ReadableStream | null,
  dst: NodeJS.WriteStream,
): void {
  if (!src) return;
  src.on("data", (chunk: Buffer) => {
    if (s.stoppedForwarding) return;
    const remaining = s.limits.stdout - s.stdoutBytes;
    if (chunk.length <= remaining) {
      s.stdoutBytes += chunk.length;
      dst.write(chunk);
      return;
    }
    if (remaining > 0) dst.write(chunk.subarray(0, remaining));
    const overflow = chunk.length - remaining;
    s.stdoutBytes = s.limits.stdout + overflow;
    dst.write(`\n... [output truncated: stdout limit of ${s.limits.stdout} bytes exceeded]\n`);
    s.stoppedForwarding = true;
    settleWithLimitFailure(s, "stdout", s.limits.stdout, s.stdoutBytes);
  });
}

async function handleInterruptMessage(s: RunSession, msg: any): Promise<void> {
  const { effect, message, data, origin } = msg.interrupt;
  try {
    // Report this process's chain OUTCOME; the child merges and decides.
    // The child's interruptId is relayed into the chain walk so this
    // process's statelog events correlate with the originating interrupt.
    // (gatherChainOutcome itself recurses to OUR parent when this process
    // is also a subprocess — that is what makes nesting compose.)
    const outcome = await gatherChainOutcome(
      { effect, message, data, origin },
      s.ctx,
      s.stateStack,
      msg.interruptId,
    );
    trySendDecision(s, {
      type: "decision",
      interruptId: msg.interruptId,
      outcome,
    } satisfies IpcDecisionMessage);
  } catch (err) {
    trySendDecision(s, {
      type: "decision",
      interruptId: msg.interruptId,
      outcome: {
        kind: "rejected",
        value: `Parent handler error: ${err instanceof Error ? err.message : String(err)}`,
      },
    } satisfies IpcDecisionMessage);
  }
}

async function handleLockAcquireMessage(s: RunSession, msg: IpcLockAcquireMessage): Promise<void> {
  const ownerId = `ipc:${s.sessionId}:${msg.ownerId ?? msg.requestId}`;
  try {
    const release = await acquireLocalLock(s.ctx, msg.name, {
      ownerId,
      ...(msg.timeoutMs !== undefined ? { timeoutMs: msg.timeoutMs } : {}),
      ...(msg.warnAfterMs !== undefined ? { warnAfterMs: msg.warnAfterMs } : {}),
    });
    registerSessionLock(s.ctx, s.sessionId, lockReleaserKey(msg.name, ownerId), release);
    trySendDecision(s, {
      type: "lockGranted",
      requestId: msg.requestId,
    } satisfies IpcLockGrantedMessage);
  } catch (err) {
    trySendDecision(s, {
      type: "lockGranted",
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : String(err),
    } satisfies IpcLockGrantedMessage);
  }
}

function handleLockReleaseMessage(s: RunSession, msg: IpcLockReleaseMessage): void {
  const ownerId = `ipc:${s.sessionId}:${msg.ownerId ?? msg.requestId}`;
  releaseSessionOwner(s.ctx, s.sessionId, lockReleaserKey(msg.name, ownerId));
}

/**
 * Subprocess sent a structured `error` message; if it parses as a
 * limit_exceeded payload, surface it as the same Result.failure shape that
 * the parent-detected limits produce. Otherwise propagate as a plain error.
 */
function handleErrorMessage(s: RunSession, msg: any): void {
  let parsed: any = null;
  try { parsed = JSON.parse(msg.error); } catch (_) { /* not JSON */ }
  if (parsed?.reason === "limit_exceeded") {
    settle(s, s.resolvePromise, makeLimitFailure(
      parsed.limit,
      parsed.threshold,
      parsed.value,
      parsed.samplePrefix !== undefined ? { samplePrefix: parsed.samplePrefix } : {},
    ));
  } else {
    settle(s, s.rejectPromise, new Error(msg.error));
  }
}

async function handleChildMessage(s: RunSession, msg: any): Promise<void> {
  ipcLog("recv", msg);
  // Defensively serialize once: a non-serializable value (circular refs,
  // BigInt) would otherwise throw inside the event handler and leave the
  // session unsettled, hanging _run's Promise.
  const serialized = serializedByteLength(msg);
  if (!serialized.ok) {
    settle(s, s.rejectPromise, new Error(
      `Failed to serialize subprocess message: ${serialized.error}`,
    ));
    return;
  }
  if (serialized.byteLength > s.limits.ipcPayload) {
    settleWithLimitFailure(s, "ipc_payload", s.limits.ipcPayload, serialized.byteLength, {
      samplePrefix: serialized.serialized.slice(0, 1024),
    });
    return;
  }
  if (msg.type === "interrupt") {
    await handleInterruptMessage(s, msg);
  } else if (msg.type === "result") {
    settle(s, s.resolvePromise, msg.value);
  } else if (msg.type === "error") {
    handleErrorMessage(s, msg);
  } else if (msg.type === "lockAcquire") {
    await handleLockAcquireMessage(s, msg);
  } else if (msg.type === "lockRelease") {
    handleLockReleaseMessage(s, msg);
  }
}

function handleChildClose(s: RunSession, code: number | null, signal: NodeJS.Signals | null): void {
  if (s.settled) return;
  // V8 OOM signatures: SIGABRT (V8 abort on OOM), or exit code 134
  // (SIGABRT translated to 128+6 by Node on Unix). Conservative: only those
  // signatures count as memory limit; other crashes are generic failures.
  const isLikelyOom = signal === "SIGABRT" || code === 134;
  if (isLikelyOom) {
    settleWithLimitFailure(s, "memory", s.limits.memory, s.limits.memory);
  } else {
    settle(s, s.rejectPromise, new Error(
      `Subprocess exited unexpectedly with code ${code}${signal ? ` signal ${signal}` : ""}`,
    ));
  }
}

/**
 * Wire up all event handlers on the child process and kick off execution by
 * sending the initial `run` instruction over IPC.
 */
function attachSessionHandlers(s: RunSession, node: string, args: Record<string, any>): void {
  attachStdoutForwarder(s, s.child.stdout, process.stdout);
  attachStdoutForwarder(s, s.child.stderr, process.stderr);

  s.wallClockTimer = setTimeout(() => {
    s.wallClockTimer = null;
    const elapsed = Date.now() - s.startedAt;
    settleWithLimitFailure(s, "wall_clock", s.limits.wallClock, elapsed);
  }, s.limits.wallClock);

  s.child.on("message", (msg: any) => { void handleChildMessage(s, msg); });
  s.child.on("close", (code, signal) => handleChildClose(s, code, signal));
  s.child.on("error", (err: Error) => settle(s, s.rejectPromise, new Error(`Subprocess error: ${err.message}`)));

  const runMsg = buildRunInstruction({
    scriptPath: s.compiledPath,
    node,
    args,
    limits: s.limits,
    configOverrides: s.configOverrides,
  });
  ipcLog("send", runMsg);
  s.child.send(runMsg);
}

/**
 * Fork a compiled Agency program as a subprocess and manage the IPC protocol.
 * Relays subprocess interrupts through the parent's handler chain via interruptWithHandlers.
 */
export async function _run(
  compiled: { moduleId: string; code: string },
  node: string,
  args: Record<string, any>,
  wallClock: number,
  memory: number,
  ipcPayload: number,
  stdout: number,
  configOverrides?: Partial<AgencyConfig>,
  cwd?: string,
): Promise<any> {
  if (isIpcMode()) {
    throw new Error("Nested subprocess execution is not supported.");
  }
  // Post-ALS: read `ctx` and the per-scope `stateStack` from the active
  // `agencyStore` frame. The trailing `__state` positional that AgencyFunction
  // .invoke() still passes is now harmlessly ignored.
  const { ctx, stack: stateStack } = getRuntimeContext();
  const limits = clampLimits({ wallClock, memory, ipcPayload, stdout });

  // Forward the parent's configured provider modules to the subprocess. The
  // child runs a separately-compiled program whose baked `providerModules`
  // come from *its* compile config, not the parent's `agency.json`, so without
  // this a parent that configured providers via config would have none in the
  // child. (The `AGENCY_PROVIDER_MODULES` env var is inherited separately via
  // buildForkOptions, so env-configured providers already reach the child.)
  // Paths are resolved to absolute against the parent's cwd here so they still
  // resolve in the child even when `run(cwd:)` gives it a different cwd.
  const mergedConfigOverrides = withParentProviderModules(
    configOverrides,
    ctx.providerModules,
  );

  const compiledPath = materializeCompiledScript(compiled);

  // stdio fds 1/2 piped (was inherit) so we can byte-count and truncate
  // when stdout limit is exceeded; we still forward bytes through to the
  // parent's own stdout/stderr until the limit hits.
  const child = fork(subprocessBootstrapPath, [], buildForkOptions({ limits, cwd }));

  return new Promise((resolvePromise, rejectPromise) => {
    const session: RunSession = {
      sessionId: nanoid(),
      child,
      limits,
      ctx,
      stateStack,
      compiledPath,
      resolvePromise,
      rejectPromise,
      settled: false,
      startedAt: Date.now(),
      wallClockTimer: null,
      stdoutBytes: 0,
      stoppedForwarding: false,
      configOverrides: mergedConfigOverrides,
    };
    attachSessionHandlers(session, node, args);
  });
}

/**
 * Merge the parent's provider-module paths into the config overrides sent to a
 * subprocess, resolving relative paths to absolute against the parent's cwd so
 * they still resolve in a child launched with a different `cwd`. Returns the
 * overrides unchanged when the parent has no configured provider modules.
 */
export function withParentProviderModules(
  overrides: Partial<AgencyConfig> | undefined,
  parentModules: string[],
): Partial<AgencyConfig> | undefined {
  if (!parentModules || parentModules.length === 0) return overrides;
  const absolute = parentModules.map((p) =>
    path.isAbsolute(p) ? p : path.resolve(process.cwd(), p),
  );
  return {
    ...overrides,
    client: { ...overrides?.client, providerModules: absolute },
  };
}
