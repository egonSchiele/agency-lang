import * as fs from "fs";
import type { TraceLine, TraceEvent } from "./types.js";

export type TraceSink = {
  writeLine(line: TraceLine): Promise<void> | void;
  close?(): Promise<void> | void;
};

export class FileSink implements TraceSink {
  private stream: fs.WriteStream;

  constructor(filePath: string) {
    this.stream = fs.createWriteStream(filePath, { flags: "w", encoding: "utf-8" });
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
  private callback: (event: TraceEvent) => void | Promise<void>;
  private executionId: string;

  constructor(executionId: string, callback: (event: TraceEvent) => void | Promise<void>) {
    this.executionId = executionId;
    this.callback = callback;
  }

  async writeLine(line: TraceLine): Promise<void> {
    await this.callback({ executionId: this.executionId, line });
  }
}
