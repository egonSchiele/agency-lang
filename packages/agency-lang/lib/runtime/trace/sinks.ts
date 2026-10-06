import type { TraceCallback, TraceLine } from "./types.js";

export type TraceSink = {
  writeLine(line: TraceLine): Promise<void> | void;
  close?(): Promise<void> | void;
  /** What this sink already holds from an earlier writer in the same run,
   *  so the new writer skips a second header and the chunks already
   *  there. A sink that keeps nothing leaves this out. */
  existing?(): Promise<{ hasHeader: boolean; chunkHashes: Set<string> }>;
};

// FileSink is in fileSink.ts, which is Node-only.

export class CallbackSink implements TraceSink {
  private callback: TraceCallback;
  private runId: string;

  constructor(runId: string, callback: TraceCallback) {
    this.runId = runId;
    this.callback = callback;
  }

  async writeLine(line: TraceLine): Promise<void> {
    await this.callback({ runId: this.runId, line });
  }
}
