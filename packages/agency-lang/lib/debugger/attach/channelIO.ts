// The run side's `DebuggerIO`: every method becomes a message on the
// channel, and a method that expects an answer waits for the reply with
// its id. The driver in the program's process sees an ordinary
// `DebuggerIO`; the person at the other end sees the terminal UI.
import { nativeTypeReplacer } from "../../runtime/revivers/index.js";
import type { InterruptResponse } from "../../runtime/interrupts.js";
import type { DebugStopData } from "../../runtime/debugger.js";
import type { Checkpoint } from "../../runtime/state/checkpointStore.js";
import type { FunctionParameter } from "../../types.js";
import type { GuardTripData } from "../guardAnswer.js";
import {
  DebuggerDetached,
  type DebuggerCommand,
  type DebuggerIO,
  type DebuggerMode,
} from "../types.js";
import type { Channel } from "./channel.js";
import { parseAttachMessage, type NoticeMethod, type RequestMethod } from "./protocol.js";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

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

export class ChannelDebuggerIO implements DebuggerIO {
  private nextId = 0;
  private pending: Record<number, Pending> = {};
  private closed = false;

  constructor(private readonly channel: Channel) {
    channel.onMessage((raw) => this.receive(raw));
    channel.onClose(() => this.closeAll());
  }

  private receive(raw: unknown): void {
    const message = parseAttachMessage(raw);
    if (message === null || message.type !== "reply") {
      return;
    }
    const waiting = this.pending[message.id];
    if (waiting === undefined) {
      return;
    }
    delete this.pending[message.id];
    if (message.error !== undefined) {
      waiting.reject(new Error(message.error));
    } else {
      waiting.resolve(message.result);
    }
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

  private request(method: RequestMethod, args: unknown[]): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new DebuggerDetached());
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending[id] = { resolve, reject };
      this.channel.send({ type: "request", id, method, args });
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

  setOverrides(overrides: Record<string, unknown>): void {
    this.notice("setOverrides", [overrides]);
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
