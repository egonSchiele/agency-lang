// What `agency agent`'s shell run calls to run its session. The process
// holds one session (`agentTerminalSession.ts`), a run of the session
// program, and the shell run draws the prompt and runs the slash commands.
// Every function here is called from Agency code. See
// docs/dev/agents/session-driver.md, "The terminal".
import * as sessionProgram from "agency-lang/agent-session";
import { currentRun, type Run } from "../runtime/asyncContext.js";
import { __call } from "../runtime/call.js";
import type { Interrupt, InterruptResponse } from "../runtime/interrupts.js";
import type { RunUsage } from "../runtime/invocationUsage.js";
import type { Policy } from "../runtime/policy.js";
import {
  _readTranscript,
  _recordRunFormat,
  _listSessions,
  checkpointIn,
  readSavedRun,
  reportHerdrSession,
  type SessionRecord,
  type TranscriptMessage,
} from "./agentSessions.js";
import {
  pauseData,
  thisProcessId,
  type AgentModule,
  type Answer,
  type PauseData,
  type ProgramStart,
} from "./agentDriver/index.js";
import { sessionJobs, stopSessionJob, type SessionJobStop } from "./agentDriver/jobControl.js";
import {
  terminalSession,
  type ShownLine,
  type TerminalSession,
  type TerminalShell,
} from "./agentTerminalSession.js";
import { setReplJobsSource } from "./cliJobLine.js";
import type { TokenSnapshot } from "./cliTokens.js";
import type { JobSummaryForAgency } from "./jobs.js";

/** The shell run's Agency functions the session calls back. `forked` is
 *  left out where nothing follows a fork, as in a one-shot run. */
type ShellFunctions = { ask: unknown; policy: unknown; show: unknown; forked?: unknown };

type Current = { session: TerminalSession; functions: ShellFunctions };

// The process's one session. Set by `_startSession` or `_resumeSession`.
let current: Current | null = null;

function callAgency(run: Run, fn: unknown, ...args: unknown[]): Promise<unknown> {
  return __call(run, fn, { type: "positional", args });
}

/** The shell, for calls made under `run`, the shell run's call in progress. */
function shellFor(run: Run, functions: ShellFunctions): TerminalShell {
  return {
    ask: async (interrupt: Interrupt) =>
      (await callAgency(run, functions.ask, interrupt)) as InterruptResponse,
    policy: async () => ((await callAgency(run, functions.policy)) ?? {}) as Policy,
    show: async (line: ShownLine) => {
      await callAgency(run, functions.show, line.kind, line.text);
    },
    forked: async (from: string, to: string) => {
      if (functions.forked != null) {
        await callAgency(run, functions.forked, from, to);
      }
    },
  };
}

function agentFor(start: ProgramStart | null): AgentModule {
  return {
    main: (opts) => sessionProgram.main(start, opts),
    respondToInterrupts: (interrupts, responses, opts) =>
      sessionProgram.respondToInterrupts(interrupts, responses, opts),
  };
}

function openSession(args: {
  run: Run;
  start: ProgramStart | null;
  dir: string;
  home: string;
  functions: ShellFunctions;
}): TerminalSession {
  const session = terminalSession({
    agent: agentFor(args.start),
    dir: args.dir,
    home: args.home,
    holder: { frontEnd: "terminal", pid: process.pid, processId: thisProcessId() },
    host: args.run.ctx.host,
    onSaved: reportHerdrSession,
  });
  current = { session, functions: args.functions };
  setReplJobsSource(() => current?.session.heldJobs() ?? []);
  return session;
}

/** Starts a new session. `dir` is the sessions folder for this directory,
 *  `home` the agent home. "" or why it could not start. */
export async function _startSession(
  start: ProgramStart,
  dir: string,
  home: string,
  functions: ShellFunctions,
): Promise<string> {
  const run = currentRun();
  const session = openSession({ run, start, dir, home, functions });
  return session.start(shellFor(run, functions));
}

/** Goes on with saved session `id`. "" or why it can't. */
export async function _resumeSession(
  dir: string,
  home: string,
  id: string,
  functions: ShellFunctions,
): Promise<string> {
  const run = currentRun();
  const session = openSession({ run, start: null, dir, home, functions });
  return session.resume(id, shellFor(run, functions));
}

/** What a one-shot run gives back: its reply, and its errors. */
export type OneShotOutcome = { reply: string; error: string };

