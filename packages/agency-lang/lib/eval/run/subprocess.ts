import type { CodeIdentity } from "@/runDirectory/codeIdentity.js";
import { fork } from "child_process";

import type { AgencyConfig } from "@/config.js";
import { TRACE_ID_ENV } from "@/config.js";
import type { IpcDecisionMessage } from "@/runtime/ipc.js";
import {
  buildForkOptions,
  buildRunInstruction,
  subprocessBootstrapPath,
  type RunLimits,
} from "@/runtime/ipc.js";

/** One run's execution job, mirroring the EvalTarget kinds: a compiled file
 *  entry to fork and invoke over IPC, or a substituted command argv to
 *  spawn. */
export type EvalRunnerJob =
  | {
      kind: "file";
      compiledEntryPath: string;
      node: string;
      input: string | Record<string, any>;
      cwd: string;
      statelogPath: string;
      /** Identity of the seeded agent code, recorded on the trace's agentStart. */
      code: CodeIdentity;
    }
  | { kind: "command"; argv: string[]; cwd: string; statelogPath: string; traceId: string };

/** How to actually run one job. The default dispatches by kind (fork for
 *  files, spawn for commands); tests inject a fake. Must never throw —
 *  failures are returned as `{ ok: false, errorMessage }`. On success the
 *  runner may report the path where it actually wrote the statelog. */
export type EvalInputRunner = (
  job: EvalRunnerJob,
) => Promise<{ ok: true; statelogPath?: string } | { ok: false; errorMessage: string }>;

/**
 * Per-task resource limits for subprocess invocations driven by `agency eval
 * run`. Lifted out of the runner so it's obvious where to tune them and so
 * the runner body isn't cluttered with magic numbers.
 */
const DEFAULT_EVAL_RUN_LIMITS: RunLimits = {
  wallClock: 60_000,
  memory: 512 * 1024 * 1024,
  ipcPayload: 100 * 1024 * 1024,
  stdout: 1024 * 1024,
};

/** The run limits a suite's config asks for: `eval.limits` overlaid on the
 *  defaults. Only wall clock is configurable so far. The schema already
 *  rejects non-positive values at config load; the guard here covers configs
 *  built programmatically, where 0/-1/NaN would otherwise reach setTimeout
 *  and fail every run instantly with a wall_clock limit error. */
export function limitsFromConfig(config: AgencyConfig, timeoutSecOverride?: number): RunLimits {
  // Per-test override (the input's timeoutSec) beats the suite-level config.
  const wallClockSec = timeoutSecOverride ?? config.eval?.limits?.wallClockSec;
  const valid =
    typeof wallClockSec === "number" && Number.isFinite(wallClockSec) && wallClockSec > 0;
  return {
    ...DEFAULT_EVAL_RUN_LIMITS,
    ...(valid ? { wallClock: wallClockSec * 1000 } : {}),
  };
}

/** Defensive per-run LLM spend ceiling — an accident stopper, not a budget
 *  (raise it via eval.limits.maxCostUsd when a run legitimately needs more). */
const DEFAULT_EVAL_MAX_COST_USD = 50;

export function costCapFromConfig(config: AgencyConfig): number {
  const cap = config.eval?.limits?.maxCostUsd;
  const valid = typeof cap === "number" && Number.isFinite(cap) && cap > 0;
  return valid ? cap : DEFAULT_EVAL_MAX_COST_USD;
}

/** Accumulates a run's LLM spend and answers "over the cap?". Enforcement
 *  necessarily lags by one LLM call — a call's cost is known only after it
 *  returns — so this is a backstop, the same trade every cost guard makes.
 *  Shared by the fork runner (fed by IPC cost telemetry) and the spawn
 *  runner (fed by tailing the statelog). */
