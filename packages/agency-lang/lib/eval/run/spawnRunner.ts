import { spawn } from "child_process";

import { CONFIG_OVERRIDES_ENV, serializeConfigOverrides, TRACE_ID_ENV } from "@/config.js";
import { ttyColor } from "@/utils/termcolors.js";
import type { RunLimits } from "@/runtime/ipc.js";

import { makeStatelogCostTailer } from "./costTail.js";

/** Substituted argv must fit the OS argument-size limit; the raw failure is
 *  an opaque E2BIG from spawn. Conservative cap, checked before spawning. */
export const MAX_COMMAND_BYTES = 128 * 1024;

/** How long after SIGTERM before SIGKILL, when the wall clock trips. */
const KILL_GRACE_MS = 5_000;

/** Keep this much of the drained stderr for error messages. */
const STDERR_TAIL_CHARS = 2_000;

/**
 * Run a command target: spawn (not fork — no IPC channel) in the workdir,
 * with the statelog handoff in the env. Every compiled Agency process the
 * command starts — directly or through descendants — reads
 * AGENCY_CONFIG_OVERRIDES at startup and writes its statelog to the
 * harness's expected path, and AGENCY_TRACE_ID keeps the whole tree on one
 * trace id (including descendants started without IPC). Never throws;
 * failures settle as { ok: false }.
 */
