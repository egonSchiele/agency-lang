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
import { tmpdir } from "os";
import type { InternalFunctionState } from "./types.js";
import { interruptWithHandlers, isApproved, hasInterrupts } from "./interrupts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolved filesystem path to the subprocess bootstrap script. */
export const subprocessBootstrapPath = path.join(__dirname, "subprocess-bootstrap.js");

export function isIpcMode(): boolean {
  return process.env.AGENCY_IPC === "1";
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
  return new Promise((resolve) => {
    const handler = (msg: any) => {
      if (msg.type === "decision") {
        process.removeListener("message", handler);
        if (msg.approved) {
          resolve({ type: "approve", value: msg.value });
        } else {
          resolve({ type: "reject", value: msg.value });
        }
      }
    };
    process.on("message", handler);
    process.send!({
      type: "interrupt",
      interrupt: interruptData,
      subprocessVotes: votes,
    } satisfies IpcInterruptMessage);
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
  const ctx = __state.ctx;
  const stateStack = __state.stateStack ?? ctx.stateStack;

  const child = fork(subprocessBootstrapPath, [], {
    stdio: ["pipe", "inherit", "inherit", "ipc"],
    env: { ...process.env, AGENCY_IPC: "1" },
  });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    const cleanup = () => {
      try {
        const tempDir = dirname(compiled.path);
        if (tempDir.startsWith(tmpdir())) {
          rmSync(tempDir, { recursive: true });
        }
      } catch (_) {
        // Ignore cleanup failures
      }
    };

    child.on("message", async (msg: any) => {
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

          if (isApproved(handlerResult)) {
            child.send({
              type: "decision",
              approved: true,
              value: (handlerResult as any).value,
            });
          } else if (hasInterrupts(handlerResult)) {
            child.send({
              type: "decision",
              approved: false,
              value: "Interrupt propagated to user (subprocess slow-path not yet supported)",
            });
          } else {
            child.send({
              type: "decision",
              approved: false,
              value: (handlerResult as any).value,
            });
          }
        } catch (err) {
          child.send({
            type: "decision",
            approved: false,
            value: `Parent handler error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else if (msg.type === "result") {
        if (!settled) {
          settled = true;
          cleanup();
          resolvePromise(msg.value);
        }
      } else if (msg.type === "error") {
        if (!settled) {
          settled = true;
          cleanup();
          rejectPromise(new Error(msg.error));
        }
      }
    });

    child.on("close", (code: number | null) => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectPromise(new Error(
          `Subprocess exited unexpectedly with code ${code}`,
        ));
      }
    });

    child.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectPromise(new Error(`Subprocess error: ${err.message}`));
      }
    });

    child.send({
      mode: "run",
      scriptPath: compiled.path,
      node: options.node,
      args: options.args,
    });
  });
}
