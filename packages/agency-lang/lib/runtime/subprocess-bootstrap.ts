/**
 * Subprocess bootstrap script — entry point for forked Agency subprocesses.
 *
 * Receives a startup message from the parent via IPC, dynamically imports the
 * compiled Agency script, runs the requested node via runNode(), and sends the
 * result back over IPC.
 *
 * The AGENCY_IPC=1 env var is set by the parent before forking, which tells
 * interruptWithHandlers to route interrupts to the parent instead of returning
 * them as Interrupt[] objects.
 */

import { pathToFileURL } from "url";
import type { IpcResultMessage, IpcErrorMessage } from "./ipc.js";
import { ipcLog } from "./ipc.js";

type RunInstruction = {
  type: "run";
  scriptPath: string;
  node: string;
  args: Record<string, any>;
  ipcPayload?: number;
};

let ipcPayloadLimit = Infinity;

function sendOrDie(msg: IpcResultMessage | IpcErrorMessage): void {
  if (typeof process.send !== "function") {
    console.error("[bootstrap] No IPC channel — was this script run directly? It should only be forked by _run().");
    process.exit(1);
  }
  ipcLog("send", msg);
  process.send(msg);
}

/**
 * Send a result message, but first verify it fits under the parent's
 * ipcPayload limit. If too big, send a structured error and exit instead.
 * The parent recognizes `reason: "limit_exceeded"` errors and converts
 * them back to the same Result.failure shape that wall_clock and memory
 * limits produce.
 */
function sendResultOrLimitError(msg: IpcResultMessage): void {
  const serialized = JSON.stringify(msg);
  if (serialized.length > ipcPayloadLimit) {
    const samplePrefix = serialized.slice(0, 1024);
    sendOrDie({
      type: "error",
      error: JSON.stringify({
        reason: "limit_exceeded",
        limit: "ipc_payload",
        threshold: ipcPayloadLimit,
        value: serialized.length,
        message: `Result payload (${serialized.length} bytes) exceeded ipcPayload limit of ${ipcPayloadLimit}`,
        samplePrefix,
      }),
    });
    process.exit(1);
  }
  sendOrDie(msg);
}

// Listen for the initial run instruction, then remove the listener
// so it doesn't interfere with sendInterruptToParent's decision handler.
const bootstrapHandler = async (msg: RunInstruction) => {
  if ((msg as any).type === "decision") {
    // Decision messages are for sendInterruptToParent, not for us
    return;
  }
  process.removeListener("message", bootstrapHandler);
  ipcLog("recv", msg);

  if (msg.type !== "run") {
    sendOrDie({
      type: "error",
      error: `Unknown message type: ${(msg as any).type ?? "undefined"}`,
    });
    process.exit(1);
  }

  if (typeof msg.ipcPayload === "number") {
    ipcPayloadLimit = msg.ipcPayload;
  }

  try {
    const scriptUrl = pathToFileURL(msg.scriptPath).href;
    ipcLog("send", { type: "log", detail: `importing ${scriptUrl}` });
    // eslint-disable-next-line no-restricted-syntax -- dynamic import required: script path is determined at runtime by the parent process
    const mod = await import(scriptUrl);

    const nodeFn = mod[msg.node];
    if (typeof nodeFn !== "function") {
      sendOrDie({
        type: "error",
        error: `Node "${msg.node}" not found in compiled module. Available exports: ${Object.keys(mod).join(", ")}`,
      });
      process.exit(1);
      return;
    }

    // Compiled nodes export a params list as __<nodeName>NodeParams.
    // Node args are positional: main(name, { messages, callbacks }).
    const paramsKey = `__${msg.node}NodeParams`;
    if (!(paramsKey in mod)) {
      sendOrDie({
        type: "error",
        error: `Node params metadata "${paramsKey}" not found in compiled module. The module may have been compiled with an incompatible version.`,
      });
      process.exit(1);
      return;
    }
    const paramNames: string[] = mod[paramsKey];
    const positionalArgs = paramNames.map((p: string) => msg.args[p]);

    ipcLog("send", { type: "log", detail: `calling node ${msg.node}` });
    const result = await nodeFn(...positionalArgs);
    ipcLog("send", { type: "log", detail: `node ${msg.node} returned` });

    sendResultOrLimitError({
      type: "result",
      value: {
        data: result.data,
        tokens: result.tokens,
        messages: result.messages?.toJSON?.() ?? result.messages,
      },
    });
    process.exit(0);
  } catch (err: any) {
    sendOrDie({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
};
process.on("message", bootstrapHandler);
