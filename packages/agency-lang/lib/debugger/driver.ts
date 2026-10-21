import * as fs from "fs";
import * as path from "path";
import { DebuggerState } from "./debuggerState.js";
import type { Interrupt } from "../runtime/interrupts.js";
import type { AgencyCallbacks } from "../runtime/hooks.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { CheckpointStore } from "../runtime/state/checkpointStore.js";
import { isDebugger, isInterrupt, hasInterrupts } from "../runtime/interrupts.js";
import { isDebugStop, type DebugStopData } from "../runtime/debugger.js";
import { describeGuardTrip, draftNote, isGuardTrip } from "./guardAnswer.js";
import { DebuggerDetached, type DebuggerCommand, type DebuggerIO } from "./types.js";
import { composeCallbacks } from "../runtime/hooks.js";
import type { RunUsage, ServedInvocationOutcome } from "../runtime/invocationUsage.js";
import { isPaused } from "../runtime/pause.js";
import { ATTACHED_AGENT_END } from "../runtime/agentEnd.js";
import {
  ATTACHED_RESUME,
  type AttachFunctions,
  type AttachedRunResult,
  type LegOptions,
} from "../runtime/attachedDebugger.js";
import type { FunctionParameter } from "../types.js";
import type { TraceHeader } from "../runtime/trace/types.js";

import type { InterruptResponse } from "../runtime/interrupts.js";
import type { InvocationOptions } from "../runtime/invocationOptions.js";
import { color } from "@/utils/termcolors.js";
import { round } from "@/utils.js";

/** The four functions a driver drives a program through: a compiled
 *  module exports them bound to its `__globalCtx`, and the runtime binds
 *  them to a context for the attach server (`attachFunctionsFor`). */
export type ModuleFunctions = AttachFunctions;

/** One attached run's visit to the driver: what its leg was started
 *  with, which every resume and rewind passes back, and the usage of the
 *  last leg the driver ran for it. Carried with the call rather than kept
 *  on the driver, because runs interleave: the driver holds the UI only
 *  while it waits for the person, and lets go while a leg runs. */
type AttachedSession = {
  leg: LegOptions;
  usage?: RunUsage;
};

/** A leg the debugger resumed threw; `runAttached` hands the outcome
 *  back to the caller instead of the value. */
class AttachedLegThrew extends Error {
  constructor(readonly outcome: ServedInvocationOutcome<any> & { status: "threw" }) {
    super("a leg the debugger resumed threw");
  }
}

type DriverOpts = {
  mod: ModuleFunctions;
  rewindSize: number;
  ui: DebuggerIO;
  checkpoints?: Checkpoint[];
  traceHeader?: TraceHeader;
  /** The policy and budget the debugged run is started with. The driver
   *  adds the `input()` routing; `driver.invocation` is the result, which
   *  the node call spreads (the generated node function takes its options
   *  flat) and every resume and rewind takes whole. */
  invocation?: InvocationOptions;
  /** The driver is installed on a program something else is running
   *  (`attach`). It then answers only debug stops, hands the program's
   *  own interrupts and the final value back to whoever is running it,
   *  resumes with that caller's options, and leaves the terminal alone. */
  attached?: boolean;
};

type DriverRunOpts = Partial<{
  interceptConsole: boolean;
}>;

export class DebuggerDriver {
  private mod: ModuleFunctions;
  private ui: DebuggerIO;
  /** The invocation the debugged run is called with, and every resume
   *  and rewind: the policy and budget from the run flags, and `input()`
   *  routed to the UI's text field. */
  readonly invocation: InvocationOptions;
  debuggerState: DebuggerState;
  private originalConsoleLog: typeof console.log;
  private originalConsoleError: typeof console.error;
  private programFinished = false;
  /** What `set` has queued for the next resume. The UI shows a copy
   *  beside the current values; the driver owns it. */
  private pendingOverrides: Record<string, unknown> = {};
  private readonly attached: boolean;
  /** Attached: the runs whose steps were let through because another
   *  run owns the debugger, each told once in the activity log. */
  private ignoredRuns: string[] = [];
  /** The `waitForCommand` in progress, kept when a stop is answered some
   *  other way (a detach, the caller's cancel), so the next stop takes
   *  the key the person then presses rather than asking twice. */
  private commandInFlight: Promise<DebuggerCommand> | null = null;
  private detachRequested = false;
  private detachWaiters: (() => void)[] = [];

