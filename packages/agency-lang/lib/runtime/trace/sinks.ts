import * as fs from "fs";
import type { TraceCallback, TraceLine } from "./types.js";
import path from "path";

export type TraceSink = {
  writeLine(line: TraceLine): Promise<void> | void;
  close?(): Promise<void> | void;
};

export class FileSink implements TraceSink {
  private stream: fs.WriteStream;

  // Append mode: a single logical run can produce multiple TraceWriters
  // (one per execCtx — i.e. one per respondToInterrupts call). Truncating
  // would lose data from previous segments. Truncation of the trace file
  // at the start of a run happens explicitly in RuntimeContext (and in
  // the __setTraceFile helper).
  constructor(filePath: string) {
    this.createDirIfNotExists(path.dirname(filePath));
    this.stream = fs.createWriteStream(filePath, {
      flags: "a",
      encoding: "utf-8",
    });
  }

  createDirIfNotExists(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    } else if (!fs.statSync(dirPath).isDirectory()) {
      throw new Error(`Path ${dirPath} exists and is not a directory`);
    }
  }

  writeLine(line: TraceLine): Promise<void> {
    return new Promise((resolve, reject) => {
      const ok = this.stream.write(JSON.stringify(line) + "\n");
      if (ok) {
        resolve();
      } else {
        this.stream.once("drain", resolve);
        this.stream.once("error", reject);
      }
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end(() => resolve());
      this.stream.once("error", reject);
    });
  }
}

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
