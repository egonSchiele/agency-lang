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
import { getRuntimeContext, agencyStore } from "./asyncContext.js";
import { gatherChainOutcome, type HandlerChainOutcome, type Interrupt } from "./interrupts.js";
import { runBatch } from "./runBatch.js";
import { AgencyAbort, AgencyCancelledError } from "./errors.js";
import type { State, StateStack } from "./state/stateStack.js";
import { getSubprocessRunInfo, setSubprocessRunInfo, isIpcMode, type SubprocessRunInfo } from "./subprocessRunInfo.js";
import { isPayableCost, type IpcTelemetryMessage } from "./costTelemetry.js";
import { type IpcCallbackMessage, NON_FORWARDABLE_CALLBACKS } from "./callbackForwarding.js";
import { invokeCallbacks } from "./hooks.js";
import { VALID_CALLBACK_NAMES, type CallbackName } from "../types/function.js";
// isIpcMode lives in subprocessRunInfo.ts (dependency-free, so the telemetry
// leaf can share it); re-exported here for the existing consumers.
export { isIpcMode };

export { getSubprocessRunInfo, setSubprocessRunInfo, type SubprocessRunInfo };
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

// ── Resource limits ──
// Hardcoded ceilings clamp any user-supplied limit value to a safe maximum.
// See docs/superpowers/specs/2026-05-09-subprocess-resource-limits-design.md.

const LIMIT_CEILINGS = {
  wallClock: 60 * 60 * 1000,           // 1h in ms
  memory: 4 * 1024 * 1024 * 1024,      // 4gb in bytes
  ipcPayload: 1024 * 1024 * 1024,      // 1gb in bytes
  stdout: 100 * 1024 * 1024,           // 100mb in bytes
} as const;

// Depth cap on nested subprocess trees. Every run() is already gated by a
// std::run interrupt, so the cap is a backstop against handlers that
// blindly approve — it converts a runaway agent-writes-agent recursion
// into a structured failure. The DEFAULT (5) allows realistic
// tool-building pipelines (agent → generated agent → helper) with
// headroom; the CEILING (10) bounds the total process tree even when
// users raise maxDepth. (Separate from LIMIT_CEILINGS because depth is
// not a per-segment RunLimits resource — it clamps tree shape.)
export const DEFAULT_MAX_SUBPROCESS_DEPTH = 5;
export const SUBPROCESS_DEPTH_CEILING = 10;

/** The effective depth cap for a run() call: the caller's maxDepth param,
 * tightened by the tightest ancestor cap (inherited via the run/resume
 * instruction) and the hard ceiling. */
export function resolveDepthCap(paramMaxDepth: number): number {
  const inherited = getSubprocessRunInfo().maxDepth ?? SUBPROCESS_DEPTH_CEILING;
  return Math.min(paramMaxDepth, inherited, SUBPROCESS_DEPTH_CEILING);
}

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
  else if (type === "interrupted") detail = `count=${msg.interrupts?.length}`;
  else if (type === "error") detail = `error=${truncate(msg.error)}`;
  else if (type === "run") detail = `node=${msg.node} script=${msg.scriptPath}`;
  else if (type === "resume") detail = `node=${msg.node} responses=${msg.responses?.length}`;
  else if (type === "telemetry") detail = `costUsd=${msg.costUsd}`;
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

/** An interrupt as it travels over IPC: the per-interrupt checkpoint fields
 * are stripped — the batch-level checkpoint travels once, at the message
 * level (see IpcInterruptedMessage). */
export type SerializedInterrupt = {
  type: "interrupt";
  interruptId: string;
  runId: string;
  effect: string;
  message: string;
  data: any;
  origin: string;
};

/** Terminal message for a child that paused itself: its unresolved
 * interrupts plus the shared checkpoint they all resume from. A third
 * terminal outcome alongside `result` and `error`. */
export type IpcInterruptedMessage = {
  type: "interrupted";
  interrupts: SerializedInterrupt[];
  checkpoint: any;
  subprocessSessionId: string;
};

/** Convert a child's final Interrupt[] into the `interrupted` terminal
 * message: strip each interrupt's checkpoint fields and hoist the shared
 * batch checkpoint (every interrupt in a batch carries the same one). */