  constructor(opts: DriverOpts) {
    this.mod = opts.mod;
    this.ui = opts.ui;
    this.attached = opts.attached === true;
    // Attached, a question goes to the run's own terminal, not the UI.
    this.invocation = this.attached
      ? { ...opts.invocation }
      : {
          ...opts.invocation,
          inputOverride: (prompt: string) => this.ui.promptForInput(prompt),
        };
    this.debuggerState = new DebuggerState(opts.rewindSize);
    this.originalConsoleLog = console.log;
    this.originalConsoleError = console.error;

    if (opts.checkpoints?.length) {
      this.debuggerState.loadCheckpoints(opts.checkpoints);
      this.programFinished = true;
    }

    if (opts.traceHeader) {
      const h = opts.traceHeader;
      const date = new Date(h.timestamp);
      const formattedDate = date.toLocaleString();
      this.ui.log(
        `Trace: ${h.program} | ${formattedDate} | Agency v${h.agencyVersion} | ${opts.checkpoints?.length ?? 0} checkpoints`,
      );
    }
  }

  async promptForNodeArgs(parameters: FunctionParameter[]): Promise<unknown[]> {
    return await this.ui.promptForNodeArgs(parameters);
  }

  /** Install this driver on the module's running program. The runtime
   *  finds it through the state it installs, so nothing else is told. */
  attach(): void {
    if (!this.attached) {
      throw new Error("attach needs a driver built with attached: true");
    }
    this.detachRequested = false;
    this.debuggerState.ownedRun = null;
    this.debuggerState.attached = {
      run: (result, leg) => this.runAttached(result, leg),
      finished: (result) => this.finishedAttached(result),
      ignoring: (runKey) => {
        if (this.ignoredRuns.includes(runKey)) {
          return;
        }
        this.ignoredRuns.push(runKey);
        this.ui.log("Another run started while this one is debugged; it runs without stopping");
      },
    };
    this.mod.__setDebugger(this.debuggerState);
  }

  /** Remove this driver from the program. A stop the driver is waiting
   *  at is answered with `continue`; with nothing pending the next step
   *  costs nothing again. */
  detach(): void {
    this.detachRequested = true;
    for (const wake of this.detachWaiters) {
      wake();
    }
    this.detachWaiters = [];
    this.debuggerState.ownedRun = null;
    delete this.debuggerState.attached;
    // Another debugger may have been installed since; only this one is
    // removed. A module compiled before `__getDebugger` existed cannot
    // say, and is cleared.
    const installed = this.mod.__getDebugger?.();
    if (installed === undefined || installed === this.debuggerState) {
      this.mod.__setDebugger(null);
    }
  }

  private async runAttached(result: any, leg: LegOptions): Promise<AttachedRunResult> {
    const session: AttachedSession = { leg };
    try {
      const final = await this.run(result, { interceptConsole: false }, session);
      return { result: final, usage: session.usage };
    } catch (error) {
      if (error instanceof AttachedLegThrew) {
        return { threw: error.outcome.error, usage: error.outcome.usage };
      }
      throw error;
    }
  }

  /** The program finished in a leg the caller ran: a line in the log and
   *  a render that does not wait. The next run to stop is debugged next. */
  private async finishedAttached(result: any): Promise<void> {
    this.ui.log(`Program finished. Return value: ${JSON.stringify(result?.data ?? undefined)}`);
    this.renderInBackground();
  }

