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

type RunInstruction = {
  mode: "run";
  scriptPath: string;
  node: string;
  args: Record<string, any>;
};

process.on("message", async (msg: RunInstruction) => {
  if (msg.mode !== "run") {
    process.send!({
      type: "error",
      error: `Unknown mode: ${(msg as any).mode}`,
    } satisfies IpcErrorMessage);
    process.exit(1);
  }

  try {
    const mod = await import(msg.scriptPath);

    // The compiled Agency module exports a `main()` (or named node) function
    // and a `__globalCtx`. The node function is exported by name.
    const nodeFn = mod[msg.node];
    if (typeof nodeFn !== "function") {
      process.send!({
        type: "error",
        error: `Node "${msg.node}" not found in compiled module. Available exports: ${Object.keys(mod).join(", ")}`,
      } satisfies IpcErrorMessage);
      process.exit(1);
      return;
    }

    // Call the exported node function (e.g., main({ data, callbacks }))
    // This calls runNode() internally, which uses __globalCtx.
    const result = await nodeFn({ data: msg.args });

    process.send!({
      type: "result",
      value: {
        data: result.data,
        tokens: result.tokens,
        // messages are ThreadStore instances — serialize them
        messages: result.messages?.toJSON?.() ?? result.messages,
      },
    } satisfies IpcResultMessage);
    process.exit(0);
  } catch (err: any) {
    process.send!({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    } satisfies IpcErrorMessage);
    process.exit(1);
  }
});
