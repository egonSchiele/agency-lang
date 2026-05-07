import {
  Screen,
  FrameRecorder,
  type Frame,
  type InputSource,
  type KeyEvent,
  type OutputTarget,
} from "@agency-lang/tui";
import { DebuggerDriver } from "./driver.js";
import { DebuggerUI } from "./ui.js";
import type { Checkpoint } from "../runtime/state/checkpointStore.js";
import { resetGlobalCheckpointCounter } from "../runtime/state/checkpointStore.js";
import { hasInterrupts } from "../runtime/interrupts.js";

/**
 * An InputSource that notifies when the consumer (driver) is idle —
 * i.e. blocked waiting for the next key.
 */
class TestInput implements InputSource {
  private keyQueue: KeyEvent[] = [];
  private keyWaiters: ((key: KeyEvent) => void)[] = [];
  private idleResolvers: (() => void)[] = [];

  feedKey(key: KeyEvent): void {
    const waiter = this.keyWaiters.shift();
    if (waiter) {
      waiter(key);
    } else {
      this.keyQueue.push(key);
    }
  }

  nextKey(): Promise<KeyEvent> {
    const queued = this.keyQueue.shift();
    if (queued) return Promise.resolve(queued);
    // Signal idle — the driver is blocked waiting for input
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
    return new Promise<KeyEvent>((resolve) => {
      this.keyWaiters.push(resolve);
    });
  }

  waitForIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  nextLine(_prompt: string): Promise<string> {
    return Promise.resolve("");
  }

  destroy(): void {
    this.keyQueue = [];
    this.keyWaiters = [];
    this.idleResolvers = [];
  }
}

/**
 * Output wrapper that injects a label into each frame written to the recorder.
 */
class LabelingOutput implements OutputTarget {
  private recorder: FrameRecorder;
  label: string = "initial";

  constructor(recorder: FrameRecorder) {
    this.recorder = recorder;
  }

  write(frame: Frame, _label?: string): void {
    this.recorder.write(frame, this.label);
  }
}

type TestSessionOpts = {
  mod: any;
  args?: unknown[];
  checkpoints?: Checkpoint[];
  width?: number;
  height?: number;
};

/**
 * Thin wrapper that creates a DebuggerUI wired to test infrastructure.
 * Provides a step-at-a-time API for feeding keys and inspecting frames.
 */
export class DebuggerTestSession {
  private input: TestInput;
  private labelingOutput: LabelingOutput;
  readonly recorder: FrameRecorder;
  readonly ui: DebuggerUI;
  readonly driver: DebuggerDriver;
  private runPromise: Promise<any> | null = null;
  private result: any = undefined;
  private finished = false;
  private pressCount = 0;

  private constructor(
    input: TestInput,
    labelingOutput: LabelingOutput,
    recorder: FrameRecorder,
    ui: DebuggerUI,
    driver: DebuggerDriver,
  ) {
    this.input = input;
    this.labelingOutput = labelingOutput;
    this.recorder = recorder;
    this.ui = ui;
    this.driver = driver;
  }

  static async create(opts: TestSessionOpts): Promise<DebuggerTestSession> {
    resetGlobalCheckpointCounter();

    const input = new TestInput();
    const recorder = new FrameRecorder();
    const labelingOutput = new LabelingOutput(recorder);
    const screen = new Screen({
      input,
      output: labelingOutput,
      width: opts.width ?? 120,
      height: opts.height ?? 40,
    });
    const ui = new DebuggerUI(screen);

    const driver = new DebuggerDriver({
      mod: {
        respondToInterrupts: opts.mod.respondToInterrupts,
        rewindFrom: opts.mod.rewindFrom,
        __setDebugger: opts.mod.__setDebugger,
        __getCheckpoints: opts.mod.__getCheckpoints,
      },
      sourceMap: opts.mod.__sourceMap ?? {},
      rewindSize: Math.max(30, opts.checkpoints?.length ?? 0),
      ui,
      checkpoints: opts.checkpoints,
    });

    opts.mod.__setDebugger(driver.debuggerState);

    const session = new DebuggerTestSession(input, labelingOutput, recorder, ui, driver);

    // Get initial interrupt from the program
    const callbacks = driver.getCallbacks();

    if (opts.checkpoints?.length) {
      // Trace mode: start at the last checkpoint
      const lastCp = opts.checkpoints[opts.checkpoints.length - 1];
      const { createDebugInterrupt } = await import(
        "../runtime/interrupts.js"
      );
      const interrupt = createDebugInterrupt(
        undefined,
        lastCp.id,
        lastCp,
        "test-run-id",
      );

      // Start driver in background, wait for first idle
      const idlePromise = input.waitForIdle();
      session.runPromise = driver
        .run({ data: interrupt }, { interceptConsole: false })
        .then((r) => {
          session.result = r;
          session.finished = true;
        });
      await idlePromise;
    } else {
      // Normal mode: run the entry node
      const args = opts.args ?? [];
      const initialResult = await opts.mod.main(...args, { callbacks });

      if (!initialResult?.data || !hasInterrupts(initialResult.data)) {
        throw new Error(
          "Program did not produce a debug interrupt. Was it compiled with debugger: true?",
        );
      }

      // Start driver in background, wait for first idle
      const idlePromise = input.waitForIdle();
      session.runPromise = driver
        .run(initialResult, { interceptConsole: false })
        .then((r) => {
          session.result = r;
          session.finished = true;
        });
      await idlePromise;
    }

    return session;
  }