export function serializeInterruptsForIpc(interrupts: any[]): IpcInterruptedMessage {
  const checkpoint = interrupts[0]?.checkpoint;
  const serialized = interrupts.map((intr) => {
    const { checkpoint: _cp, checkpointId: _cpId, ...rest } = intr;
    return rest as SerializedInterrupt;
  });
  return {
    type: "interrupted",
    interrupts: serialized,
    checkpoint,
    subprocessSessionId: getSubprocessRunInfo().subprocessSessionId ?? "",
  };
}

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
  | IpcInterruptedMessage
  | IpcErrorMessage
  | IpcLockAcquireMessage
  | IpcLockReleaseMessage
  | IpcTelemetryMessage
  | IpcCallbackMessage;
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
  // No per-call `disconnect` handling: the bootstrap's watchdog
  // (subprocess-bootstrap.ts) is the single disconnect authority — it
  // registers at module load, fires first, and exits the process, so a
  // later-registered handler here could never run anyway. Same contract
  // as sendInterruptToParent.
  return new Promise((resolve, reject) => {
    let settled = false;
    const handler = (msg: any) => {
      if (msg.type === "lockGranted" && msg.requestId === outMsg.requestId) {
        if (settled) return;
        settled = true;
        process.removeListener("message", handler);
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
    process.on("message", handler);
    process.send!(outMsg);
  });
}

/**
 * Mutable per-call state shared by all the subprocess event handlers.
 * Bundled into one object so helpers can be extracted to module scope
 * without each one needing 8 closure parameters.
 */
export type RunSession = {
  sessionId: string;
  child: ReturnType<typeof fork>;
  limits: RunLimits;
  ctx: any;
  stateStack: any;
  /** The parent's full ALS store frame captured at run() time. Forwarded
   * callbacks (handleCallbackMessage) fire from the event-loop message handler,
   * OUTSIDE any agencyStore frame; re-establishing this frame lets an
   * AgencyFunction callback body resolve __globals()/__threads() against the
   * parent's real globals, exactly as an in-process callback would. */
  parentStore?: any;
  resolvePromise: (v: SessionOutcome) => void;
  rejectPromise: (v: any) => void;
  settled: boolean;
  startedAt: number;
  wallClockTimer: NodeJS.Timeout | null;
  stdoutBytes: number;
  stoppedForwarding: boolean;
  /** Detaches the abort listener from the (possibly long-lived) parent
   * signal. Run at settle: a composed AbortSignal pins its unremoved
   * listeners — and everything they close over (session, ctx, child) —
   * for the lifetime of the parent signal, leaking once per execution
   * segment under fork/race or a TimeGuard. */
  detachAbortListener: (() => void) | null;
};

/** How one subprocess execution segment ended: a value (including limit
 * failures, which are ordinary Result failures), or a self-checkpointed
 * pause. Session errors reject instead. */
type SessionOutcome =
  | { type: "result"; value: any }
  | { type: "interrupted"; msg: IpcInterruptedMessage };

/** Everything `_run` persists across a pause so the replayed call can
 * re-fork and resume: the child's checkpoint (OPAQUE — its frames belong
 * to another process and must never be spliced into the parent's replay),
 * the surfaced interrupts in order (their ids key the user's responses),
 * and the node to resume. */
export type SubprocessResumePayload = {
  childCheckpoint: any;
  interrupts: SerializedInterrupt[];
  node: string;
  subprocessSessionId: string;
};

// The payload lives in a frame local under this private constant key. A
// constant is collision-safe: run() is an Agency function, so every
// concurrent call has its own frame on its own branch stack. Callers go
// through the accessors so frame internals stay encapsulated.
const SUBPROCESS_PAYLOAD_KEY = "__subprocess_state_0";

function saveSubprocessPayload(frame: State, payload: SubprocessResumePayload): void {
  frame.locals[SUBPROCESS_PAYLOAD_KEY] = payload;
}

export function loadSubprocessPayload(frame: State): SubprocessResumePayload | undefined {
  return frame.locals[SUBPROCESS_PAYLOAD_KEY] as SubprocessResumePayload | undefined;
}

function clearSubprocessPayload(frame: State): void {
  delete frame.locals[SUBPROCESS_PAYLOAD_KEY];
}

/** Identity the child adopts, carried on both startup instructions: the
 * parent's runId (one trace across processes and pause/resume cycles), a
 * stable per-logical-child session id, the parent's subprocessRun span id
 * for span nesting, the child's nesting depth, and the tightest ancestor
 * depth cap. */
type SubprocessIdentity = {
  runId?: string;
  subprocessSessionId?: string;
  spanContext?: string;
  depth?: number;
  maxDepth?: number;
};

export type RunInstruction = SubprocessIdentity & {
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
  identity?: SubprocessIdentity;
}): RunInstruction {
  return {
    type: "run",
    scriptPath: args.scriptPath,
    node: args.node,
    args: args.args,
    ipcPayload: args.limits.ipcPayload,
    ...(args.configOverrides ? { configOverrides: args.configOverrides } : {}),
    ...(args.identity ?? {}),
  };
}

