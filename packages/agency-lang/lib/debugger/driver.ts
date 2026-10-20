import * as fs from "fs";
import * as path from "path";
import type { SourceMap } from "../backends/sourceMap.js";
import { DebuggerState } from "./debuggerState.js";
import type { Interrupt } from "../runtime/interrupts.js";
import type { AgencyCallbacks } from "../runtime/hooks.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { CheckpointStore } from "../runtime/state/checkpointStore.js";
import { isDebugger, isInterrupt, hasInterrupts } from "../runtime/interrupts.js";
import { isDebugStop, type DebugStopData } from "../runtime/debugger.js";
import { describeGuardTrip, draftNote, isGuardTrip } from "./guardAnswer.js";
import type { StateJSON } from "../runtime/state/stateStack.js";
import type { DebuggerCommand, DebuggerIO } from "./types.js";
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
    },
  ) => Promise<any>;
  rewindFrom: (
    checkpoint: Checkpoint,
    overrides: Record<string, unknown>,
    opts?: { metadata?: Record<string, any>; invocation?: InvocationOptions },
  ) => Promise<any>;
  __setDebugger: (dbg: DebuggerState) => void;
  __getCheckpoints: () => CheckpointStore;
};

type DriverOpts = {
  mod: ModuleFunctions;
  sourceMap: SourceMap;
  rewindSize: number;
  ui: DebuggerIO;
  checkpoints?: Checkpoint[];
  traceHeader?: TraceHeader;
  /** The policy and budget the debugged run is started with. The driver
   *  adds the `input()` routing and passes the result on the node call
   *  (through `driver.invocation`) and on every resume and rewind. */
  invocation?: InvocationOptions;
};

type DriverRunOpts = Partial<{
  interceptConsole: boolean;
}>;

export class DebuggerDriver {
  private mod: ModuleFunctions;
  private sourceMap: SourceMap;
  private ui: DebuggerIO;
  /** The invocation the debugged run is called with, and every resume
   *  and rewind: the policy and budget from the run flags, and `input()`
   *  routed to the UI's text field. */
  readonly invocation: InvocationOptions;
  debuggerState: DebuggerState;
  private originalConsoleLog: typeof console.log;
  private originalConsoleError: typeof console.error;
  private programFinished = false;

  constructor(opts: DriverOpts) {
    this.mod = opts.mod;
    this.sourceMap = opts.sourceMap;
    this.ui = opts.ui;
    this.invocation = {
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
      this.ui.state.log(
        `Trace: ${h.program} | ${formattedDate} | Agency v${h.agencyVersion} | ${opts.checkpoints?.length ?? 0} checkpoints`,
      );
    }
  }

