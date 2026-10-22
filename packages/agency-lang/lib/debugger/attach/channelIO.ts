// The run side's `DebuggerIO`: every method becomes a message on the
// channel, and a method that expects an answer waits for the reply with
// its id. The driver in the program's process sees an ordinary
// `DebuggerIO`; the person at the other end sees the terminal UI.
import type { PendingPreview } from "../edits/rows.js";
import { nativeTypeReplacer } from "../../runtime/revivers/index.js";
import type { InterruptResponse } from "../../runtime/interrupts.js";
import type { DebugStopData } from "../../runtime/debugger.js";
import type { Checkpoint } from "../../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../../types.js";
import type { GuardTripData } from "../guardAnswer.js";
import {
  DebuggerDetached,
  type BusyEntry,
  type DebuggerCommand,
  type DebuggerIO,
  type DebuggerMode,
} from "../types.js";
import type { Channel } from "./channel.js";
import {
  parseAttachMessage,
  REPLY_SCHEMAS,
  type NoticeMethod,
  type RequestMethod,
} from "./protocol.js";

type Pending = {
  method: RequestMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** A checkpoint as it crosses the channel: plain JSON, native types
 *  (dates, sets) replaced the way the trace writer and `onCheckpoint`
 *  replace them. The driver hands `render` the checkpoint off the
 *  interrupt, which is already JSON, and the selector the store's own
 *  `Checkpoint` instances, so both shapes are taken. */
export function checkpointToWire(checkpoint: Checkpoint | object): unknown {
  const json =
    typeof (checkpoint as Checkpoint).toJSON === "function"
      ? (checkpoint as Checkpoint).toJSON()
      : checkpoint;
  return JSON.parse(JSON.stringify(json, nativeTypeReplacer));
}

/** `value` as JSON, cut short: the line goes to the program's stderr,
 *  often a log file, and a UI bug can answer with a whole checkpoint. */
function shortJson(value: unknown, limit = 200): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} characters)` : text;
}

export class ChannelDebuggerIO implements DebuggerIO {
  private nextId = 0;
  private pending: Record<number, Pending> = {};
  private closed = false;
  private pauseListeners: (() => void)[] = [];

  /** `warn` takes the one line printed when the debugger at the other
   *  end fails; the program's stderr by default. */
  constructor(
    private readonly channel: Channel,
    private readonly warn: (line: string) => void = (line) => console.error(line),
  ) {
    channel.onMessage((raw) => this.receive(raw));
    channel.onClose(() => this.closeAll());
  }

  /** A reply. One that carries the UI's error, or a result of the wrong
   *  shape for its method, ends the session: the program must never fail
   *  because its debugger did, so the failure becomes a detach, with one
   *  line on stderr saying why. */
  private receive(raw: unknown): void {
    const message = parseAttachMessage(raw);
    if (message === null) {
      return;
    }
    if (message.type === "pause") {
      for (const listener of this.pauseListeners) {
        listener();
      }
      return;
    }
    if (message.type !== "reply") {
      return;
    }
    const waiting = this.pending[message.id];
    if (waiting === undefined) {
      return;
    }
    if (message.error !== undefined) {
      this.failSession(`the debugger failed to answer ${waiting.method}: ${message.error}`);
      return;
    }
    const checked = REPLY_SCHEMAS[waiting.method].safeParse(message.result);
    if (!checked.success) {
      this.failSession(
        `the debugger answered ${waiting.method} with ${shortJson(message.result)}, ` +
          `which is not a ${waiting.method} answer`,
      );
      return;
    }
    delete this.pending[message.id];
    waiting.resolve(checked.data);
  }

  /** End the session from this side: every waiting call is rejected with
   *  `DebuggerDetached` through the channel's close, and the program runs
   *  on without a debugger. */
  private failSession(reason: string): void {
    this.warn(`[agency debug] ${reason}; detaching`);
    this.channel.close();
    this.closeAll();
  }

  /** Every call still waiting is told the other side is gone. */
  private closeAll(): void {
    this.closed = true;
    const waiting = Object.values(this.pending);
    this.pending = {};
    for (const entry of waiting) {
      entry.reject(new DebuggerDetached());
    }
  }

  /** A request keeps the process alive until its reply: the program is
   *  stopped, waiting on the debugger, and may hold no other handle. */
  private request(method: RequestMethod, args: unknown[]): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new DebuggerDetached());
    }
    const id = this.nextId++;
    this.channel.keepAlive(true);
    return new Promise((resolve, reject) => {
      this.pending[id] = { method, resolve, reject };
      this.channel.send({ type: "request", id, method, args });
    }).finally(() => {
      if (Object.keys(this.pending).length === 0) {
        this.channel.keepAlive(false);
      }
    });
  }

  private notice(method: NoticeMethod, args: unknown[]): void {
    if (this.closed) {
      return;
    }
    this.channel.send({ type: "notice", method, args });
  }

  log(line: string): void {
    this.notice("log", [line]);
  }

  setMode(mode: DebuggerMode): void {
    this.notice("setMode", [mode]);
  }

  setPending(preview: PendingPreview): void {
    this.notice("setPending", [preview]);
  }

  setBusy(entries: BusyEntry[]): void {
    this.notice("setBusy", [entries]);
  }

  onPause(listener: () => void): void {
    this.pauseListeners.push(listener);
  }

  async render(checkpoint?: Checkpoint, stop?: DebugStopData, interruptId?: string): Promise<void> {
    await this.request("render", [
      checkpoint === undefined ? undefined : checkpointToWire(checkpoint),
      stop,
      interruptId,
    ]);
  }

  async waitForCommand(): Promise<DebuggerCommand> {
    return (await this.request("waitForCommand", [])) as DebuggerCommand;
  }

  async showRewindSelector(checkpoints: Checkpoint[]): Promise<number | null> {
    return (await this.request("showRewindSelector", [checkpoints.map(checkpointToWire)])) as
      number | null;
  }

  async answerGuardTrip(data: GuardTripData): Promise<InterruptResponse> {
    return (await this.request("answerGuardTrip", [data])) as InterruptResponse;
  }

  async showCheckpointsPanel(checkpoints: Checkpoint[]): Promise<void> {
    await this.request("showCheckpointsPanel", [checkpoints.map(checkpointToWire)]);
  }

  async promptForNodeArgs(parameters: FunctionParameter[]): Promise<unknown[]> {
    return (await this.request("promptForNodeArgs", [parameters])) as unknown[];
  }

  async promptForInput(prompt: string): Promise<string> {
    return (await this.request("promptForInput", [prompt])) as string;
  }

  appendStdout(text: string): void {
    this.notice("appendStdout", [text]);
  }

  renderActivityOnly(): void {
    this.notice("renderActivityOnly", []);
  }

  startSpinner(): void {
    this.notice("startSpinner", []);
  }

  stopSpinner(): void {
    this.notice("stopSpinner", []);
  }

  /** The UI at the other end outlives any one call; closing the channel
   *  is how the session ends. */
  destroy(): void {}
}
