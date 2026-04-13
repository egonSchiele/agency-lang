import * as fs from "fs";
import * as path from "path";
import type { SourceMap } from "../backends/sourceMap.js";
import { DebuggerState } from "./debuggerState.js";
import type { Interrupt } from "../runtime/interrupts.js";
import type { AgencyCallbacks } from "../runtime/hooks.js";
import type { RewindCheckpoint } from "../runtime/rewind.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import type { CheckpointStore } from "../runtime/state/checkpointStore.js";
import { isDebugger, isInterrupt } from "../runtime/interrupts.js";
import { StateStack } from "../runtime/state/stateStack.js";
import type { DebuggerCommand, DebuggerIO } from "./types.js";
import type { FunctionParameter } from "../types.js";
import type { TraceHeader } from "../runtime/trace/types.js";

import type { InterruptResponse } from "../runtime/interrupts.js";
import { color } from "termcolors";
import { round } from "@/utils.js";

// Functions from the compiled module that are bound to __globalCtx
type ModuleFunctions = {
  approveInterrupt: (
    interrupt: Interrupt,
    opts?: {
      overrides?: Record<string, unknown>;
      metadata?: Record<string, any>;
    },
  ) => Promise<any>;
  respondToInterrupt: (
    interrupt: Interrupt,
    response: InterruptResponse,
    opts?: {
      overrides?: Record<string, unknown>;
      metadata?: Record<string, any>;
    },
  ) => Promise<any>;
  rewindFrom: (
    checkpoint: RewindCheckpoint,
    overrides: Record<string, unknown>,
    opts?: { metadata?: Record<string, any> },
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
};

type DriverRunOpts = Partial<{
  interceptConsole: boolean;
}>;

export class DebuggerDriver {
  private mod: ModuleFunctions;
  private sourceMap: SourceMap;
  private ui: DebuggerIO;
  debuggerState: DebuggerState;
  private originalConsoleLog: typeof console.log;
  private originalConsoleError: typeof console.error;
  private programFinished = false;

  constructor(opts: DriverOpts) {
    this.mod = opts.mod;
    this.sourceMap = opts.sourceMap;
    this.ui = opts.ui;
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
      this.ui.state.log(`Trace: ${h.program} | ${formattedDate} | Agency v${h.agencyVersion} | ${opts.checkpoints?.length ?? 0} checkpoints`);
    }
  }

  async promptForNodeArgs(parameters: FunctionParameter[]): Promise<unknown[]> {
    return await this.ui.promptForNodeArgs(parameters);
  }

  private interceptConsole(): void {
    console.log = (...args: any[]) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      this.ui.appendStdout(text);
    };
    console.error = (...args: any[]) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      this.ui.appendStdout(text);
    };
    (globalThis as any).__agencyInputOverride = (prompt: string) => {
      return this.ui.promptForInput(prompt);
    };
  }

  private restoreConsole(): void {
    console.log = this.originalConsoleLog;
    console.error = this.originalConsoleError;
    delete (globalThis as any).__agencyInputOverride;
  }

  getCallbacks(): AgencyCallbacks {
    return {
      onFunctionStart: (data) => {
        const isInSource = this.isInSourceMap(data.functionName);
        this.debuggerState.enterCall();
        this.ui.state.pushCallStackEntry({
          functionName: data.functionName,
          moduleId: isInSource ? data.functionName : "(ts)",
          line: 0,
        });
        if (!isInSource) {
          this.ui.state.log(`[ts] ${data.functionName}()`);
        }
      },
      onFunctionEnd: (data) => {
        this.debuggerState.exitCall();
        this.ui.state.removeWithFuncName(data.functionName);
      },
      onNodeStart: (data) => {
        // gets triggered on every statement, as debugger resumes node execution.
        // this.ui.state.log(`-> node: ${data.nodeName}`);
      },
      onNodeEnd: (data) => {
        this.ui.state.log(`<- node: ${data.nodeName}`);
      },
      onLLMCallStart: (data) => {
        const model = typeof data.model === "string" ? data.model : "unknown";
        this.ui.state.log(`Calling LLM: ${model}...`);
      },
      onLLMCallEnd: (data) => {
        const tokens = data.usage
          ? `${data.usage.totalTokens} tokens`
          : "unknown tokens";
        const time = `${round(data.timeTaken)}ms`;
        this.ui.state.log(`LLM returned (${tokens}, ${time})`);
      },
      onToolCallStart: (data) => {
        this.ui.state.log(`Tool call: ${data.toolName}()`);
      },
      onToolCallEnd: (data) => {
        this.ui.state.log(`Tool done: ${data.toolName} (${round(data.timeTaken)}ms)`);
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
      let lastInterrupt: Interrupt | null = null;
      let finalResult: any = undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!isInterrupt(result?.data)) {
          if (!lastInterrupt) {
            throw new Error("Program finished without any interrupts. This shouldn't happen with the debugger enabled.");
          }
          this.ui.state.log(`Program finished. Return value: ${JSON.stringify(result?.data ?? undefined)}`);
          this.programFinished = true;
          finalResult = result;

          // When the program finishes, restore the last interrupt so the user
          // can keep interacting (step back, rewind, print, etc.)
          result = { data: lastInterrupt };
        }
        const interrupt = result.data as Interrupt;
        lastInterrupt = interrupt;
        if (isDebugger(interrupt)) {
          // Debug pause — show state and accept stepping commands
          this.ui.state.setMode(this.debuggerState.getMode());
          // Only pass checkpoint when execution has moved to a new position.
          // Non-stepping commands (set, print, checkpoint) stay at the same
          // position, so we re-render without a new checkpoint.
          const nonSteppingCommands = ["set", "print", "checkpoint"];
          const skipCheckpoint = lastCommand && nonSteppingCommands.includes(lastCommand.type);
          await this.ui.render(skipCheckpoint ? undefined : interrupt.checkpoint);
          const command = await this.ui.waitForCommand();
          lastCommand = command;
          try {
            result = await this.handleCommand(command, interrupt);
          } catch (e) {
            this.ui.state.log(`Error: ${e}`);
            continue;
          }
          if (result && result.__debuggerQuit) {
            return finalResult;
          }
        } else {
          // User code interrupt — show it and collect input from the user
          this.ui.state.log(
            `Interrupt: ${JSON.stringify((interrupt as Interrupt).data)}`,
          );
          this.ui.state.setMode(this.debuggerState.getMode());
          await this.ui.render(interrupt);
          try {
            result = await this.handleInterrupt(interrupt);
          } catch (e) {
            this.ui.state.log(`Error: ${e}`);
            continue;
          }
          if (result && result.__debuggerQuit) {
            return finalResult;
          }
        }
      }
    } finally {
      this.restoreConsole();
      this.ui.destroy();
    }
  }

  private async handleInterrupt(interrupt: Interrupt): Promise<any> {
    const input = await this.ui.promptForInput(
      "approve / reject / resolve <value> / modify key=value",
    );
    const trimmed = input.trim();

    if (trimmed === "approve" || trimmed === "a" || trimmed === "") {
      this.ui.state.log("Approved interrupt");
      this.debuggerState.resetCallDepth();
      this.ui.state.resetCallStack();
      return await this.resumeInterrupt(() =>
        this.mod.approveInterrupt(interrupt, {
          metadata: {
            callbacks: this.getCallbacks(),
            debugger: this.debuggerState,
          },
        }),
      );
    }

    if (trimmed === "reject" || trimmed === "r") {
      this.ui.state.log("Rejected interrupt");
      this.debuggerState.resetCallDepth();
      this.ui.state.resetCallStack();
      return await this.resumeInterrupt(() =>
        this.mod.respondToInterrupt(
          interrupt,
          { type: "reject" },
          {
            metadata: {
              callbacks: this.getCallbacks(),
              debugger: this.debuggerState,
            },
          },
        ),
      );
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
      this.debuggerState.resetCallDepth();
      this.ui.state.resetCallStack();
      return await this.resumeInterrupt(() =>
        this.mod.respondToInterrupt(
          interrupt,
          { type: "resolve", value },
          {
            metadata: {
              callbacks: this.getCallbacks(),
              debugger: this.debuggerState,
            },
          },
        ),
      );
    }

    if (trimmed.startsWith("modify ")) {
      const rest = trimmed.slice("modify ".length).trim();
      const overrides: Record<string, unknown> = {};
      for (const pair of rest.split(/\s+/)) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx === -1) continue;
        const key = pair.slice(0, eqIdx);
        const valStr = pair.slice(eqIdx + 1);
        try {
          overrides[key] = JSON.parse(valStr);
        } catch {
          overrides[key] = valStr;
        }
      }
      this.ui.state.log(
        `Modified interrupt args: ${JSON.stringify(overrides)}`,
      );
      this.debuggerState.resetCallDepth();
      this.ui.state.resetCallStack();
      return await this.resumeInterrupt(() =>
        this.mod.respondToInterrupt(
          interrupt,
          { type: "modify", newArguments: overrides },
          {
            metadata: {
              callbacks: this.getCallbacks(),
              debugger: this.debuggerState,
            },
          },
        ),
      );
    }

    this.ui.state.log(`Unknown response: "${trimmed}". Try: approve, reject, resolve <value>, modify key=value`);
    return { data: interrupt };
  }

  private async handleCommand(
    command: DebuggerCommand,
    interrupt: Interrupt,
  ): Promise<any> {
    const forwardCommands = ["step", "stepIn", "next", "stepOut", "continue"];
    if (this.programFinished && forwardCommands.includes(command.type)) {
      this.ui.state.log("Already at end of execution.");
      return { data: interrupt };
    }

    switch (command.type) {
      case "step": {
        this.debuggerState.stepping();
        return await this.resume(interrupt);
      }
      case "stepIn": {
        this.debuggerState.stepIn();
        return await this.resume(interrupt);
      }
      case "next": {
        this.debuggerState.stepNext();
        return await this.resume(interrupt);
      }
      case "stepOut": {
        this.debuggerState.stepOut();
        return await this.resume(interrupt);
      }
      case "continue": {
        this.debuggerState.running();
        return await this.resume(interrupt);
      }
      case "set": {
        this.ui.state.setOverride(command.varName, command.value);
        this.ui.state.log(
          `Set ${command.varName} = ${JSON.stringify(command.value)}`,
        );
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
          const checkpointId =
            this.debuggerState.cloneCheckpoint(lastCheckpoint);
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
          this.ui.state.log(
            "Current checkpoint is not valid for stepping back",
          );
          return { data: interrupt };
        }

        const previous = this.debuggerState.findBefore(cp);

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
        this.debuggerState.resetCallDepth();
        this.ui.state.resetCallStack();
        return await this.resumeInterrupt(() =>
          this.mod.respondToInterrupt(
            interrupt,
            { type: "reject" },
            {
              metadata: {
                callbacks: this.getCallbacks(),
                debugger: this.debuggerState,
              },
            },
          ),
        );
      }
      case "resolve": {
        this.ui.state.log(
          `Resolved interrupt with: ${JSON.stringify(command.value)}`,
        );
        this.debuggerState.resetCallDepth();
        this.ui.state.resetCallStack();
        return await this.resumeInterrupt(() =>
          this.mod.respondToInterrupt(
            interrupt,
            { type: "resolve", value: command.value },
            {
              metadata: {
                callbacks: this.getCallbacks(),
                debugger: this.debuggerState,
              },
            },
          ),
        );
      }
      case "modify": {
        this.ui.state.log(
          `Modified interrupt args: ${JSON.stringify(command.overrides)}`,
        );
        this.debuggerState.resetCallDepth();
        this.ui.state.resetCallStack();
        return await this.resumeInterrupt(() =>
          this.mod.respondToInterrupt(
            interrupt,
            { type: "modify", newArguments: command.overrides },
            {
              metadata: {
                callbacks: this.getCallbacks(),
                debugger: this.debuggerState,
              },
            },
          ),
        );
      }
      case "save": {
        const rollingCheckpoints = this.debuggerState.getCheckpoints();
        const rolling = rollingCheckpoints.at(-1);
        if (!rolling) {
          this.ui.state.log("No checkpoint to save");
          return { data: interrupt };
        }
        const filePath = command.path.endsWith(".json")
          ? command.path
          : command.path + ".json";
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
        const filePath = command.path.endsWith(".json")
          ? command.path
          : command.path + ".json";
        const absPath = path.resolve(filePath);
        try {
          const raw = fs.readFileSync(absPath, "utf-8");
          const json = JSON.parse(raw);
          const checkpoint = Checkpoint.fromJSON(json);
          if (!checkpoint) {
            this.ui.state.log(
              `Invalid checkpoint data in file: ${JSON.stringify(json)}`,
            );
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

  private async resume(interrupt: Interrupt): Promise<any> {
    const overrides = this.ui.state.getOverrides();

    this.ui.state.resetOverrides();

    // Reset call depth — it will be rebuilt by hooks during replay
    this.debuggerState.resetCallDepth();
    this.ui.state.resetCallStack();

    return await this.resumeInterrupt(() =>
      this.mod.approveInterrupt(interrupt, {
        overrides,
        metadata: {
          callbacks: this.getCallbacks(),
          debugger: this.debuggerState,
        },
      }),
    );
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

    // rewindFrom expects a RewindCheckpoint with llmCall data.
    // For debugger rewinds, pass empty values.
    const rewindCp: RewindCheckpoint = {
      checkpoint,
      llmCall: {
        step: 0,
        targetVariable: "",
        prompt: "",
        response: "",
        model: "",
      },
    };

    this.debuggerState.deleteAfterCheckpoint(checkpoint.id);

    return await this.resumeInterrupt(() =>
      this.mod.rewindFrom(rewindCp, overrides, {
        metadata: {
          callbacks: this.getCallbacks(),
          debugger: this.debuggerState,
        },
      }),
    );
  }

  private lookupVariable(varName: string, interrupt: Interrupt): unknown {
    const checkpoint = interrupt.checkpoint;
    if (!checkpoint) return undefined;

    // Check locals and args in the last frame
    const frame = StateStack.lastFrameJSON(checkpoint.stack);
    if (frame) {
      if (varName in frame.locals) return frame.locals[varName];
      if (varName in frame.args) return frame.args[varName];
    }

    // Check globals
    const moduleGlobals = checkpoint.globals.store[checkpoint.moduleId];
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