export function runCommandInSpawn(args: {
  argv: string[];
  cwd: string;
  statelogPath: string;
  traceId: string;
  pipeOutput: boolean;
  limits: RunLimits;
  maxCostUsd: number;
}): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
  const totalBytes = Buffer.byteLength(args.argv.join(" "));
  if (totalBytes > MAX_COMMAND_BYTES) {
    return Promise.resolve({
      ok: false,
      errorMessage:
        `the substituted command is ${totalBytes} bytes, over the ${MAX_COMMAND_BYTES}-byte cap ` +
        `(the OS rejects oversized argv with an opaque E2BIG) — an object task this large ` +
        `should travel via the input's files, not argv`,
    });
  }

  // Memory: weaker than the fork runner's, and deliberately so —
  // --max-old-space-size bounds the V8 heap of Node processes only (not
  // native allocations, not non-Node commands). Acceptable because command
  // targets are Agency CLIs, which are Node; a non-Agency target kind must
  // revisit this.
  const memoryMb = Math.max(1, Math.floor(args.limits.memory / (1024 * 1024)));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [CONFIG_OVERRIDES_ENV]: serializeConfigOverrides({
      observability: true,
      log: { logFile: args.statelogPath },
    }),
    [TRACE_ID_ENV]: args.traceId,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${memoryMb}`]
      .filter(Boolean)
      .join(" "),
  };

  const child = spawn(args.argv[0], args.argv.slice(1), {
    cwd: args.cwd,
    env,
    // Never leave a pipe unread: a full ~64 KB pipe buffer blocks a chatty
    // agent forever, and the wall clock would then report a timeout with no
    // cause. Both streams are always drained below.
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so limit kills reach the whole TREE. The command is
    // typically a CLI wrapper whose grandchild does the real work; killing
    // only the direct child orphans the grandchild, which keeps running and
    // spending while holding our pipes open (observed: a wall-clocked agent
    // that survived 8 more minutes). Detaching also removes the tree from
    // the terminal's foreground group, so Ctrl-C no longer reaches it on its
    // own — the SIGINT forwarding below is what delivers it, as a group kill.
    detached: true,
  });

  // Signal the whole group (-pid); fall back to the direct child if the
  // group is already gone.
  const killTree = (signal: NodeJS.Signals) => {
    try {
      process.kill(-(child.pid as number), signal);
    } catch {
      child.kill(signal);
    }
  };

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let costCapped = false;
    let costCappedTotal = 0;
    let stdoutBytes = 0;
    let stderrTail = "";
    const timers: NodeJS.Timeout[] = [];
    const intervals: NodeJS.Timeout[] = [];

    // The detached tree must never outlive this process: forward the
    // terminating signals as group kills, and reap on ANY exit (normal,
    // crash, uncaught throw). The one hole no supervisor can close is
    // SIGKILL of this process — nothing runs then; the tree's remaining
    // protection is EPIPE on its next write to our closed pipes.
    const forwardSigint = () => killTree("SIGINT");
    const forwardSigterm = () => killTree("SIGTERM");
    const forwardSighup = () => killTree("SIGHUP");
    const reapOnExit = () => killTree("SIGKILL");
    process.once("SIGINT", forwardSigint);
    process.once("SIGTERM", forwardSigterm);
    process.once("SIGHUP", forwardSighup);
    process.once("exit", reapOnExit);

    const settle = (value: { ok: true } | { ok: false; errorMessage: string }) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", forwardSigint);
      process.removeListener("SIGTERM", forwardSigterm);
      process.removeListener("SIGHUP", forwardSighup);
      process.removeListener("exit", reapOnExit);
      for (const t of timers) clearTimeout(t);
      for (const t of intervals) clearInterval(t);
      resolve(value);
    };

    // Cost cap, without an IPC channel: the child appends promptCompletion
    // events (each carrying its call's cost) to the statelog the harness
    // pointed it at — tail that file.
    const costTail = makeStatelogCostTailer(args.statelogPath);
    intervals.push(setInterval(() => {
      if (costTail.poll() > args.maxCostUsd) {
        costCapped = true;
        costCappedTotal = costTail.poll();
        killTree("SIGTERM");
        timers.push(setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS));
      }
    }, 1_000));

    // Deliberate divergence from the fork runner: the fork path FAILS the
    // run at the stdout limit (lib/runtime/ipc.ts settleWithLimitFailure),
    // which is right for programmatic subprocess use. A benchmark must not
    // score a chatty-but-correct agent zero for verbosity — agency agent is
    // chatty by design — so here the cap only stops forwarding.
    child.stdout?.on("data", (buf: Buffer) => {
      stdoutBytes += buf.length;
      if (args.pipeOutput && stdoutBytes <= args.limits.stdout) {
        process.stdout.write(buf);
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stdoutBytes += buf.length;
      stderrTail = (stderrTail + buf.toString()).slice(-STDERR_TAIL_CHARS);
      if (args.pipeOutput && stdoutBytes <= args.limits.stdout) {
        // Red so the agent's error stream reads as one at a glance; raw when
        // stderr is not a terminal.
        process.stderr.write(process.stderr.isTTY ? ttyColor.red(buf.toString()) : buf);
      }
    });

    timers.push(setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      timers.push(setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS));
    }, args.limits.wallClock));

    child.on("error", (err: NodeJS.ErrnoException) => {
      const detail = err.code === "ENOENT"
        ? `command not found: ${JSON.stringify(args.argv[0])}`
        : err.message;
      settle({ ok: false, errorMessage: detail });
    });

    child.on("close", (code, signal) => {
      if (costCapped) {
        settle({
          ok: false,
          errorMessage:
            `cost cap exceeded: $${costCappedTotal.toFixed(2)} spent, cap $${args.maxCostUsd.toFixed(2)} ` +
            `(eval.limits.maxCostUsd raises it)`,
        });
      } else if (timedOut) {
        settle({
          ok: false,
          errorMessage:
            `wall clock limit exceeded (${args.limits.wallClock}ms; eval.limits.wallClockSec raises it). ` +
            `If the command waits for input it can never receive, this is the likely cause — ` +
            `it must run one-shot (e.g. agency agent -p) with a headless policy`,
        });
      } else if (code === 0) {
        settle({ ok: true });
      } else {
        const tail = stderrTail.trim() === "" ? "" : `\nstderr tail:\n${stderrTail.trim()}`;
        settle({
          ok: false,
          errorMessage: `command exited with code ${code}${signal ? ` signal ${signal}` : ""}${tail}`,
        });
      }
    });
  });
}
