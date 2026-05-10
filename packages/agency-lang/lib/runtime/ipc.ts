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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolved filesystem path to the subprocess bootstrap script. */
export const subprocessBootstrapPath = path.join(__dirname, "subprocess-bootstrap.js");

export function isIpcMode(): boolean {
  return process.env.AGENCY_IPC === "1";
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
  const type = msg?.type ?? msg?.mode ?? "unknown";
  const detail = type === "interrupt"
    ? `kind=${msg.interrupt?.kind}`
    : type === "decision"
      ? `approved=${msg.approved}`
      : type === "result"
        ? `data=${truncate(msg.value?.data)}`
        : type === "error"
          ? `error=${truncate(msg.error)}`
          : type === "run"
            ? `node=${msg.node} script=${msg.scriptPath}`
            : truncate(msg);
  process.stderr.write(`[ipc:${role}] ${ts} ${direction} ${type} ${detail}\n`);
}

export type SubprocessVotes = {
  approved: boolean;
  rejected: boolean;
  propagated: boolean;
  approvedValue: any;
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
 * Fork a compiled Agency program as a subprocess and manage the IPC protocol.
 * Relays subprocess interrupts through the parent's handler chain via interruptWithHandlers.
 */
export async function _run(
  compiled: { path: string; moduleId: string },
  options: { node: string; args: Record<string, any> },
  __state: InternalFunctionState,
): Promise<any> {
  if (isIpcMode()) {
    throw new Error("Nested subprocess execution is not supported.");
  }
  const ctx = __state.ctx;
  const stateStack = __state.stateStack ?? ctx.stateStack;

  const child = fork(subprocessBootstrapPath, [], {
    stdio: ["pipe", "inherit", "inherit", "ipc"],
    env: { ...process.env, AGENCY_IPC: "1" },
  });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    const settle = (fn: typeof resolvePromise | typeof rejectPromise, value: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const cleanup = () => {
      try {
        const tempDir = path.resolve(dirname(compiled.path));
        const allowedPrefix = path.resolve(process.cwd(), ".agency-tmp");
        if (tempDir.startsWith(allowedPrefix + path.sep)) {
          rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (_) {
        // Ignore cleanup failures
      }
    };

    const trySend = (msg: any) => {
      try {
        if (child.connected) {
          ipcLog("send", msg);
          child.send(msg);
        }
      } catch (_) {
        // IPC channel closed — subprocess is gone
        settle(rejectPromise, new Error("IPC channel closed while sending decision to subprocess"));
      }
    };

    child.on("message", async (msg: any) => {
      ipcLog("recv", msg);
      if (msg.type === "interrupt") {
        const { kind, message, data, origin } = msg.interrupt;

        try {
          const handlerResult = await interruptWithHandlers(
            kind,
            message,
            data,
            origin,
            ctx,
            stateStack,
          );

          let decision: any;
          if (isApproved(handlerResult)) {
            decision = { type: "decision", approved: true, value: (handlerResult as any).value };
          } else if (hasInterrupts(handlerResult)) {
            decision = { type: "decision", approved: false, value: "Interrupt propagated to user (subprocess slow-path not yet supported)" };
          } else {
            decision = { type: "decision", approved: false, value: (handlerResult as any).value };
          }
          trySend(decision);
        } catch (err) {
          const decision = {
            type: "decision",
            approved: false,
            value: `Parent handler error: ${err instanceof Error ? err.message : String(err)}`,
          };
          trySend(decision);
        }
      } else if (msg.type === "result") {
        settle(resolvePromise, msg.value);
      } else if (msg.type === "error") {
        settle(rejectPromise, new Error(msg.error));
      }
    });

    child.on("close", (code: number | null) => {
      settle(rejectPromise, new Error(
        `Subprocess exited unexpectedly with code ${code}`,
      ));
    });

    child.on("error", (err: Error) => {
      settle(rejectPromise, new Error(`Subprocess error: ${err.message}`));
    });

    const runMsg = {
      type: "run",
      scriptPath: compiled.path,
      node: options.node,
      args: options.args,
    };
    ipcLog("send", runMsg);
    child.send(runMsg);
  });
}
