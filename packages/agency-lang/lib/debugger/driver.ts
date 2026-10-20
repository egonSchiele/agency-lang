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
import { emptyRunUsage, sumRunUsage, type RunUsage } from "../runtime/invocationUsage.js";
import {
  ATTACHED_RESUME,
  type AttachedRunResult,
  type LegOptions,
} from "../runtime/attachedDebugger.js";
import type { FunctionParameter } from "../types.js";
import type { TraceHeader } from "../runtime/trace/types.js";

import type { InterruptResponse } from "../runtime/interrupts.js";
import type { InvocationOptions } from "../runtime/invocationOptions.js";
import { color } from "@/utils/termcolors.js";
import { round } from "@/utils.js";

// Functions from the compiled module that are bound to __globalCtx
type ModuleFunctions = {
  respondToInterrupts: (
    interrupts: Interrupt[],
    responses: InterruptResponse[],
    opts?: {
      overrides?: Record<string, unknown>;
      metadata?: Record<string, any>;
      invocation?: InvocationOptions;
      abortSignal?: AbortSignal;
      pauseSignal?: AbortSignal;
    },
  ) => Promise<any>;
  rewindFrom: (
    checkpoint: Checkpoint,
    overrides: Record<string, unknown>,
    opts?: { metadata?: Record<string, any>; invocation?: InvocationOptions },
  ) => Promise<any>;
  __setDebugger: (dbg: DebuggerState | null) => void;
  __getCheckpoints: () => CheckpointStore;
};

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
  /** Attached: what the leg that stopped was started with; every resume
   *  and rewind passes it back. */
  private leg: LegOptions = {};
  /** Attached: the usage of the legs run since `runAttached` began. */
  private legUsage: RunUsage = emptyRunUsage();
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
    this.debuggerState.attached = {
      run: (result, leg) => this.runAttached(result, leg),
      finished: (result) => this.finishedAttached(result),
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
    delete this.debuggerState.attached;
    this.mod.__setDebugger(null);
  }

  private async runAttached(result: any, leg: LegOptions): Promise<AttachedRunResult> {
    this.leg = leg;
    this.legUsage = emptyRunUsage();
    const final = await this.run(result, { interceptConsole: false });
    return { result: final, usage: this.legUsage };
  }

  private async finishedAttached(result: any): Promise<void> {
    this.ui.log(`Program finished. Return value: ${JSON.stringify(result?.data ?? undefined)}`);
    this.programFinished = true;
    await this.ui.render();
  }

  /** The command the person gives, or `continue` when the driver is
   *  detached while waiting, or when the IO reports the other side gone. */
  private async nextCommand(): Promise<DebuggerCommand> {
    if (!this.attached) {
      return await this.ui.waitForCommand();
    }
    if (this.detachRequested) {
      return { type: "continue" };
    }
    const detached = new Promise<DebuggerCommand>((resolve) => {
      this.detachWaiters.push(() => resolve({ type: "continue" }));
    });
    try {
      return await Promise.race([this.ui.waitForCommand(), detached]);
    } catch (error) {
      if (error instanceof DebuggerDetached) {
        this.detach();
        return { type: "continue" };
      }
      throw error;
    }
  }

  /** The options every resume and rewind carries. Attached, they are the
   *  caller's own, with the driver's hooks added to the caller's and the
   *  key that marks the call as the debugger's; the state itself reaches
   *  the new leg through the slot the module shares. */
  private resumeOptions(): {
    invocation?: InvocationOptions;
    metadata: Record<string, unknown>;
    abortSignal?: AbortSignal;
    pauseSignal?: AbortSignal;
  } {
    if (this.attached) {
      return {
        invocation: this.leg.invocation,
        abortSignal: this.leg.abortSignal,
        pauseSignal: this.leg.pauseSignal,
        metadata: {
          callbacks: composeCallbacks(this.leg.callbacks, this.getCallbacks()),
          [ATTACHED_RESUME]: true,
        },
      };
    }
    return {
      invocation: this.invocation,
      metadata: { callbacks: this.getCallbacks(), debugger: this.debuggerState },
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
        this.ui.log(`<- node: ${data.nodeName}`);
        this.ui.render();
      },
      onLLMCallStart: (data) => {
        const model = typeof data.model === "string" ? data.model : "unknown";
        this.ui.log(`Calling LLM: ${model}...`);
        this.ui.render();
      },
      onLLMCallEnd: (data) => {
        const tokens = data.usage ? `${data.usage.totalTokens} tokens` : "unknown tokens";
        const time = `${round(data.timeTaken)}ms`;
        this.ui.log(`LLM returned (${tokens}, ${time})`);
        this.ui.render();
      },
      onToolCallStart: (data) => {
        this.ui.log(
          `Tool call: ${data.toolName}(${Object.entries(data.args)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join(", ")})`,
        );
        this.ui.render();
      },
      onToolCallEnd: (data) => {
        this.ui.log(`Tool done: ${data.toolName} (${round(data.timeTaken)}ms)`);
        this.ui.render();
      },
    };
  }

  async run(initialResult: any, _opts: DriverRunOpts = {}): Promise<any> {
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
          if (batch.length === 0) {
            throw new Error(
              "Program finished without any interrupts. This shouldn't happen with the debugger enabled.",
            );
          }
          this.ui.log(
            `Program finished. Return value: ${JSON.stringify(result?.data ?? undefined)}`,
          );
          this.programFinished = true;
          finalResult = result;
          // Attached, the value belongs to whoever is running the program.
          if (this.attached) {
            await this.ui.render();
            return result;
          }
          // When the program finishes, keep the last batch so the user can
          // keep interacting (step back, rewind, print, etc.)
        }
        // Attached, the program's own interrupts are the caller's to
        // answer; the stop's checkpoint has been shown as it went by.
        if (this.attached && batch.some((intr) => !isDebugger(intr))) {
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
          let command: DebuggerCommand;
          try {
            await this.ui.render(skipCheckpoint ? undefined : interrupt.checkpoint, stop);
            command = await this.nextCommand();
          } catch (error) {
            if (!(error instanceof DebuggerDetached)) throw error;
            this.detach();
            command = { type: "continue" };
          }
          lastCommand = command;
          // No broad try/catch: per-command handlers narrow their own catches
          // (e.g. :save / :load handle file errors and log them via
          // ui.log). Anything that escapes is an internal bug that
          // should crash the driver, not silently continue with stale state.
          result = await this.handleCommand(command, interrupt, batch);
          if (result && result.__debuggerQuit) {
            return finalResult;
          }
        } else {
          // User code interrupts: ask about each in turn (`askAbout`
          // renders for each), then answer the batch at once.
          this.ui.setMode(this.debuggerState.getMode());
          result = await this.handleInterrupts(batch, asked);
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
  private async handleInterrupts(batch: Interrupt[], asked: Interrupt[]): Promise<any> {
    const answers: Record<string, InterruptResponse> = {};
    for (const [index, interrupt] of asked.entries()) {
      const position = asked.length > 1 ? ` (${index + 1} of ${asked.length})` : "";
      answers[interrupt.interruptId] = await this.askAbout(interrupt, position);
    }
    return await this.respond(batch, answers);
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
    overrides?: Record<string, unknown>,
  ): Promise<any> {
    const responses = batch.map((intr) => answers[intr.interruptId] ?? { type: "approve" });
    return await this.resumeInterrupt(() =>
      this.mod.respondToInterrupts(batch, responses, { overrides, ...this.resumeOptions() }),
    );
  }

  // eslint-disable-next-line max-lines-per-function -- large command dispatcher; refactor tracked separately
  private async handleCommand(
    command: DebuggerCommand,
    interrupt: Interrupt,
    batch: Interrupt[],
  ): Promise<any> {
    const forwardCommands = ["step", "stepIn", "next", "stepOut", "continue"];
    if (this.programFinished && forwardCommands.includes(command.type)) {
      this.ui.log("Already at end of execution.");
      return { data: interrupt };
    }

    switch (command.type) {
      case "step": {
        this.debuggerState.stepping();
        return await this.resume(batch);
      }
      case "stepIn": {
        this.debuggerState.stepIn();
        return await this.resume(batch);
      }
      case "next": {
        this.debuggerState.stepNext();
        return await this.resume(batch);
      }
      case "stepOut": {
        this.debuggerState.stepOut();
        return await this.resume(batch);
      }
      case "continue": {
        this.debuggerState.running();
        return await this.resume(batch);
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
        return await this.rewindTo(previous, {
          preserveOverrides: command.preserveOverrides,
        });
      }
      case "rewind": {
        // Collect checkpoints from both debug store and user-code store
        const debugCheckpoints = this.debuggerState.getCheckpoints();
        const userStore = this.mod.__getCheckpoints();
        const userCheckpoints = userStore.getCheckpoints();
        const allCheckpoints = [...debugCheckpoints, ...userCheckpoints].sort(
          (a, b) => a.id - b.id,
        );

        const selectedId = await this.ui.showRewindSelector(allCheckpoints);
        if (selectedId === null) {
          // User cancelled — stay where we are
          return { data: interrupt };
        }
        const checkpoint = allCheckpoints.find((c) => c.id === selectedId);
        if (!checkpoint) {
          this.ui.log(`Checkpoint #${selectedId} not found.`);
          return { data: interrupt };
        }

        return await this.rewindTo(checkpoint);
      }
      case "reject": {
        this.ui.log("Rejected interrupt");
        return await this.respond(batch, { [interrupt.interruptId]: { type: "reject" } });
      }
      case "resolve": {
        this.ui.log(`Resolved interrupt with: ${JSON.stringify(command.value)}`);
        return await this.respond(batch, {
          [interrupt.interruptId]: { type: "approve", value: command.value } as InterruptResponse,
        });
      }
      case "showCheckpoints": {
        const debugCheckpoints = this.debuggerState.getCheckpoints();
        const userStore = this.mod.__getCheckpoints();
        const userCheckpoints = userStore.getCheckpoints();
        const allCheckpoints = [...debugCheckpoints, ...userCheckpoints].sort(
          (a, b) => a.id - b.id,
        );
        await this.ui.showCheckpointsPanel(allCheckpoints);
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
          return await this.rewindTo(checkpoint);
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
          return await this.resume(batch);
        }
        return { __debuggerQuit: true };
      }
    }
  }

  /** The queued overrides, cleared: a resume applies them once. */
  private takeOverrides(): Record<string, unknown> {
    const overrides = this.pendingOverrides;
    this.pendingOverrides = {};
    this.ui.setOverrides(this.pendingOverrides);
    return overrides;
  }

  private async resumeInterrupt(fn: () => Promise<any>): Promise<any> {
    this.ui.startSpinner();
    try {
      const result = await fn();
      if (this.attached && result?.usage !== undefined) {
        this.legUsage = sumRunUsage(this.legUsage, result.usage);
      }
      return result;
    } finally {
      this.ui.stopSpinner();
    }
  }

  /** Move on from a debug stop: every stop in the batch is approved, an
   *  answer the resume never reads, and pending overrides are applied. */
  private async resume(batch: Interrupt[]): Promise<any> {
    const overrides = this.takeOverrides();
    return await this.respond(batch, {}, overrides);
  }

  private async rewindTo(
    checkpoint: Checkpoint,
    opts: { preserveOverrides?: boolean } = {},
  ): Promise<any> {
    // Reset state for replay
    this.programFinished = false;
    this.debuggerState.reset();
    this.ui.log(`Rewinding to checkpoint #${checkpoint.id}`);

    // For "time travel" (shift+up), keep overrides pending so they're
    // applied on the next step forward. Otherwise clear them.
    const overrides = opts.preserveOverrides ? this.pendingOverrides : this.takeOverrides();

    this.debuggerState.deleteAfterCheckpoint(checkpoint.id);

    const { invocation, metadata } = this.resumeOptions();
    return await this.resumeInterrupt(() =>
      this.mod.rewindFrom(checkpoint, overrides, { invocation, metadata }),
    );
  }
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
