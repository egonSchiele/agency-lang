// The child side of the channel between an Agency subprocess and its
// parent: the message types both sides read, the two senders a run in a
// child calls (an interrupt for the parent's handler chain, a lock held by
// the parent), the payload limit the bootstrap sets, and the debug log.
// Everything reaches the process through the default host's
// `system.parentChannel()`, so this file imports no Node module and a
// program can reach it on any platform; without a channel the senders
// throw, as they always did. The parent side, which forks the child, is
// ipc.ts.

import { nanoid } from "nanoid";
import { defaultHost } from "#default-host";
import { utf8ByteLength } from "../stdlib/base64.js";
import type { ScopedField } from "./alwaysScope.js";
import type { IpcCallbackMessage } from "./callbackForwarding.js";
import type { IpcInvocationUsageMessage } from "./costTelemetry.js";
import type { HandlerChainOutcome } from "./interrupts.js";
import type { WithLockOptions, LockRelease } from "./lock.js";
import { getSubprocessRunInfo, isIpcMode } from "./subprocessRunInfo.js";
import { truncate } from "./truncate.js";

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
    expectsValue?: boolean;
    /** The fields an "approve always here" rule pins for this effect, from
     * its declaration. The child always sends it; the parent may never have
     * imported that module. The receiver treats a missing scope as empty. */
    alwaysScope?: ScopedField[];
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
  | IpcInvocationUsageMessage
  | { type: "invocationUsageIncomplete" }
  | IpcCallbackMessage;
export type ParentToSubprocess = IpcDecisionMessage | IpcLockGrantedMessage;

let subprocessIpcPayloadLimit = Infinity;

export function setSubprocessIpcPayloadLimit(limit: number): void {
  subprocessIpcPayloadLimit = limit;
}

export function serializedByteLength(
  value: any,
): { ok: true; serialized: string; byteLength: number } | { ok: false; error: string } {
  try {
    const serialized = JSON.stringify(value);
    // JSON.stringify gives undefined, not a string, for undefined and
    // for a function.
    if (typeof serialized !== "string") {
      return { ok: false, error: `${typeof value} is not serializable as JSON` };
    }
    return { ok: true, serialized, byteLength: utf8ByteLength(serialized) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function buildIpcPayloadLimitError(
  threshold: number,
  value: number,
  samplePrefix = "",
): IpcErrorMessage {
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

const ipcDebug = defaultHost().settings.read("AGENCY_IPC_DEBUG") === "1";
export const ipcRole = isIpcMode() ? "child" : "parent";

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
  defaultHost().terminal.writeErr(`[ipc:${ipcRole}] ${ts} ${direction} ${type} ${detail}\n`);
}

/**
 * Send an interrupt to the parent process and await the parent's handler
 * chain OUTCOME (not a verdict — the child merges and decides). The parent
 * always replies explicitly; the child never infers from silence.
 * `interruptId` is the child's interrupt-level id, used verbatim as the
 * message id so decision routing and statelog correlation share one key.
 */
export async function sendInterruptToParent(
  interruptData: IpcInterruptMessage["interrupt"],
  interruptId: string,
): Promise<HandlerChainOutcome> {
  const channel = defaultHost().system.parentChannel();
  if (channel === null) {
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
    channel.send({ type: "error", error: value } satisfies IpcErrorMessage);
    return { kind: "rejected", value };
  }
  if (serialized.byteLength > subprocessIpcPayloadLimit) {
    const errorMsg = buildIpcPayloadLimitError(
      subprocessIpcPayloadLimit,
      serialized.byteLength,
      serialized.serialized.slice(0, 1024),
    );
    channel.send(errorMsg);
    return { kind: "rejected", value: errorMsg.error };
  }
  ipcLog("send", outMsg);
  return new Promise((resolve) => {
    const stop = channel.onMessage((msg: any) => {
      if (msg.type === "decision" && msg.interruptId === interruptId) {
        stop();
        ipcLog("recv", msg);
        resolve(msg.outcome as HandlerChainOutcome);
      }
    });
    channel.send(outMsg);
  });
}

export async function sendLockAcquireToParent(
  name: string,
  opts: WithLockOptions = {},
): Promise<LockRelease> {
  const channel = defaultHost().system.parentChannel();
  if (channel === null) {
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
    const stop = channel.onMessage((msg: any) => {
      if (msg.type === "lockGranted" && msg.requestId === outMsg.requestId) {
        if (settled) return;
        settled = true;
        stop();
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
          try {
            channel.send(releaseMsg);
          } catch {
            // the parent is gone; its lock went with it
          }
        });
      }
    });
    channel.send(outMsg);
  });
}
