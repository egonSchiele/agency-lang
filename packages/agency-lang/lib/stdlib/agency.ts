import { compileSource } from "../compiler/compile.js";
import { interruptWithHandlers, isApproved, hasInterrupts } from "../runtime/index.js";
import { subprocessBootstrapPath } from "../runtime/ipc.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fork } from "child_process";

export function _compile(source: string): { moduleId: string; path: string } {
  const result = compileSource(source, {
    typeCheck: true,
    restrictImports: true,
  });

  if (!result.success) {
    throw new Error(result.errors.join("\n"));
  }

  // Write compiled JS to a temp file for subprocess execution.
  // Cleanup is the caller's responsibility (e.g., _run() cleans up after execution).
  const tempDir = mkdtempSync(join(tmpdir(), "agency-"));
  const tempPath = join(tempDir, `${result.moduleId}.js`);
  writeFileSync(tempPath, result.code, "utf-8");

  return { moduleId: result.moduleId, path: tempPath };
}

export async function _run(
  compiled: { path: string; moduleId: string },
  options: { node: string; args: Record<string, any> },
  state?: { ctx: any; threads: any; stateStack: any },
): Promise<{ data: any; messages: any; tokens: any }> {
  if (!state?.ctx) {
    throw new Error("_run() requires runtime context (ctx)");
  }

  const ctx = state.ctx;

  const child = fork(subprocessBootstrapPath, [], {
    stdio: ["pipe", "inherit", "inherit", "ipc"],
    env: { ...process.env, AGENCY_IPC: "1" },
  });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    const cleanup = () => {
      // Clean up temp file (best-effort)
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
        // Run the interrupt through the parent's handler chain
        const { kind, message, data, origin } = msg.interrupt;

        const handlerResult = await interruptWithHandlers(
          kind,
          message,
          data,
          origin,
          ctx,
          state.stateStack,
        );

        if (isApproved(handlerResult)) {
          child.send({
            type: "decision",
            approved: true,
            value: (handlerResult as any).value,
          });
        } else if (hasInterrupts(handlerResult)) {
          // Parent's handlers didn't resolve (propagated to user).
          // For MVP, we reject — full slow-path (serialize + resume) is future work.
          child.send({
            type: "decision",
            approved: false,
            value: "Interrupt propagated to user (subprocess slow-path not yet supported)",
          });
        } else {
          // Parent rejected
          child.send({
            type: "decision",
            approved: false,
            value: (handlerResult as any).value,
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

    // Send the run instruction
    child.send({
      mode: "run",
      scriptPath: compiled.path,
      node: options.node,
      args: options.args,
    });
  });
}