/** `agency agent -p`: starts a session that saves nothing (`start` has
 *  no record and `oneShot: true`), sends `message`, and runs it to its
 *  end. `ask` and `policy` are the shell run's, under a non-interactive
 *  policy handler, so what no rule decides is declined with the reason
 *  `std::policy` gives a run with no one to ask. Nothing is printed: the
 *  reply and the errors are returned. */
export async function _runOnce(
  start: ProgramStart,
  message: Answer,
  functions: { ask: unknown; policy: unknown },
): Promise<OneShotOutcome> {
  const run = currentRun();
  const replies: string[] = [];
  const errors: string[] = [];
  const shell: TerminalShell = {
    ...shellFor(run, { ...functions, show: null }),
    show: async (line) => {
      if (line.kind === "reply") {
        replies.push(line.text);
      } else if (line.kind === "error") {
        errors.push(line.text);
      }
    },
  };
  const session = openSession({
    run,
    start,
    dir: "",
    home: "",
    functions: { ...functions, show: null },
  });
  const problem = await session.start(shell);
  if (problem !== "") {
    return { reply: "", error: problem };
  }
  await session.send(message, shell, run.ctx.abortController.signal);
  return { reply: replies.at(-1) ?? "", error: errors.join("\n") };
}

/** Sends an answer and runs the session until it waits for a message
 *  again. Esc while the model works cancels the shell run's call, and that
 *  aborts the leg. */
export async function _send(answer: Answer): Promise<void> {
  const run = currentRun();
  if (current === null) {
    throw new Error("_send was called before _startSession or _resumeSession.");
  }
  const signal = run.ctx.abortController.signal;
  await current.session.send(answer, shellFor(run, current.functions), signal);
}

export function _pause(): PauseData | null {
  return current?.session.pause() ?? null;
}

/** Why the session can't go on, or "" while it can. */
export function _endedBecause(): string {
  return current?.session.endedBecause() ?? "";
}

function usageNow(): RunUsage | null {
  return current?.session.usage() ?? null;
}

/** The session's tokens so far, for the footer. */
export function _footerTokens(): TokenSnapshot {
  const usage = usageNow();
  if (usage === null) {
    return { inputTokens: 0, outputTokens: 0, models: {} };
  }
  const tokens = usage.tokens;
  const models: TokenSnapshot["models"] = {};
  for (const entry of usage.entries) {
    if (entry.model !== "") {
      models[entry.model] = { tokens: entry.tokens.totalTokens, cost: entry.cost.totalCost };
    }
  }
  return {
    inputTokens: tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheCreationInputTokens,
    outputTokens: tokens.outputTokens,
    models,
  };
}

/** The session's spend so far, in US dollars. */
export function _cost(): number {
  return usageNow()?.cost.totalCost ?? 0;
}

/** One row per kind and model, for `/cost`, in getModelCosts()'s shape. */
export function _costRows(): {
  kind: string;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}[] {
  const entries = usageNow()?.entries ?? [];
  return entries
    .map((entry) => ({
      kind: entry.kind,
      model: entry.model,
      cost: entry.cost.totalCost,
      inputTokens: entry.tokens.inputTokens,
      outputTokens: entry.tokens.outputTokens,
      cachedInputTokens: entry.tokens.cachedInputTokens,
      cacheCreationInputTokens: entry.tokens.cacheCreationInputTokens,
    }))
    .sort((left, right) => right.cost - left.cost);
}

/** The session's jobs, as `/jobs` lists them. Runs no leg. */
export async function _sessionJobs(): Promise<JobSummaryForAgency[]> {
  const run = currentRun();
  return sessionJobs(run.ctx.host, current?.session.heldJobs() ?? []);
}

/** Stops one of the session's jobs, as `/jobs stop <id>` asks. Runs no
 *  leg. */
export async function _stopSessionJob(id: string): Promise<SessionJobStop> {
  const run = currentRun();
  return stopSessionJob({ host: run.ctx.host, jobs: current?.session.heldJobs() ?? [], id });
}

/** The sessions saved in `dir` that the terminal can go on with, most
 *  recently saved first: those whose file is a saved run. */
export async function _savedSessions(dir: string): Promise<SessionRecord[]> {
  const all = await _listSessions(dir);
  return all.filter((record) => _recordRunFormat(record) === "savedRun");
}

/** The conversation saved for session `id`, to show before it goes on. */
export async function _savedTranscript(dir: string, id: string): Promise<TranscriptMessage[]> {
  const run = await readSavedRun(dir, id);
  if (run === null) {
    return [];
  }
  const thread = pauseData(run.pause)?.thread ?? "";
  return _readTranscript(checkpointIn(run), thread);
}