  /**
   * Feed a key press and wait for the driver to become idle again.
   * Accepts single character keys or special key names like "enter", "escape", "tab".
   */
  async press(key: string, opts?: { times?: number; shift?: boolean }): Promise<void> {
    const times = opts?.times ?? 1;
    for (let i = 0; i < times; i++) {
      if (this.finished) return;
      this.pressCount++;
      const displayKey = formatKeyForLabel(key, opts?.shift);
      const suffix = times > 1 ? ` (${i + 1}/${times})` : "";
      this.labelingOutput.label = `#${this.pressCount} press("${displayKey}")${suffix}`;

      const idlePromise = this.input.waitForIdle();
      this.input.feedKey({ key, shift: opts?.shift });

      // Race: either the driver becomes idle again (waiting for next key)
      // or the driver finishes (run promise resolves)
      await Promise.race([
        idlePromise,
        this.runPromise,
      ]);
    }
  }

  /**
   * Type a string character by character, then press Enter.
   */
  async type(str: string): Promise<void> {
    this.pressCount++;
    this.labelingOutput.label = `#${this.pressCount} type("${str}")`;
    for (const ch of str) {
      if (this.finished) return;
      const idlePromise = this.input.waitForIdle();
      this.input.feedKey({ key: ch });
      await Promise.race([idlePromise, this.runPromise]);
    }
    if (this.finished) return;
    const idlePromise = this.input.waitForIdle();
    this.input.feedKey({ key: "enter" });
    await Promise.race([idlePromise, this.runPromise]);
  }

  /**
   * Return the last rendered Frame for inspection.
   */
  frame(): Frame {
    if (this.recorder.frames.length === 0) {
      throw new Error("No frames recorded yet");
    }
    return this.recorder.frames[this.recorder.frames.length - 1].frame;
  }

  /**
   * Press "q" to quit the driver and return the program's return value.
   */
  async quit(): Promise<any> {
    if (!this.finished) {
      this.input.feedKey({ key: "q" });
      await this.runPromise;
    }
    const rv =
      this.result?.data !== undefined ? this.result.data : this.result;
    return rv;
  }

  /**
   * Return the program's return value (only available after quit()).
   */
  returnValue(): any {
    const rv =
      this.result?.data !== undefined ? this.result.data : this.result;
    return rv;
  }

  /**
   * Write all recorded frames as an HTML file for visual inspection.
   */
  writeHTML(path: string): void {
    this.recorder.writeHTML(path);
  }

  /**
   * Get the DebuggerUI's last frame (same as ui.lastFrame).
   */
  get lastFrame(): Frame | null {
    return this.ui.lastFrame;
  }

  /**
   * Check if the driver run has finished.
   */
  get isFinished(): boolean {
    return this.finished;
  }
}

const KEY_LABELS: Record<string, string> = {
  s: "s — step",
  n: "n — next",
  i: "i — stepIn",
  o: "o — stepOut",
  c: "c — continue",
  r: "r — rewind",
  d: "d — checkpoints",
  k: "k — checkpoint",
  p: "p — print",
  q: "q — quit",
  up: "↑ — stepBack",
  down: "↓ — step",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  " ": "Space — continue",
};

function formatKeyForLabel(key: string, shift?: boolean): string {
  const base = KEY_LABELS[key] ?? key;
  return shift ? `Shift+${base}` : base;
}
