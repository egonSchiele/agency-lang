import { fork } from "child_process";

import type { IpcDecisionMessage } from "@/runtime/ipc.js";
import {
  buildForkOptions,
  buildRunInstruction,
  subprocessBootstrapPath,
  type RunLimits,
} from "@/runtime/ipc.js";

/** How to actually invoke the compiled agent for one run. The default forks a
 *  subprocess; tests inject a fake. Must never throw — failures are returned
 *  as `{ ok: false, errorMessage }`. On success the runner may report the
 *  path where it actually wrote the statelog. */
export type EvalInputRunner = (args: {
  compiledEntryPath: string;
  node: string;
  args: Record<string, any>;
  cwd: string;
  statelogPath: string;
}) => Promise<{ ok: true; statelogPath?: string } | { ok: false; errorMessage: string }>;

/**
 * Per-task resource limits for subprocess invocations driven by `agency eval
 * run`. Lifted out of the runner so it's obvious where to tune them and so
 * the runner body isn't cluttered with magic numbers.
 *
 * TODO: pipe these through `AgencyConfig.eval.limits` once that field exists.
 */
const DEFAULT_EVAL_RUN_LIMITS: RunLimits = {
  wallClock: 60_000,
  memory: 512 * 1024 * 1024,
  ipcPayload: 100 * 1024 * 1024,
  stdout: 1024 * 1024,
};

export function makeSubprocessRunner(pipeAgentOutput: boolean): EvalInputRunner {
  return async ({ compiledEntryPath, node, args, cwd, statelogPath }) => {
    return runCompiledAgentInSubprocess({
      compiledPath: compiledEntryPath,
      node,
      args,
      cwd,
      statelogPath,
      pipeAgentOutput,
    });
  };
}

async function runCompiledAgentInSubprocess(args: {
  compiledPath: string;
  node: string;
  args: Record<string, any>;
  cwd: string;
  statelogPath: string;
  pipeAgentOutput: boolean;
}): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  const limits = DEFAULT_EVAL_RUN_LIMITS;
  const child = fork(
    subprocessBootstrapPath,
    [],
    buildForkOptions({ limits, cwd: args.cwd }),
  );
  const instruction = buildRunInstruction({
    scriptPath: args.compiledPath,
    node: args.node,
    args: args.args,
    limits,
    configOverrides: {
      observability: true,
      log: { logFile: args.statelogPath },
    },
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      value: { ok: true } | { ok: false; errorMessage: string },
    ) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (args.pipeAgentOutput) {
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }

    child.on("message", (msg: any) => {
      if (msg?.type === "result") {
        settle({ ok: true });
      } else if (msg?.type === "error") {
        settle({ ok: false, errorMessage: String(msg.error) });
      } else if (msg?.type === "interrupt") {
        child.send(evalInterruptDecision(msg.interruptId));
      }
    });

    child.on("error", (err) => settle({ ok: false, errorMessage: err.message }));
    child.on("close", (code, signal) => {
      if (code === 0) {
        settle({ ok: true });
      } else {
        settle({
          ok: false,
          errorMessage: `Subprocess exited with code ${code}${signal ? ` signal ${signal}` : ""}`,
        });
      }
    });

    child.send(instruction);
  });
}

/**
 * The eval parent's blanket auto-approval for subprocess interrupts (eval
 * runs headless; the agent's own handlers ran first and a local reject is
 * already final before the parent is consulted). The return type pins the
 * IPC protocol: this reply once used a legacy `{ approved: true }` shape,
 * the child read `outcome.kind` off undefined, and every interrupting agent
 * under `agency eval run` crashed. tests/integration/eval-run/test.mjs
 * exercises this end-to-end. The child records the verdict in its statelog
 * (`interruptResolved`, resolvedBy "ipc"), so approvals stay auditable.
 */
function evalInterruptDecision(interruptId: string): IpcDecisionMessage {
  return {
    type: "decision",
    interruptId,
    outcome: { kind: "approved", value: undefined },
  };
}