  /** A call on the UI. Attached, the UI reporting the other side gone is
   *  a detach, and the call has no answer; any other failure is the
   *  caller's. */
  private async uiCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      if (this.attached && error instanceof DebuggerDetached) {
        this.detach();
        return undefined;
      }
      throw error;
    }
  }

  /** A render from a callback, which the program does not wait for. */
  private renderInBackground(): void {
    void this.uiCall(() => this.ui.render());
  }

  /** Whether the driver has been detached from the program it was on,
   *  so its callbacks, still composed into the leg that was running, do
   *  nothing more. */
  private detachedNow(): boolean {
    return this.attached && this.detachRequested;
  }

  /** Show the stop and take the person's command. Attached, the answer
   *  is `continue` when the driver is detached meanwhile, when the IO
   *  reports the other side gone, or when the caller cancels the run: the
   *  resume then lands the cancel the usual way. */
  private async attendStop(
    render: () => Promise<void>,
    session: AttachedSession | undefined,
  ): Promise<DebuggerCommand> {
    if (session === undefined) {
      await render();
      return await this.ui.waitForCommand();
    }
    const signal = session.leg.abortSignal;
    if (this.detachRequested || signal?.aborted) {
      return { type: "continue" };
    }
    await this.uiCall(render);
    return await this.nextCommand(signal);
  }

  private async nextCommand(abortSignal: AbortSignal | undefined): Promise<DebuggerCommand> {
    if (this.detachRequested) {
      return { type: "continue" };
    }
    const detached = new Promise<DebuggerCommand>((resolve) => {
      this.detachWaiters.push(() => resolve({ type: "continue" }));
    });
    const cancelled = aborted(abortSignal).then((): DebuggerCommand => ({ type: "continue" }));
    const command = await this.uiCall(() =>
      Promise.race([this.takeCommand(), detached, cancelled]),
    );
    return command ?? { type: "continue" };
  }

  private takeCommand(): Promise<DebuggerCommand> {
    if (this.commandInFlight === null) {
      this.commandInFlight = this.ui.waitForCommand().finally(() => {
        this.commandInFlight = null;
      });
    }
    return this.commandInFlight;
  }

  /** The options every resume and rewind carries. Attached, they are the
   *  caller's own, with the driver's hooks added to the caller's and the
   *  key that marks the call as the debugger's; the state itself reaches
   *  the new leg through the slot the module shares. */
  private resumeOptions(session: AttachedSession | undefined): {
    invocation?: InvocationOptions;
    metadata: Record<string, unknown>;
    abortSignal?: AbortSignal;
    pauseSignal?: AbortSignal;
  } {
    if (session !== undefined) {
      const leg = session.leg;
      return {
        invocation: leg.invocation,
        abortSignal: leg.abortSignal,
        pauseSignal: leg.pauseSignal,
        metadata: {
          callbacks: composeCallbacks(leg.callbacks, this.getCallbacks()),
          [ATTACHED_RESUME]: true,
          [ATTACHED_AGENT_END]: leg.agentEnd === true,
        },
      };
    }
    return {
      invocation: this.invocation,
      metadata: { callbacks: this.getCallbacks() },
    };
  }

  private interceptConsole(): void {
    console.log = (...args: any[]) => {
      const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      this.ui.appendStdout(text);
    };
    console.error = (...args: any[]) => {
      const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      this.ui.appendStdout(text);
    };
  }

  private restoreConsole(): void {
    console.log = this.originalConsoleLog;
    console.error = this.originalConsoleError;
  }

  getCallbacks(): AgencyCallbacks {
    return {
      // The call stack pane reads the checkpoint's frames, so no function
      // hook is needed.
      onNodeStart: (data) => {
        // gets triggered on every statement, as debugger resumes node execution.
        // this.ui.log(`-> node: ${data.nodeName}`);
      },
      onNodeEnd: (data) => {
        if (this.detachedNow()) {
          return;
        }
        this.ui.log(`<- node: ${data.nodeName}`);
        this.renderInBackground();
      },
      onLLMCallStart: (data) => {
        if (this.detachedNow()) {
          return;
        }
        const model = typeof data.model === "string" ? data.model : "unknown";
        this.ui.log(`Calling LLM: ${model}...`);
        this.renderInBackground();
      },
      onLLMCallEnd: (data) => {
        if (this.detachedNow()) {
          return;
        }
        const tokens = data.usage ? `${data.usage.totalTokens} tokens` : "unknown tokens";
        const time = `${round(data.timeTaken)}ms`;
        this.ui.log(`LLM returned (${tokens}, ${time})`);
        this.renderInBackground();
      },
      onToolCallStart: (data) => {
        if (this.detachedNow()) {
          return;
        }
        this.ui.log(
          `Tool call: ${data.toolName}(${Object.entries(data.args)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join(", ")})`,
        );
        this.renderInBackground();
      },
      onToolCallEnd: (data) => {
        if (this.detachedNow()) {
          return;
        }
        this.ui.log(`Tool done: ${data.toolName} (${round(data.timeTaken)}ms)`);
        this.renderInBackground();
      },
    };
  }

  async run(
    initialResult: any,
    _opts: DriverRunOpts = {},
    session: AttachedSession | undefined = undefined,
  ): Promise<any> {
    let result = initialResult;
    const defaultOpts = { interceptConsole: true };
    const opts = { ...defaultOpts, ..._opts };
    if (opts.interceptConsole) {
      this.interceptConsole();
    }
    try {
      // runNode returns { messages, data, tokens } — interrupts are in .data
      let lastCommand: DebuggerCommand | null = null;
      // The batch the program paused with: one interrupt, or several when
      // concurrent branches (parallel tool calls, a fork, a parallel
      // block) paused at once. A resume answers the whole batch.
      let batch: Interrupt[] = [];
      let shown: Interrupt | undefined;
      let finalResult: any = undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (hasInterrupts(result?.data)) {
          batch = result.data;
        } else if (isInterrupt(result?.data)) {
          // A command that did not move the program (print, checkpoint, a
          // cancelled rewind) hands back the interrupt it was given; the
          // batch it belongs to stays.
          if (result.data !== shown) batch = [result.data];
        } else {
          // Attached, the caller's pause signal fired: the paused
          // checkpoint is the caller's, and the program has not ended.
          if (this.attached && isPaused(result?.data)) {
            return result;
          }
          if (batch.length === 0) {
            throw new Error(
              "Program finished without any interrupts. This shouldn't happen with the debugger enabled.",
            );
          }
          this.ui.log(
            `Program finished. Return value: ${JSON.stringify(result?.data ?? undefined)}`,
          );
          // Attached, the value belongs to whoever is running the program,
          // and the end of one run is not the end of the program: another
          // run of the same module may stop next.
          if (this.attached) {
            this.renderInBackground();
            return result;
          }
          this.programFinished = true;
          finalResult = result;
          // When the program finishes, keep the last batch so the user can
          // keep interacting (step back, rewind, print, etc.)
        }
        // Attached, the program's own interrupts are the caller's to
        // answer. The stops in the batch are dropped (`settleStops`), so
        // the person is told the breakpoint went by.
        if (this.attached && batch.some((intr) => !isDebugger(intr))) {
          for (const stop of batch.filter((intr) => isDebugger(intr))) {
            this.ui.log(
              `Passed the stop ${describeStop(stop)} while the program waits on its own interrupt`,
            );
          }
          return result;
        }
        // The interrupt shown: the first that asks the person something,
        // else the first debug stop.
        const asked: Interrupt[] = this.programFinished
          ? []
          : batch.filter((intr) => !isDebugger(intr));
        const interrupt: Interrupt = asked[0] ?? batch[0];
        shown = interrupt;
        // After the program finishes, even a restored user interrupt is no
        // longer a live request for input — the response has already been
        // delivered. Fall through to the debug-command branch so the user
        // can step back, quit, or inspect state instead of being re-prompted
        // in an infinite loop.
        if (asked.length === 0) {
          // Debug pause — show state and accept stepping commands
          this.ui.setMode(this.debuggerState.getMode());
          // Only pass checkpoint when execution has moved to a new position.
          // Non-stepping commands (set, print, checkpoint) stay at the same
          // position, so we re-render without a new checkpoint.
          const nonSteppingCommands = ["set", "checkpoint"];
          const skipCheckpoint = lastCommand && nonSteppingCommands.includes(lastCommand.type);
          // The stepping commands work from the depth of the stop that is
          // shown. Several branches can stop in one round, so the runtime
          // does not record a depth; the stop record carries it.
          const stop = stopOf(interrupt);
          if (stop) this.debuggerState.stoppedAt(stop.depth);
          // A stop of the tool loop's own has no source line, so the
          // activity log says where the loop is.
          if (!skipCheckpoint && stop?.loopStop !== undefined) {
            this.ui.log(`Stopped before ${stop.label}`);
          }
          // Several branches stopped at once: one is shown, and the next
          // command moves all of them.
          if (!skipCheckpoint && !this.programFinished && batch.length > 1) {
            const others = batch.slice(1).map((intr) => stopOf(intr)?.scopeName ?? "a branch");
            this.ui.log(`Also stopped in ${others.join(", ")}; the next command moves all`);
          }
          const command = await this.attendStop(
            () => this.ui.render(skipCheckpoint ? undefined : interrupt.checkpoint, stop),
            session,
          );
          lastCommand = command;
          // No broad try/catch: per-command handlers narrow their own catches
          // (e.g. :save / :load handle file errors and log them via
          // ui.log). Anything that escapes is an internal bug that
          // should crash the driver, not silently continue with stale state.
          result = await this.handleCommand(command, interrupt, batch, session);
          if (result && result.__debuggerQuit) {
            return finalResult;
          }
        } else {
          // User code interrupts: ask about each in turn (`askAbout`
          // renders for each), then answer the batch at once.
          this.ui.setMode(this.debuggerState.getMode());
          result = await this.handleInterrupts(batch, asked, session);
        }
      }
    } finally {
      this.restoreConsole();
      // Attached, the UI outlives this call: the program goes on and the
      // next stop comes back here.
      if (!this.attached) {
        this.ui.destroy();
      }
    }
  }

  /** Ask the person about each interrupt in `asked`, in order, and resume
   *  with one answer per interrupt of `batch`. A debug stop in the same
   *  batch is answered with an approve, which the resume never reads. */
  private async handleInterrupts(
    batch: Interrupt[],
    asked: Interrupt[],
    session: AttachedSession | undefined,
  ): Promise<any> {
    const answers: Record<string, InterruptResponse> = {};
    for (const [index, interrupt] of asked.entries()) {
      const position = asked.length > 1 ? ` (${index + 1} of ${asked.length})` : "";
      answers[interrupt.interruptId] = await this.askAbout(interrupt, position);
    }
    return await this.respond(batch, answers, undefined, session);
  }

  /** One interrupt's answer, asked for until the input is one of
   *  approve, reject, or resolve with a value. A guard trip takes a
   *  grant, a disarm, a message, or a reject instead; a raise that
   *  expects a value, such as a `question`, takes the typed text. */
  private async askAbout(interrupt: Interrupt, position: string): Promise<InterruptResponse> {
    // The batch shares one checkpoint; the panes follow the interrupt
    // being asked about, so they name the tool that raised it.
    await this.ui.render(interrupt.checkpoint, undefined, interrupt.interruptId);
    if (isGuardTrip(interrupt.effect, interrupt.data)) {
      return await this.askAboutGuardTrip(interrupt, position);
    }
    if (interrupt.expectsValue) {
      return await this.askForValue(interrupt, position);
    }
    const data =
      Object.keys(interrupt.data ?? {}).length > 0 ? ` ${JSON.stringify(interrupt.data)}` : "";
    this.ui.log(`Interrupt${position}: ${interrupt.message}${data}`);
    while (true) {
      // The label shares one row with the typed answer, so it stays
      // short; the message is in the activity log.
      const input = await this.ui.promptForInput(
        `interrupt${position}: approve / reject / resolve <value>`,
      );
      const trimmed = input.trim();
      if (trimmed === "approve" || trimmed === "a" || trimmed === "") {
        this.ui.log("Approved interrupt");
        return { type: "approve" };
      }
      if (trimmed === "reject" || trimmed === "r") {
        this.ui.log("Rejected interrupt");
        return { type: "reject" };
      }
      if (trimmed.startsWith("resolve ")) {
        const value = jsonOrText(trimmed.slice("resolve ".length));
        this.ui.log(`Resolved interrupt with: ${JSON.stringify(value)}`);
        return { type: "approve", value } as InterruptResponse;
      }
      this.ui.log(`Unknown response: "${trimmed}". Try: approve, reject, resolve <value>`);
    }
  }

  /** The answer to a raise used as a value (`const x = raise ...`, or
   *  `question` from `std::agent`): the typed text, as a string, the way
   *  the CLI's approval prompt takes it. `resolve <json>` gives a JSON
   *  value when the rest parses as JSON, so a number or a list can be
   *  given while an answer that happens to start with the word stays
   *  whole; `reject` rejects, and a bare `approve` resolves the variable
   *  to `true`. */
  private async askForValue(interrupt: Interrupt, position: string): Promise<InterruptResponse> {
    this.ui.log(`Question${position}: ${interrupt.message}${dataBeyondMessage(interrupt)}`);
    while (true) {
      const input = await this.ui.promptForInput(`answer${position}:`);
      const trimmed = input.trim();
      if (trimmed === "") {
        this.ui.log("Type the answer, or reject");
        continue;
      }
      if (trimmed === "approve" || trimmed === "a") {
        this.ui.log("Approved the question with no answer");
        return { type: "approve" };
      }
      if (trimmed === "reject" || trimmed === "r") {
        this.ui.log("Rejected the question");
        return { type: "reject" };
      }
      const value = resolvedJson(trimmed) ?? trimmed;
      this.ui.log(`Answered: ${JSON.stringify(value)}`);
      return { type: "approve", value } as InterruptResponse;
    }
  }

  /** A guard trip's answer comes from the form (`showGuardTripForm`),
   *  which only offers answers the runtime accepts. */
  private async askAboutGuardTrip(
    interrupt: Interrupt,
    position: string,
  ): Promise<InterruptResponse> {
    this.ui.log(`${describeGuardTrip(interrupt.data)}${position}`);
    this.ui.log(draftNote(interrupt.data));
    const response = await this.ui.answerGuardTrip(interrupt.data);
    this.ui.log(
      response.type === "reject"
        ? "Rejected the guard trip"
        : `Approved the guard trip with ${JSON.stringify((response as { value?: unknown }).value)}`,
    );
    return response;
  }

  /** Resume the program with one response per interrupt of `batch`, in
   *  the batch's order: the answer given for it, else an approve. The
   *  runtime insists on a response for every interrupt in the batch. */
  private async respond(
    batch: Interrupt[],
    answers: Record<string, InterruptResponse>,
    overrides: Record<string, unknown> | undefined,
    session: AttachedSession | undefined,
  ): Promise<any> {
    const responses = batch.map((intr) => answers[intr.interruptId] ?? { type: "approve" });
    const options = { overrides, ...this.resumeOptions(session) };
    const serve = this.mod.respondToInterruptsForServe;
    if (session !== undefined && serve !== undefined) {
      return await this.resumeInterrupt(async () => {
        const outcome = await serve(batch, responses, options);
        if (outcome.status === "threw") {
          throw new AttachedLegThrew(outcome);
        }
        return { ...outcome.value, usage: outcome.usage, traceId: outcome.traceId };
      }, session);
    }
    return await this.resumeInterrupt(
      () => this.mod.respondToInterrupts(batch, responses, options),
      session,
    );
  }

  // eslint-disable-next-line max-lines-per-function -- large command dispatcher; refactor tracked separately
  private async handleCommand(
    command: DebuggerCommand,
    interrupt: Interrupt,
    batch: Interrupt[],
    session: AttachedSession | undefined,
  ): Promise<any> {
    const forwardCommands = ["step", "stepIn", "next", "stepOut", "continue"];
    if (this.programFinished && forwardCommands.includes(command.type)) {
      this.ui.log("Already at end of execution.");
      return { data: interrupt };
    }
    switch (command.type) {
      case "step": {
        this.debuggerState.stepping();
        return await this.resume(batch, session);
      }
      case "stepIn": {
        this.debuggerState.stepIn();
        return await this.resume(batch, session);
      }
      case "next": {
        this.debuggerState.stepNext();
        return await this.resume(batch, session);
      }
      case "stepOut": {
        this.debuggerState.stepOut();
        return await this.resume(batch, session);
      }
      case "continue": {
        this.debuggerState.running();
        return await this.resume(batch, session);
      }
      case "set": {
        // A resume applies overrides to the root's last frame
        // (applyLocalOverrides in resumeSetup.ts), so a stop on a branch
        // stack, inside a tool call, a fork, or a parallel block, cannot
        // take one yet.
        const stop = stopOf(interrupt);
        if (stop && stop.branchPath.length > 0) {
          this.ui.log("set inside a tool call, a fork, or a parallel block is not supported yet");
          return { data: interrupt };
        }
        // The frame shown at one of the loop's own stops is the caller's,
        // but the override would land on the loop's frame, the last one.
        if (stop?.loopStop !== undefined) {
          this.ui.log("set before a model request or a tool call is not supported yet");
          return { data: interrupt };
        }
        this.pendingOverrides[command.varName] = command.value;
        this.ui.setOverrides(this.pendingOverrides);
        this.ui.log(`Set ${command.varName} = ${JSON.stringify(command.value)}`);
        return { data: interrupt };
      }
      case "checkpoint": {
        // Use the rolling checkpoint (pre-advance step) rather than the
        // interrupt checkpoint (post-advance step). The interrupt checkpoint
        // has its step counter advanced so that resume skips past the
        // current debugStep, but for rewind we need the pre-advance state
        // so execution lands back on the same statement.
        const rollingCheckpoints = this.debuggerState.getCheckpoints();
        const lastCheckpoint = rollingCheckpoints.at(-1);
        if (lastCheckpoint) {
          //console.log(color.cyan(`Creating checkpoint at ${lastCheckpoint.location}`, JSON.stringify(lastCheckpoint, null, 2)));
          const checkpointId = this.debuggerState.cloneCheckpoint(lastCheckpoint);
          this.debuggerState.checkpoints.removeDebugFlagsFor(checkpointId);
          this.debuggerState.pinCheckpoint(checkpointId, command.label);
          this.ui.log(
            `Pinned checkpoint #${checkpointId}${command.label ? ` "${command.label}"` : ""}`,
          );
        }
        return { data: interrupt };
      }
      case "stepBack": {
        const cp = interrupt.checkpoint;
        if (!cp) {
          this.ui.log("No checkpoint on current interrupt");
          return { data: interrupt };
        }
        if (cp.id < 0) {
          this.ui.log("Current checkpoint is not valid for stepping back");
          return { data: interrupt };
        }

        const previous = this.debuggerState.findBefore(cp.id, stopOf(interrupt) ?? cp);

        if (!previous) {
          this.ui.log("Already at earliest checkpoint");
          return { data: interrupt };
        }
        return await this.rewindTo(
          previous,
          { preserveOverrides: command.preserveOverrides },
          session,
        );
      }
      case "rewind": {
        const allCheckpoints = this.checkpointsToShow();
        const selectedId = await this.uiCall(() => this.ui.showRewindSelector(allCheckpoints));
        if (selectedId === null || selectedId === undefined) {
          // User cancelled, or detached — stay where we are
          return { data: interrupt };
        }
        const checkpoint = allCheckpoints.find((c) => c.id === selectedId);
        if (!checkpoint) {
          this.ui.log(`Checkpoint #${selectedId} not found.`);
          return { data: interrupt };
        }

        return await this.rewindTo(checkpoint, {}, session);
      }
      case "reject": {
        this.ui.log("Rejected interrupt");
        return await this.respond(
          batch,
          { [interrupt.interruptId]: { type: "reject" } },
          undefined,
          session,
        );
      }
      case "resolve": {
        this.ui.log(`Resolved interrupt with: ${JSON.stringify(command.value)}`);
        return await this.respond(
          batch,
          {
            [interrupt.interruptId]: {
              type: "approve",
              value: command.value,
            } as InterruptResponse,
          },
          undefined,
          session,
        );
      }
      case "showCheckpoints": {
        const allCheckpoints = this.checkpointsToShow();
        await this.uiCall(() => this.ui.showCheckpointsPanel(allCheckpoints));
        return { data: interrupt };
      }
      case "save": {
        const rollingCheckpoints = this.debuggerState.getCheckpoints();
        const rolling = rollingCheckpoints.at(-1);
        if (!rolling) {
          this.ui.log("No checkpoint to save");
          return { data: interrupt };
        }
        const filePath = command.path.endsWith(".json") ? command.path : command.path + ".json";
        const absPath = path.resolve(filePath);
        try {
          fs.writeFileSync(absPath, JSON.stringify(rolling.toJSON(), null, 2));
          this.ui.log(`Saved checkpoint to ${absPath}`);
        } catch (e: any) {
          this.ui.log(`Failed to save: ${e.message}`);
        }
        return { data: interrupt };
      }
      case "load": {
        const filePath = command.path.endsWith(".json") ? command.path : command.path + ".json";
        const absPath = path.resolve(filePath);
        try {
          const raw = fs.readFileSync(absPath, "utf-8");
          const json = JSON.parse(raw);
          const checkpoint = Checkpoint.fromJSON(json);
          if (!checkpoint) {
            this.ui.log(`Invalid checkpoint data in file: ${JSON.stringify(json)}`);
            return { data: interrupt };
          }
          return await this.rewindTo(checkpoint, {}, session);
        } catch (e: any) {
          this.ui.log(`Failed to load: ${e.message}`);
          return { data: interrupt };
        }
      }
      case "quit": {
        // Attached, quitting is detaching: the program runs on without a
        // debugger, and the slot is cleared before the resume so the new
        // leg raises no stop.
        if (this.attached) {
          this.detach();
          this.debuggerState.running();
          return await this.resume(batch, session);
        }
        return { __debuggerQuit: true };
      }
    }
  }

  /** The checkpoints the rewind selector and the checkpoints panel show:
   *  the rolling window and the program's own pinned ones. */
  private checkpointsToShow(): Checkpoint[] {
    const debugCheckpoints = this.debuggerState.getCheckpoints();
    const userCheckpoints = this.mod.__getCheckpoints().getCheckpoints();
    return [...debugCheckpoints, ...userCheckpoints].sort((a, b) => a.id - b.id);
  }

  /** The queued overrides, cleared: a resume applies them once. */
  private takeOverrides(): Record<string, unknown> {
    const overrides = this.pendingOverrides;
    this.pendingOverrides = {};
    this.ui.setOverrides(this.pendingOverrides);
    return overrides;
  }

  private async resumeInterrupt(
    fn: () => Promise<any>,
    session: AttachedSession | undefined,
  ): Promise<any> {
    this.ui.startSpinner();
    try {
      const result = await fn();
      if (session !== undefined && result?.usage !== undefined) {
        session.usage = result.usage;
      }
      return result;
    } catch (error) {
      if (session !== undefined && error instanceof AttachedLegThrew) {
        session.usage = error.outcome.usage;
      }
      throw error;
    } finally {
      this.ui.stopSpinner();
    }
  }

  /** Move on from a debug stop: every stop in the batch is approved, an
   *  answer the resume never reads, and pending overrides are applied. */
  private async resume(batch: Interrupt[], session: AttachedSession | undefined): Promise<any> {
    const overrides = this.takeOverrides();
    return await this.respond(batch, {}, overrides, session);
  }

  private async rewindTo(
    checkpoint: Checkpoint,
    opts: { preserveOverrides?: boolean },
    session: AttachedSession | undefined,
  ): Promise<any> {
    // Reset state for replay
    this.programFinished = false;
    this.debuggerState.reset();
    this.ui.log(`Rewinding to checkpoint #${checkpoint.id}`);

    // For "time travel" (shift+up), keep overrides pending so they're
    // applied on the next step forward. Otherwise clear them.
    const overrides = opts.preserveOverrides ? this.pendingOverrides : this.takeOverrides();

    this.debuggerState.deleteAfterCheckpoint(checkpoint.id);

    const options = this.resumeOptions(session);
    return await this.resumeInterrupt(async () => {
      try {
        return await this.mod.rewindFrom(checkpoint, overrides, options);
      } catch (error) {
        // The module's rewind throws a failed leg's error. Attached, the
        // caller gets it as a thrown outcome, as from a resume; its usage
        // is the checkpoint's, which the replay started from, when the
        // rewind has none of its own to report.
        const usage = (checkpoint.usage as RunUsage | undefined) ?? session?.usage;
        if (session !== undefined && usage !== undefined) {
          throw new AttachedLegThrew({ status: "threw", error, usage, traceId: "" });
        }
        throw error;
      }
    }, session);
  }
}