/** Startup instruction for resuming a previously-paused subprocess: the
 * child restores the checkpoint, pairs `interrupts` with `responses`
 * positionally (via the compiled module's own respondToInterrupts export),
 * and continues from exactly where it left off. */
export type ResumeInstruction = SubprocessIdentity & {
  type: "resume";
  scriptPath: string;
  node: string;
  checkpoint: any;
  interrupts: SerializedInterrupt[];
  responses: any[];
  ipcPayload?: number;
  configOverrides?: Partial<AgencyConfig>;
};

export function buildResumeInstruction(args: {
  scriptPath: string;
  saved: SubprocessResumePayload;
  responses: any[];
  limits: RunLimits;
  configOverrides?: Partial<AgencyConfig>;
  identity?: SubprocessIdentity;
}): ResumeInstruction {
  return {
    type: "resume",
    scriptPath: args.scriptPath,
    node: args.saved.node,
    checkpoint: args.saved.childCheckpoint,
    interrupts: args.saved.interrupts,
    responses: args.responses,
    ipcPayload: args.limits.ipcPayload,
    ...(args.configOverrides ? { configOverrides: args.configOverrides } : {}),
    ...(args.identity ?? {}),
  };
}

/** Pull the user's responses for this subprocess's pending interrupts, in
 * the exact order of the saved interrupts array (the child pairs them
 * positionally). Note: `ctx.getInterruptResponse` returns the response
 * ALREADY UNWRAPPED (context.ts does `?.response` internally). */