export function makeCostCapTracker(capUsd: number): {
  add(costUsd: unknown): boolean;
  total(): number;
  exceededMessage(): string;
} {
  let total = 0;
  return {
    add(costUsd: unknown): boolean {
      if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0) {
        total += costUsd;
      }
      return total > capUsd;
    },
    total: () => total,
    exceededMessage: () =>
      `cost cap exceeded: $${total.toFixed(2)} spent, cap $${capUsd.toFixed(2)} ` +
      `(eval.limits.maxCostUsd raises it)`,
  };
}

/** The fork options for a file-target eval child, with one env subtraction:
 *  a harness-set (or shell-stray) AGENCY_TRACE_ID must not leak in — file
 *  targets get their trace id from their own run, and inheriting one would
 *  merge unrelated runs into a single trace. Same precedent as run()
 *  clearing AGENCY_RUN_POLICY (lib/cli/commands.ts). Exported for tests. */
export function evalForkOptions(
  limits: RunLimits,
  cwd: string,
): ReturnType<typeof buildForkOptions> {
  const options = buildForkOptions({ limits, cwd });
  delete (options.env as Record<string, string | undefined>)[TRACE_ID_ENV];
  return options;
}

export function makeSubprocessRunner(
  pipeAgentOutput: boolean,
  limits: RunLimits = DEFAULT_EVAL_RUN_LIMITS,
  maxCostUsd: number = DEFAULT_EVAL_MAX_COST_USD,
): EvalInputRunner {
  return async (job) => {
    if (job.kind !== "file") {
      return {
        ok: false,
        errorMessage: "the fork runner only runs file jobs; command jobs go to runCommandInSpawn",
      };
    }
    return runCompiledAgentInSubprocess({
      compiledPath: job.compiledEntryPath,
      node: job.node,
      input: job.input,
      cwd: job.cwd,
      statelogPath: job.statelogPath,
      code: job.code,
      pipeAgentOutput,
      limits,
      maxCostUsd,
    });
  };
}

async function runCompiledAgentInSubprocess(args: {
  compiledPath: string;
  node: string;
  input: string | Record<string, any>;
  cwd: string;
  statelogPath: string;
  code: CodeIdentity;
  pipeAgentOutput: boolean;
  limits: RunLimits;
  maxCostUsd: number;
}): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  const limits = args.limits;
  const child = fork(subprocessBootstrapPath, [], evalForkOptions(limits, args.cwd));
  const instruction = buildRunInstruction({
    scriptPath: args.compiledPath,
    node: args.node,
    input: args.input,
    limits,
    configOverrides: {
      observability: true,
      log: { logFile: args.statelogPath, code: args.code },
    },
  });

  return new Promise((resolve) => {
    let settled = false;
    // A terminal Ctrl-C reaches the whole process group, but a programmatic
    // SIGINT (a supervisor, process.kill) hits only this process — forward it
    // so the child never outlives an interrupted run. The kill settles this
    // promise through the normal "close" path, as an error result.
    const forwardSigint = () => {
      child.kill("SIGINT");
    };
    process.once("SIGINT", forwardSigint);
    const settle = (value: { ok: true } | { ok: false; errorMessage: string }) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", forwardSigint);
      resolve(value);
    };

    if (args.pipeAgentOutput) {
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }

    // The child streams per-charge cost telemetry unprompted (StateStack.
    // billCharge → sendCostTelemetryToParent, every IPC child); billing it
    // against the cap here is the guard-around-the-subprocess std::agency.run
    // runs, minus the guard stack.
    const costCap = makeCostCapTracker(args.maxCostUsd);
    child.on("message", (msg: any) => {
      if (msg?.type === "result") {
        settle({ ok: true });
      } else if (msg?.type === "error") {
        settle({ ok: false, errorMessage: String(msg.error) });
      } else if (msg?.type === "interrupt") {
        child.send(evalInterruptDecision(msg.interruptId));
      } else if (msg?.type === "telemetry") {
        if (costCap.add(msg.costUsd)) {
          child.kill("SIGKILL");
          settle({ ok: false, errorMessage: costCap.exceededMessage() });
        }
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
