/**
 * IPC-mode interrupt handling for subprocess execution.
 * When AGENCY_IPC=1 is set, interrupts are sent to the parent process
 * over Node's built-in IPC channel instead of being returned as Interrupt[].
 */

import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { fork } from "child_process";
import { rmSync } from "fs";
import type { InternalFunctionState } from "./types.js";
import { interruptWithHandlers, isApproved, hasInterrupts } from "./interrupts.js";
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
  if (type === "interrupt") detail = `kind=${msg.interrupt?.kind}`;
  else if (type === "decision") detail = `approved=${msg.approved}`;
  else if (type === "result") detail = `data=${truncate(msg.value?.data)}`;
  else if (type === "error") detail = `error=${truncate(msg.error)}`;
  else if (type === "run") detail = `node=${msg.node} script=${msg.scriptPath}`;
  else detail = truncate(msg);
  process.stderr.write(`[ipc:${role}] ${ts} ${direction} ${type} ${detail}\n`);
}

export type SubprocessVotes = {
  propagated: boolean;
};

export type IpcInterruptMessage = {
  type: "interrupt";
  interrupt: {
    kind: string;
    message: string;
    data: any;
    origin: string;
  };
  subprocessVotes: SubprocessVotes;
};

export type IpcResultMessage = {
  type: "result";
  value: any;
};

export type IpcErrorMessage = {
  type: "error";
  error: string;
};

export type IpcDecisionMessage = {
  type: "decision";
  approved: boolean;
  value: any;
};

export type SubprocessToParent = IpcInterruptMessage | IpcResultMessage | IpcErrorMessage;
export type ParentToSubprocess = IpcDecisionMessage;

/**
 * Send an interrupt to the parent process and await the decision.
 * The parent always sends back a final approve or reject — never propagate.
 */
export async function sendInterruptToParent(
  interruptData: {
    kind: string;
    message: string;
    data: any;
    origin: string;
  },
  votes: SubprocessVotes,
): Promise<{ type: "approve"; value?: any } | { type: "reject"; value?: any }> {
  if (typeof process.send !== "function") {
    throw new Error(
      "sendInterruptToParent called without an IPC channel. This function can only be used inside a forked subprocess (AGENCY_IPC=1).",
    );
  }
  const outMsg = {
    type: "interrupt",
    interrupt: interruptData,
    subprocessVotes: votes,
  } satisfies IpcInterruptMessage;
  ipcLog("send", outMsg);
  return new Promise((resolve) => {
    const handler = (msg: any) => {
      if (msg.type === "decision") {
        process.removeListener("message", handler);
        ipcLog("recv", msg);
        if (msg.approved) {
          resolve({ type: "approve", value: msg.value });
        } else {
          resolve({ type: "reject", value: msg.value });
        }
      }
    };
    process.on("message", handler);
    // Safe to assert — guarded by typeof check at function entry
    process.send!(outMsg);
  });
}

/**
 * Mutable per-call state shared by all the subprocess event handlers.
 * Bundled into one object so helpers can be extracted to module scope
 * without each one needing 8 closure parameters.
 */
type RunSession = {
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
};

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
  const { kind, message, data, origin } = msg.interrupt;
  try {
    const handlerResult = await interruptWithHandlers(kind, message, data, origin, s.ctx, s.stateStack);
    let decision: any;
    if (isApproved(handlerResult)) {
      decision = { type: "decision", approved: true, value: (handlerResult as any).value };
    } else if (hasInterrupts(handlerResult)) {
      decision = { type: "decision", approved: false, value: "Interrupt propagated to user (subprocess slow-path not yet supported)" };
    } else {
      decision = { type: "decision", approved: false, value: (handlerResult as any).value };
    }
    trySendDecision(s, decision);
  } catch (err) {
    trySendDecision(s, {
      type: "decision",
      approved: false,
      value: `Parent handler error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
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
  let serialized: string;
  try {
    serialized = JSON.stringify(msg);
  } catch (err) {
    settle(s, s.rejectPromise, new Error(
      `Failed to serialize subprocess message: ${err instanceof Error ? err.message : String(err)}`,
    ));
    return;
  }
  if (serialized.length > s.limits.ipcPayload) {
    settleWithLimitFailure(s, "ipc_payload", s.limits.ipcPayload, serialized.length, {
      samplePrefix: serialized.slice(0, 1024),
    });
    return;
  }
  if (msg.type === "interrupt") {
    await handleInterruptMessage(s, msg);
  } else if (msg.type === "result") {
    settle(s, s.resolvePromise, msg.value);
  } else if (msg.type === "error") {
    handleErrorMessage(s, msg);
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

  const runMsg = {
    type: "run",
    scriptPath: s.compiledPath,
    node,
    args,
    ipcPayload: s.limits.ipcPayload,
  };
  ipcLog("send", runMsg);
  s.child.send(runMsg);
}

/**
 * Fork a compiled Agency program as a subprocess and manage the IPC protocol.
 * Relays subprocess interrupts through the parent's handler chain via interruptWithHandlers.
 */
export async function _run(
  compiled: { path: string; moduleId: string },
  node: string,
  args: Record<string, any>,
  wallClock: number,
  memory: number,
  ipcPayload: number,
  stdout: number,
  __state: InternalFunctionState,
): Promise<any> {
  if (isIpcMode()) {
    throw new Error("Nested subprocess execution is not supported.");
  }
  const ctx = __state.ctx;
  const stateStack = __state.stateStack ?? ctx.stateStack;
  const limits = clampLimits({ wallClock, memory, ipcPayload, stdout });

  const memoryMb = Math.max(1, Math.floor(limits.memory / (1024 * 1024)));
  // stdio fds 1/2 piped (was inherit) so we can byte-count and truncate
  // when stdout limit is exceeded; we still forward bytes through to the
  // parent's own stdout/stderr until the limit hits.
  const child = fork(subprocessBootstrapPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, AGENCY_IPC: "1" },
    execArgv: [`--max-old-space-size=${memoryMb}`],
  });

  return new Promise((resolvePromise, rejectPromise) => {
    const session: RunSession = {
      child,
      limits,
      ctx,
      stateStack,
      compiledPath: compiled.path,
      resolvePromise,
      rejectPromise,
      settled: false,
      startedAt: Date.now(),
      wallClockTimer: null,
      stdoutBytes: 0,
      stoppedForwarding: false,
    };
    attachSessionHandlers(session, node, args);
  });
}