export function collectSubprocessResponses(ctx: any, saved: SubprocessResumePayload): any[] {
  return saved.interrupts.map((intr) => {
    const response = ctx.getInterruptResponse(intr.interruptId);
    if (response === undefined) {
      throw new Error(
        `Missing user response for subprocess interrupt ${intr.interruptId} (${intr.effect}). ` +
        `All surfaced interrupts must be answered via respondToInterrupts before the subprocess can resume.`,
      );
    }
    return response;
  });
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
  // The user-facing CompiledProgram type only declares moduleId, so a
  // hand-built `{ moduleId: "x" }` (or an old `{ moduleId, path }` value
  // persisted before code-in-value) typechecks and reaches here. Fail with
  // a pointed message instead of an opaque fs "data argument" error.
  if (typeof compiled?.code !== "string" || compiled.code.length === 0) {
    throw new Error(
      "CompiledProgram has no code; obtain it from compile() (or compileFile()). " +
      "Values from older Agency versions carried a file path instead and must be recompiled.",
    );
  }
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

/** Hard-kill a session's child, logging (never throwing) on failure. The
 * one teardown used by every kill path — limit violations, aborts, and
 * guard trips — so termination mechanics can't drift between them. */
function killChildSafely(s: RunSession): void {
  try {
    s.child.kill("SIGKILL");
  } catch (err) {
    ipcLog("send", { type: "kill_failed", detail: err instanceof Error ? err.message : String(err) });
  }
}

function settle(s: RunSession, fn: (v: any) => void, value: any): void {
  if (s.settled) return;
  s.settled = true;
  clearTimer(s);
  if (s.detachAbortListener) {
    s.detachAbortListener();
    s.detachAbortListener = null;
  }
  cleanupSessionLocks(s.ctx, s.sessionId);
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
  killChildSafely(s);
  settle(s, s.resolvePromise, {
    type: "result",
    value: makeLimitFailure(limit, threshold, value, extras),
  } satisfies SessionOutcome);
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
    //
    // Span isolation: concurrent child interrupts each run their own
    // handler chain here; without a branch-local span stack their
    // handlerChain span pushes/pops would interleave on the shared stack
    // (same discipline runBatch applies to its children).
    const { outcome } = await s.ctx.statelogClient.runInBranchContext(
      s.ctx.statelogClient.snapshotStack(),
      () => gatherChainOutcome(
        { effect, message, data, origin },
        s.ctx,
        s.stateStack,
        msg.interruptId,
      ),
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
    // Mid-tree processes RELAY lock requests upward instead of acquiring
    // locally, so the whole nested subprocess tree shares the ROOT's lock
    // domain — a grandchild contends with a lock the root holds.
    const lockOpts = {
      ownerId,
      ...(msg.timeoutMs !== undefined ? { timeoutMs: msg.timeoutMs } : {}),
      ...(msg.warnAfterMs !== undefined ? { warnAfterMs: msg.warnAfterMs } : {}),
    };
    const release = isIpcMode()
      ? await sendLockAcquireToParent(msg.name, lockOpts)
      : await acquireLocalLock(s.ctx, msg.name, lockOpts);
    if (s.settled) {
      // The session died while this acquire was parked (kill paths: guard
      // trip, wall-clock, abort...). Registering now would mint a lock on a
      // dead session that nothing ever releases — settle-time
      // cleanupSessionLocks already ran, and if the dying child held the
      // contended lock, that cleanup is exactly what resolved this acquire.
      release();
      return;
    }
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
    settle(s, s.resolvePromise, {
      type: "result",
      value: makeLimitFailure(
        parsed.limit,
        parsed.threshold,
        parsed.value,
        parsed.samplePrefix !== undefined ? { samplePrefix: parsed.samplePrefix } : {},
      ),
    } satisfies SessionOutcome);
  } else {
    settle(s, s.rejectPromise, new Error(msg.error));
  }
}

/** Child (or descendant, via relay) reported a paid call. Bill it to the
 * run() call-site stack via the same billCharge every in-process paid
 * site uses: localCost (parent getCost() reflects child spend live) plus
 * the guards — and billCharge re-emits upward when THIS process is
 * itself a subprocess, which is what relays grandchild spend to the root
 * with no explicit plumbing. Billing is unconditional (the spend already
 * happened, even post-settle); enforcement only runs on a live session:
 * a trip kills the child and REJECTS the session with the guard-trip
 * abort, which propagates through invokeSubprocess → runBatch (errors
 * win over interrupts) → the stdlib run() plain `try` re-throws trips →
 * the user's owning guard(cost:) boundary converts it to the standard
 * cost-limit Failure.
 *
 * MUST STAY SYNCHRONOUS: handleChildMessage void-invokes its async
 * dispatch, so arrival-order processing (all telemetry before the
 * child's own terminal message, per IPC FIFO) holds only while this
 * path contains no awaits — an await before enforcement would let a
 * fast child's result settle the session before the trip fires.
 *
 * Known getCost() edge: post-settle billing (possible only on kill
 * paths — FIFO rules it out on normal completion) charges the shared
 * guard REFERENCES correctly, but the localCost increment can land
 * after a fork branch's cost delta has already propagated at join, so
 * getCost() may slightly undercount on abnormal termination. Budgets
 * never undercount; do not "fix" this by skipping post-settle billing. */
export function handleTelemetryMessage(s: RunSession, msg: IpcTelemetryMessage): void {
  if (!isPayableCost(msg.costUsd)) return;
  s.stateStack.billCharge(msg.costUsd);
  if (s.settled) return;
  try {
    s.stateStack.enforceGuards();
  } catch (err) {
    killChildSafely(s);
    settle(s, s.rejectPromise, err);
  }
}

function isForwardableCallbackName(name: unknown): name is CallbackName {
  return typeof name === "string"
    && (VALID_CALLBACK_NAMES as readonly string[]).includes(name)
    // Reject the same names the child-side sender denylists. The child never
    // forwards these, but a version-skewed or future-refactored child might; a
    // JSON-stripped onOAuthRequired/onStream would fire a broken (function-less)
    // parent callback, so the guard must match its name and exclude them.
    && !(NON_FORWARDABLE_CALLBACKS as readonly string[]).includes(name);
}

/**
 * Give a forwarded onAgentStart payload a REAL parent-owned cancel().
 *
 * The child's own cancel function was stripped by JSON. The parent owns the
 * child session, so a parent onAgentStart callback that calls cancel() kills the
 * child (SIGKILL) and settles run() as cancelled.
 *
 * BEST-EFFORT and ASYNC — NOT the in-process semantic. In-process, cancel()
 * throws synchronously and PREVENTS the agent from running. Here the child fires
 * onAgentStart and proceeds without back-pressure (fire-and-forget), so the
 * parent's cancel arrives later and kills a child that may already be mid-run or
 * finished. If the child's terminal result wins the race, settle()'s `s.settled`
 * guard makes the cancel a silent no-op. Killing the child is the closest
 * approximation this one-way channel allows.
 *
 * The `typeof data === object` guard is defensive: the child is the less-trusted
 * party, so we do not spread a malformed non-object payload.
 */
function withParentCancel(s: RunSession, data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  return {
    ...(data as Record<string, unknown>),
    cancel: (reason?: string) => {
      killChildSafely(s);
      settle(s, s.rejectPromise, new AgencyCancelledError(reason));
    },
  };
}

/**
 * Fire the PARENT's registered callbacks for an event forwarded from a child.
 *
 * MUST STAY SYNCHRONOUS (like handleTelemetryMessage): handleChildMessage
 * void-invokes its async dispatch, so FIFO arrival-order processing holds only
 * while this path has no awaits. Parent callbacks fire fire-and-forget (void
 * invokeCallbacks) so a slow or throwing parent callback cannot wedge the pump.
 *
 * invokeCallbacks re-emits upward when THIS process is itself a subprocess, so a
 * grandchild's event relays to the root with no explicit relay code.
 *
 * Fires on the parent's FULL stack (ctx.stateStack), NOT the run() call-site
 * slice s.stateStack: a parent callback registered on an ancestor frame (e.g. a
 * node-level `callback("onNodeStart")` above the run() call) is only reachable by
 * walking the full stack, exactly as an in-process event does via callHook (which
 * omits stateStack and defaults to ctx.stateStack). Passing s.stateStack here
 * would silently miss those ancestor-frame callbacks.
 */
export function handleCallbackMessage(s: RunSession, msg: IpcCallbackMessage): void {
  if (s.settled) return; // drop post-settle events
  if (!isForwardableCallbackName(msg.name)) return; // child is less-trusted

  const data = msg.name === "onAgentStart" ? withParentCancel(s, msg.data) : msg.data;
  // Fire within the parent's captured ALS frame so an AgencyFunction callback
  // body resolves __globals()/__threads() against the parent's real state (we
  // run from the event-loop message handler, outside any agencyStore frame).
  // Firing is fire-and-forget, but NOT bare `void`: fireWithGuard re-throws
  // AgencyAbort (a cost-guard trip or cancellation raised inside a parent
  // callback), so invokeCallbacks can reject. A bare void would orphan that as
  // an unhandledRejection (Node may terminate) AND lose the trip. Route an
  // AgencyAbort to the session exactly as handleTelemetryMessage routes a
  // guard trip (kill the child, settle the run); log anything else. Attaching
  // the handler is synchronous, so FIFO arrival-order processing still holds.
  const fire = () =>
    invokeCallbacks({ ctx: s.ctx, name: msg.name, data }).catch((err) => {
      if (err instanceof AgencyAbort) {
        killChildSafely(s);
        settle(s, s.rejectPromise, err);
        return;
      }
      ipcLog("recv", {
        type: "callback_fire_error",
        name: msg.name,
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  if (s.parentStore) {
    agencyStore.run(s.parentStore, fire);
  } else {
    fire();
  }
}

/** Message types whose delivery is observational — an oversize or
 * unserializable one is DROPPED, never fatal, because it cannot affect the run
 * outcome (unlike result/interrupt/error/lock messages, which must settle or
 * kill the run). Extend this list when adding another fire-and-forget message. */
const OBSERVATIONAL_MESSAGE_TYPES: readonly string[] = ["callback"];

function isObservationalMessage(msg: unknown): boolean {
  // Null-safe: handleChildMessage runs on arbitrary values from an untrusted
  // child. A child sending `undefined`/`null` makes serializedByteLength !ok and
  // reaches here; reading `.type` off a non-object must not throw (that would
  // leave the session unsettled — the exact failure the serialize guard avoids).
  const type = (msg as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && OBSERVATIONAL_MESSAGE_TYPES.includes(type);
}

export async function handleChildMessage(s: RunSession, msg: any): Promise<void> {
  ipcLog("recv", msg);
  // Defensively serialize once: a non-serializable value (circular refs,
  // BigInt) would otherwise throw inside the event handler and leave the
  // session unsettled, hanging _run's Promise.
  const serialized = serializedByteLength(msg);
  if (!serialized.ok) {
    // An observational message is never worth killing the run over.
    if (isObservationalMessage(msg)) {
      ipcLog("recv", { type: "observational_dropped", messageType: msg.type, reason: "unserializable" });
      return;
    }
    settle(s, s.rejectPromise, new Error(
      `Failed to serialize subprocess message: ${serialized.error}`,
    ));
    return;
  }
  if (serialized.byteLength > s.limits.ipcPayload) {
    // Drop an oversize observational message rather than settleWithLimitFailure
    // (which kills the run) — preserves the pure-observation invariant.
    if (isObservationalMessage(msg)) {
      ipcLog("recv", { type: "observational_dropped", messageType: msg.type, reason: "oversize" });
      return;
    }
    settleWithLimitFailure(s, "ipc_payload", s.limits.ipcPayload, serialized.byteLength, {
      samplePrefix: serialized.serialized.slice(0, 1024),
    });
    return;
  }
  if (msg.type === "interrupt") {
    await handleInterruptMessage(s, msg);
  } else if (msg.type === "result") {
    settle(s, s.resolvePromise, { type: "result", value: msg.value } satisfies SessionOutcome);
  } else if (msg.type === "interrupted") {
    settle(s, s.resolvePromise, { type: "interrupted", msg } satisfies SessionOutcome);
  } else if (msg.type === "telemetry") {
    handleTelemetryMessage(s, msg);
  } else if (msg.type === "callback") {
    handleCallbackMessage(s, msg);
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
 * sending the (prebuilt) startup instruction over IPC.
 * Exported for unit tests: the per-segment wall-clock property (timer armed
 * per session, cleared at settle, never firing across a pause) is pinned
 * with fake timers here rather than by a timing-arithmetic execution test.
 */
export function attachSessionHandlers(s: RunSession, instruction: RunInstruction | ResumeInstruction): void {
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

  ipcLog("send", instruction);
  s.child.send(instruction);
}

/** Fork the bootstrap and run one subprocess execution segment to its
 * terminal message. Owns the whole session lifecycle the old `_run`
 * promise owned: limits, stdout forwarding, lock brokering, the
 * per-interrupt chain bridge, and teardown. An aborted `abortSignal`
 * (parent cancellation, race loss, time guard) kills the child. */
async function runSubprocessSession(opts: {
  ctx: any;
  stateStack: any;
  parentStore?: any;
  instruction: RunInstruction | ResumeInstruction;
  limits: RunLimits;
  cwd?: string;
  abortSignal?: AbortSignal;
}): Promise<SessionOutcome> {
  // stdio fds 1/2 piped (not inherit) so we can byte-count and truncate
  // when the stdout limit is exceeded; bytes still forward through to the
  // parent's own stdout/stderr until the limit hits.
  const child = fork(subprocessBootstrapPath, [], buildForkOptions({ limits: opts.limits, cwd: opts.cwd }));

  return new Promise((resolvePromise, rejectPromise) => {
    const session: RunSession = {
      sessionId: nanoid(),
      child,
      limits: opts.limits,
      ctx: opts.ctx,
      stateStack: opts.stateStack,
      parentStore: opts.parentStore,
      resolvePromise,
      rejectPromise,
      settled: false,
      startedAt: Date.now(),
      wallClockTimer: null,
      stdoutBytes: 0,
      stoppedForwarding: false,
      detachAbortListener: null,
    };
    if (opts.abortSignal) {
      const signal = opts.abortSignal;
      const onAbort = () => {
        killChildSafely(session);
        settle(session, rejectPromise, new AgencyCancelledError());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      session.detachAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
    attachSessionHandlers(session, opts.instruction);
  });
}

/** Pick run-vs-resume declaratively from the presence of a saved pause
 * payload. */
function resolveInstruction(args: {
  ctx: any;
  saved: SubprocessResumePayload | undefined;
  scriptPath: string;
  node: string;
  nodeArgs: Record<string, any>;
  limits: RunLimits;
  configOverrides?: Partial<AgencyConfig>;
  identity?: SubprocessIdentity;
}): RunInstruction | ResumeInstruction {
  if (args.saved) {
    return buildResumeInstruction({
      scriptPath: args.scriptPath,
      saved: args.saved,
      responses: collectSubprocessResponses(args.ctx, args.saved),
      limits: args.limits,
      configOverrides: args.configOverrides,
      identity: args.identity,
    });
  }
  return buildRunInstruction({
    scriptPath: args.scriptPath,
    node: args.node,
    args: args.nodeArgs,
    limits: args.limits,
    configOverrides: args.configOverrides,
    identity: args.identity,
  });
}

/** One subprocess execution segment: materialize code, pick run-vs-resume
 * from the saved payload, run the session, and translate the outcome —
 * `interrupted` saves the payload and returns rehydrated interrupts (which
 * runBatch stamps with the parent-side shared checkpoint); `result` clears
 * the payload and returns the value. */
async function invokeSubprocess(args: {
  ctx: any;
  stateStack: any;
  parentStore?: any;
  parentFrame: State;
  compiled: { moduleId: string; code: string };
  node: string;
  nodeArgs: Record<string, any>;
  limits: RunLimits;
  configOverrides?: Partial<AgencyConfig>;
  cwd?: string;
  abortSignal?: AbortSignal;
  spanId?: string;
  childDepth?: number;
  cappedMaxDepth?: number;
}): Promise<any> {
  const scriptPath = materializeCompiledScript(args.compiled);
  const startedAt = performance.now();
  let subprocessSessionId = "";
  try {
    const saved = loadSubprocessPayload(args.parentFrame);
    // One stable session id per logical child run: minted at first fork,
    // reused from the payload on every resume segment.
    subprocessSessionId = saved?.subprocessSessionId || nanoid();
    // Emitted (and awaited) BEFORE the fork so this line lands in the log
    // ahead of any child events — it is what introduces the subprocessRun
    // span to the log viewer, and the child's span parentage resolves
    // against it.
    await args.ctx.statelogClient.subprocessStarted({
      moduleId: args.compiled.moduleId,
      node: args.node,
      subprocessSessionId,
      mode: saved ? "resume" : "run",
      depth: args.childDepth ?? 1,
    });
    const instruction = resolveInstruction({
      ctx: args.ctx,
      saved,
      scriptPath,
      node: args.node,
      nodeArgs: args.nodeArgs,
      limits: args.limits,
      configOverrides: args.configOverrides,
      identity: {
        runId: args.ctx.getRunId(),
        subprocessSessionId,
        ...(args.spanId ? { spanContext: args.spanId } : {}),
        ...(args.childDepth !== undefined ? { depth: args.childDepth } : {}),
        ...(args.cappedMaxDepth !== undefined ? { maxDepth: args.cappedMaxDepth } : {}),
      },
    });
    const outcome = await runSubprocessSession({
      ctx: args.ctx,
      stateStack: args.stateStack,
      parentStore: args.parentStore,
      instruction,
      limits: args.limits,
      cwd: args.cwd,
      abortSignal: args.abortSignal,
    });
    const endEvent = (outcomeLabel: "success" | "interrupted" | "failure") =>
      args.ctx.statelogClient.subprocessEnd({
        moduleId: args.compiled.moduleId,
        node: args.node,
        subprocessSessionId,
        outcome: outcomeLabel,
        timeTaken: performance.now() - startedAt,
      });
    if (outcome.type === "interrupted") {
      await endEvent("interrupted");
      // Opaque payload: serialized with the parent frame; NEVER walked by
      // State.toJSON — the child checkpoint belongs to another process and
      // must not be spliced into the parent replay.
      saveSubprocessPayload(args.parentFrame, {
        childCheckpoint: outcome.msg.checkpoint,
        interrupts: outcome.msg.interrupts,
        node: args.node,
        subprocessSessionId: outcome.msg.subprocessSessionId,
      });
      // Rehydrate WITHOUT checkpoints; runBatch stamps the parent-side
      // shared checkpoint and overwrites intr.checkpoint on each.
      return outcome.msg.interrupts.map((intr) => ({ ...intr })) as Interrupt[];
    }
    await endEvent("success");
    clearSubprocessPayload(args.parentFrame);
    return outcome.value;
  } catch (err) {
    await args.ctx.statelogClient.subprocessEnd({
      moduleId: args.compiled.moduleId,
      node: args.node,
      subprocessSessionId,
      outcome: "failure",
      timeTaken: performance.now() - startedAt,
    });
    throw err;
  } finally {
    cleanupTempDir(scriptPath);
  }
}

/**
 * Fork a compiled Agency program as a subprocess and manage the IPC protocol.
 * A runBatch adopter with a single child: relays subprocess interrupts
 * through the parent's handler chain, and — when the child pauses itself —
 * surfaces the child's interrupts to this process's caller with a
 * parent-side shared checkpoint stamped by runBatch.
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
  maxDepth: number = DEFAULT_MAX_SUBPROCESS_DEPTH,
): Promise<any> {
  // Post-ALS: read `ctx` and the per-scope `stateStack` from the active
  // `agencyStore` frame. The trailing `__state` positional that AgencyFunction
  // .invoke() still passes is now harmlessly ignored.
  const store = getRuntimeContext();
  const { ctx, stack: stateStack } = store;

  // Nested subprocesses are allowed: every run() is gated by a std::run
  // interrupt flowing through the distributed handler chain, and this depth
  // cap backstops handlers that blindly approve.
  const childDepth = (ctx.subprocessDepth ?? 0) + 1;
  const cappedMaxDepth = resolveDepthCap(maxDepth);
  if (childDepth > cappedMaxDepth) {
    return makeLimitFailure("depth", cappedMaxDepth, childDepth);
  }

  const limits = clampLimits({ wallClock, memory, ipcPayload, stdout });

  // Forward the parent's configured provider modules to the subprocess. The
  // child runs a separately-compiled program whose baked `providerModules`
  // come from *its* compile config, not the parent's `agency.json`, so without
  // this a parent that configured providers via config would have none in the
  // child. (The `AGENCY_PROVIDER_MODULES` env var is inherited separately via
  // buildForkOptions, so env-configured providers already reach the child.)
  // Paths are resolved to absolute against the parent's cwd here so they still
  // resolve in the child even when `run(cwd:)` gives it a different cwd.
  const mergedConfigOverrides = withParentStatelog(
    withParentProviderModules(configOverrides, ctx.providerModules),
    ctx.getStatelogSink(),
  );

  const parentFrame = stateStack.lastFrame();

  // The parent-side umbrella span for this subprocess segment. Its id is
  // handed to the child (spanContext), whose statelog client adopts it as
  // an external root — child spans nest under this one in the shared trace.
  const spanId = ctx.statelogClient.startSpan("subprocessRun");
  try {
    const batchResult = await runBatch<any>({
      ctx,
      parentStack: stateStack, // the local slice from ALS — slice rule
      parentFrame,
      // `store.callsite` is set by Runner.runInScope for every generated
      // step; it is undefined only in bootstrap-frame contexts, where the
      // fallback keeps checkpoint metadata attributable.
      checkpointLocation: store.callsite ?? { moduleId: "", scopeName: "_run", stepPath: "subprocess" },
      mode: "all",
      children: [{
        key: "subprocess_0",
        invoke: (_childStack: StateStack, abortSignal: AbortSignal) =>
          invokeSubprocess({
            ctx,
            stateStack,
            parentStore: store,
            parentFrame,
            compiled,
            node,
            nodeArgs: args,
            limits,
            configOverrides: mergedConfigOverrides,
            cwd,
            abortSignal,
            spanId,
            childDepth,
            cappedMaxDepth,
          }),
      }],
    });
    if (batchResult.kind === "interrupts") return batchResult.interrupts;
    return batchResult.values[0];
  } finally {
    ctx.statelogClient.endSpan(spanId);
  }
}

/**
 * Forward the parent's statelog sink to a subprocess so child events land in
 * the SAME log the parent writes — nested under the parent's subprocessRun
 * span via the inherited runId + adopted span root. Without this, a child
 * compiled at runtime has observability baked OFF and its execution is
 * invisible in the parent's logs.
 *
 * Precedence: an explicit child logFile from the caller (run(logFile:))
 * always wins; a parent with observability disabled forwards nothing. The
 * parent's logFile is absolutized against the parent's cwd so a child
 * launched with a different `cwd` still appends to the same file.
 */
export function withParentStatelog(
  overrides: Partial<AgencyConfig> | undefined,
  parentConfig: { observability?: boolean; logFile?: string },
): Partial<AgencyConfig> | undefined {
  if (overrides?.log?.logFile) return overrides;
  if (!parentConfig.observability) return overrides;
  const logFile = parentConfig.logFile
    ? path.isAbsolute(parentConfig.logFile)
      ? parentConfig.logFile
      : path.resolve(process.cwd(), parentConfig.logFile)
    : undefined;
  return {
    ...overrides,
    observability: true,
    ...(logFile ? { log: { ...overrides?.log, logFile } } : {}),
  };
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