/** Settles when `signal` aborts, at once for one that already has, and
 *  never without a signal. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return new Promise(() => {});
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/** Where a debug stop is, for the activity log: the scope, and the label
 *  a `debugger("...")` statement gave it. */
function describeStop(interrupt: Interrupt): string {
  const stop = stopOf(interrupt);
  if (!stop) {
    return "in a branch";
  }
  return stop.label ? `in ${stop.scopeName} ("${stop.label}")` : `in ${stop.scopeName}`;
}

/** `resolve <value>` takes JSON, so a number or a list can be given,
 *  and falls back to the text itself. */
function jsonOrText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/** The JSON value of an answer written `resolve <json>`, or undefined
 *  when the answer is not that: no `resolve` prefix, or a rest that is
 *  not JSON, such as "resolve the conflict by hand". */
function resolvedJson(answer: string): unknown {
  if (!answer.startsWith("resolve ")) return undefined;
  try {
    return JSON.parse(answer.slice("resolve ".length).trim());
  } catch {
    return undefined;
  }
}

/** The interrupt's data, for the log, when it says more than the
 *  message: a raise can carry what the person chooses from. A `question`
 *  carries only its prompt, which the message already is. */
function dataBeyondMessage(interrupt: Interrupt): string {
  const data = interrupt.data ?? {};
  const keys = Object.keys(data);
  if (keys.length === 0) return "";
  if (keys.length === 1 && keys[0] === "prompt" && data.prompt === interrupt.message) return "";
  return ` ${JSON.stringify(data)}`;
}

/** The stop a debug interrupt carries, or nothing for a user interrupt
 *  and for the placeholder interrupt a trace replay starts from. */
function stopOf(interrupt: Interrupt): DebugStopData | undefined {
  return isDebugStop(interrupt.data) ? interrupt.data : undefined;
}