  async promptForNodeArgs(parameters: FunctionParameter[]): Promise<unknown[]> {
    return await this.ui.promptForNodeArgs(parameters);
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
      onFunctionStart: (data) => {
        const isAgency = data.moduleId?.endsWith(".agency");
        this.ui.state.pushCallStackEntry({
          functionName: data.functionName,
          moduleId: isAgency ? data.moduleId : "(ts)",
          line: 0,
        });
        if (!isAgency) {
          this.ui.state.log(`[ts] ${data.functionName}()`);
        }
        this.ui.render();
      },
      onFunctionEnd: (data) => {
        this.ui.state.removeWithFuncName(data.functionName);
        this.ui.render();
      },
      onNodeStart: (data) => {
        // gets triggered on every statement, as debugger resumes node execution.
        // this.ui.state.log(`-> node: ${data.nodeName}`);
      },
      onNodeEnd: (data) => {
        this.ui.state.log(`<- node: ${data.nodeName}`);
        this.ui.render();
      },
      onLLMCallStart: (data) => {
        const model = typeof data.model === "string" ? data.model : "unknown";
        this.ui.state.log(`Calling LLM: ${model}...`);
        this.ui.render();
      },
      onLLMCallEnd: (data) => {
        const tokens = data.usage ? `${data.usage.totalTokens} tokens` : "unknown tokens";
        const time = `${round(data.timeTaken)}ms`;
        this.ui.state.log(`LLM returned (${tokens}, ${time})`);
        this.ui.render();
      },
      onToolCallStart: (data) => {
        this.ui.state.log(
          `Tool call: ${data.toolName}(${Object.entries(data.args)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join(", ")})`,
        );
        this.ui.render();
      },
      onToolCallEnd: (data) => {
        this.ui.state.log(`Tool done: ${data.toolName} (${round(data.timeTaken)}ms)`);
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
          this.ui.state.log(
            `Program finished. Return value: ${JSON.stringify(result?.data ?? undefined)}`,
          );
          this.programFinished = true;
          finalResult = result;
          // When the program finishes, keep the last batch so the user can
          // keep interacting (step back, rewind, print, etc.)
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
          this.ui.state.setMode(this.debuggerState.getMode());
          // Only pass checkpoint when execution has moved to a new position.
          // Non-stepping commands (set, print, checkpoint) stay at the same
          // position, so we re-render without a new checkpoint.
          const nonSteppingCommands = ["set", "print", "checkpoint"];
          const skipCheckpoint = lastCommand && nonSteppingCommands.includes(lastCommand.type);
          // The stepping commands work from the depth of the stop that is
          // shown. Several branches can stop in one round, so the runtime
          // does not record a depth; the stop record carries it.
          const stop = stopOf(interrupt);
          if (stop) this.debuggerState.stoppedAt(stop.depth);
          // A stop of the tool loop's own has no source line, so the
          // activity log says where the loop is.
          if (!skipCheckpoint && stop?.loopStop !== undefined) {
            this.ui.state.log(`Stopped before ${stop.label}`);
          }
          // Several branches stopped at once: one is shown, and the next
          // command moves all of them.
          if (!skipCheckpoint && !this.programFinished && batch.length > 1) {
            const others = batch.slice(1).map((intr) => stopOf(intr)?.scopeName ?? "a branch");
            this.ui.state.log(`Also stopped in ${others.join(", ")}; the next command moves all`);
          }
          await this.ui.render(skipCheckpoint ? undefined : interrupt.checkpoint, stop);
          const command = await this.ui.waitForCommand();
          lastCommand = command;
          // No broad try/catch: per-command handlers narrow their own catches
          // (e.g. :save / :load handle file errors and log them via
          // ui.state.log). Anything that escapes is an internal bug that
          // should crash the driver, not silently continue with stale state.
          result = await this.handleCommand(command, interrupt, batch);
          if (result && result.__debuggerQuit) {
            return finalResult;
          }
        } else {
          // User code interrupts: show the first, ask about each in turn,
          // then answer the batch at once.
          this.ui.state.setMode(this.debuggerState.getMode());
          await this.ui.render(interrupt.checkpoint);
          result = await this.handleInterrupts(batch, asked);
        }
      }
    } finally {
      this.restoreConsole();
      this.ui.destroy();
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
    this.ui.state.resetCallStack();
    return await this.respond(batch, answers);
  }

  /** One interrupt's answer, asked for until the input is one of
   *  approve, reject, or resolve with a value. A guard trip takes a
   *  grant, a disarm, a message, or a reject instead. */
  private async askAbout(interrupt: Interrupt, position: string): Promise<InterruptResponse> {
    if (isGuardTrip(interrupt.effect, interrupt.data)) {
      return await this.askAboutGuardTrip(interrupt, position);
    }
    const data =
      Object.keys(interrupt.data ?? {}).length > 0 ? ` ${JSON.stringify(interrupt.data)}` : "";
    this.ui.state.log(`Interrupt${position}: ${interrupt.message}${data}`);
    while (true) {
      // The label shares one row with the typed answer, so it stays
      // short; the message is in the activity log.
      const input = await this.ui.promptForInput(
        `interrupt${position}: approve / reject / resolve <value>`,
      );
      const trimmed = input.trim();
      if (trimmed === "approve" || trimmed === "a" || trimmed === "") {
        this.ui.state.log("Approved interrupt");
        return { type: "approve" };
      }
      if (trimmed === "reject" || trimmed === "r") {
        this.ui.state.log("Rejected interrupt");
        return { type: "reject" };
      }
      if (trimmed.startsWith("resolve ")) {
        const valueStr = trimmed.slice("resolve ".length).trim();
        let value: unknown;
        try {
          value = JSON.parse(valueStr);
        } catch {
          value = valueStr;
        }
        this.ui.state.log(`Resolved interrupt with: ${JSON.stringify(value)}`);
        return { type: "approve", value } as InterruptResponse;
      }
      this.ui.state.log(`Unknown response: "${trimmed}". Try: approve, reject, resolve <value>`);
    }
  }

  /** A guard trip's answer comes from the form (`showGuardTripForm`),
   *  which only offers answers the runtime accepts. */
  private async askAboutGuardTrip(
    interrupt: Interrupt,
    position: string,
  ): Promise<InterruptResponse> {
    this.ui.state.log(`${describeGuardTrip(interrupt.data)}${position}`);
    this.ui.state.log(draftNote(interrupt.data));
    const response = await this.ui.answerGuardTrip(interrupt.data);
    this.ui.state.log(
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
      this.mod.respondToInterrupts(batch, responses, {
        overrides,
        invocation: this.invocation,
        metadata: {
          callbacks: this.getCallbacks(),
          debugger: this.debuggerState,
        },
      }),
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
      this.ui.state.log("Already at end of execution.");
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
          this.ui.state.log(
            "set inside a tool call, a fork, or a parallel block is not supported yet",
          );
          return { data: interrupt };
        }
        // The frame shown at one of the loop's own stops is the caller's,
        // but the override would land on the loop's frame, the last one.
        if (stop?.loopStop !== undefined) {
          this.ui.state.log("set before a model request or a tool call is not supported yet");
          return { data: interrupt };
        }
        this.ui.state.setOverride(command.varName, command.value);
        this.ui.state.log(`Set ${command.varName} = ${JSON.stringify(command.value)}`);
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
          this.ui.state.log(
            `Pinned checkpoint #${checkpointId}${command.label ? ` "${command.label}"` : ""}`,
          );
        }
        return { data: interrupt };
      }
      case "print": {
        const value = this.lookupVariable(command.varName, interrupt);
        if (value !== undefined) {
          this.ui.state.log(`${command.varName} = ${JSON.stringify(value)}`);
        } else {
          this.ui.state.log(`${command.varName} = (not found)`);
        }
        return { data: interrupt };
      }
      case "stepBack": {
        const cp = interrupt.checkpoint;
        if (!cp) {
          this.ui.state.log("No checkpoint on current interrupt");
          return { data: interrupt };
        }
        if (cp.id < 0) {
          this.ui.state.log("Current checkpoint is not valid for stepping back");
          return { data: interrupt };
        }

        const previous = this.debuggerState.findBefore(cp.id, stopOf(interrupt) ?? cp);

        if (!previous) {
          this.ui.state.log("Already at earliest checkpoint");
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
          this.ui.state.log(`Checkpoint #${selectedId} not found.`);
          return { data: interrupt };
        }

        return await this.rewindTo(checkpoint);
      }
      case "reject": {
        this.ui.state.log("Rejected interrupt");
        this.ui.state.resetCallStack();
        return await this.respond(batch, { [interrupt.interruptId]: { type: "reject" } });
      }
      case "resolve": {
        this.ui.state.log(`Resolved interrupt with: ${JSON.stringify(command.value)}`);
        this.ui.state.resetCallStack();
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
          this.ui.state.log("No checkpoint to save");
          return { data: interrupt };
        }
        const filePath = command.path.endsWith(".json") ? command.path : command.path + ".json";
        const absPath = path.resolve(filePath);
        try {
          fs.writeFileSync(absPath, JSON.stringify(rolling.toJSON(), null, 2));
          this.ui.state.log(`Saved checkpoint to ${absPath}`);
        } catch (e: any) {
          this.ui.state.log(`Failed to save: ${e.message}`);
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
            this.ui.state.log(`Invalid checkpoint data in file: ${JSON.stringify(json)}`);
            return { data: interrupt };
          }
          return await this.rewindTo(checkpoint);
        } catch (e: any) {
          this.ui.state.log(`Failed to load: ${e.message}`);
          return { data: interrupt };
        }
      }
      case "quit": {
        return { __debuggerQuit: true };
      }
    }
  }

  private async resumeInterrupt(fn: () => Promise<any>): Promise<any> {
    this.ui.startSpinner();
    try {
      return await fn();
    } finally {
      this.ui.stopSpinner();
    }
  }

  /** Move on from a debug stop: every stop in the batch is approved, an
   *  answer the resume never reads, and pending overrides are applied. */
  private async resume(batch: Interrupt[]): Promise<any> {
    const overrides = this.ui.state.getOverrides();
    this.ui.state.resetOverrides();
    return await this.respond(batch, {}, overrides);
  }

  private async rewindTo(
    checkpoint: Checkpoint,
    opts: { preserveOverrides?: boolean } = {},
  ): Promise<any> {
    // Reset state for replay
    this.programFinished = false;
    this.debuggerState.reset();
    this.ui.state.resetCallStack();
    this.ui.state.log(`Rewinding to checkpoint #${checkpoint.id}`);

    const overrides = this.ui.state.getOverrides();

    // For "time travel" (shift+up), keep overrides pending so they're
    // applied on the next step forward. Otherwise clear them.
    if (!opts.preserveOverrides) {
      this.ui.state.resetOverrides();
    }

    this.debuggerState.deleteAfterCheckpoint(checkpoint.id);

    return await this.resumeInterrupt(() =>
      this.mod.rewindFrom(checkpoint, overrides, {
        invocation: this.invocation,
        metadata: {
          callbacks: this.getCallbacks(),
          debugger: this.debuggerState,
        },
      }),
    );
  }

  private lookupVariable(varName: string, interrupt: Interrupt): unknown {
    const checkpoint = Checkpoint.fromJSON(interrupt.checkpoint);
    if (!checkpoint) return undefined;

    // Check locals and args in the frame the program is stopped in
    const frame = stoppedFrame(interrupt);
    if (frame) {
      if (varName in frame.locals) return frame.locals[varName];
      if (varName in frame.args) return frame.args[varName];
    }

    // Check the globals the stopped stack sees: a fork or parallel
    // branch has its own copy.
    const location = stopOf(interrupt) ?? checkpoint;
    const moduleGlobals = checkpoint.globalsAt(location.branchPath).store[location.moduleId];
    if (moduleGlobals && varName in moduleGlobals) {
      return moduleGlobals[varName];
    }

    return undefined;
  }

  private isInSourceMap(functionName: string): boolean {
    for (const key of Object.keys(this.sourceMap)) {
      // Source map keys are "moduleId:scopeName"
      const scopeName = key.split(":").slice(1).join(":");
      if (scopeName === functionName) return true;
    }
    return false;
  }
}

/** The stop a debug interrupt carries, or nothing for a user interrupt
 *  and for the placeholder interrupt a trace replay starts from. */
function stopOf(interrupt: Interrupt): DebugStopData | undefined {
  return isDebugStop(interrupt.data) ? interrupt.data : undefined;
}

/** The frame the program is stopped in: the one the stop's location
 *  leads to, else the checkpoint's own. At one of the tool loop's own
 *  stops that is the frame that called `llm()`. */
function stoppedFrame(interrupt: Interrupt): StateJSON | undefined {
  const checkpoint = Checkpoint.fromJSON(interrupt.checkpoint);
  if (!checkpoint) return undefined;
  return checkpoint.shownFrame(stopOf(interrupt) ?? checkpoint);
}
