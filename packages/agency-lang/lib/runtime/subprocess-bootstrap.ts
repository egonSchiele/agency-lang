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

import type { IpcResultMessage, IpcErrorMessage } from "./ipc.js";
import { ipcLog } from "./ipc.js";

type RunInstruction = {
  mode: "run";
  scriptPath: string;
  node: string;
  args: Record<string, any>;
};

// Listen for the initial run instruction, then remove the listener
// so it doesn't interfere with sendInterruptToParent's decision handler.
const bootstrapHandler = async (msg: RunInstruction) => {
  if ((msg as any).type === "decision") {
    // Decision messages are for sendInterruptToParent, not for us
    return;
  }
  process.removeListener("message", bootstrapHandler);
  ipcLog("recv", msg);

  if (msg.mode !== "run") {
    const errMsg = {
      type: "error",
      error: `Unknown mode: ${(msg as any).mode}`,
    } satisfies IpcErrorMessage;
    ipcLog("send", errMsg);
    process.send!(errMsg);
    process.exit(1);
  }

  try {
    ipcLog("send", { type: "log", detail: `importing ${msg.scriptPath}` });
    const mod = await import(msg.scriptPath);

    // The compiled Agency module exports a `main()` (or named node) function
    // and a `__globalCtx`. The node function is exported by name.
    const nodeFn = mod[msg.node];
    if (typeof nodeFn !== "function") {
      const errMsg = {
        type: "error",
        error: `Node "${msg.node}" not found in compiled module. Available exports: ${Object.keys(mod).join(", ")}`,
      } satisfies IpcErrorMessage;
      ipcLog("send", errMsg);
      process.send!(errMsg);
      process.exit(1);
      return;
    }

    ipcLog("send", { type: "log", detail: `calling node ${msg.node}` });
    // Compiled nodes export a params list as __<nodeName>NodeParams.
    // Node args are positional: main(name, { messages, callbacks }).
    const paramsKey = `__${msg.node}NodeParams`;
    const paramNames: string[] = mod[paramsKey] ?? [];
    const positionalArgs = paramNames.map((p: string) => msg.args[p]);
    const result = await nodeFn(...positionalArgs);
    ipcLog("send", { type: "log", detail: `node ${msg.node} returned` });

    const resultMsg = {
      type: "result",
      value: {
        data: result.data,
        tokens: result.tokens,
        // messages are ThreadStore instances — serialize them
        messages: result.messages?.toJSON?.() ?? result.messages,
      },
    } satisfies IpcResultMessage;
    ipcLog("send", resultMsg);
    process.send!(resultMsg);
    process.exit(0);
  } catch (err: any) {
    const errMsg = {
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    } satisfies IpcErrorMessage;
    ipcLog("send", errMsg);
    process.send!(errMsg);
    process.exit(1);
  }
};
process.on("message", bootstrapHandler);
