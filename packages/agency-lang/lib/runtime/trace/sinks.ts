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
  // at the start of a fresh run is handled by `runNode` via
  // `resolveTraceFilePath` + `fs.writeFileSync(path, "")`. Resume paths
  // (respondToInterrupts) never truncate, so per-execCtx writers within
  // one run accumulate into the same file naturally. Cross-segment
  // header/chunk dedup is implemented in `TraceWriter.create` via
  // `scanExistingTraceFile`, which reads the on-disk state and seeds the
  // new writer's CAS + header flag — no shared in-memory state on the
  // parent ctx, so concurrent runs (each writing to a distinct
  // `${runId}.agencytrace` file in `traceDir` mode) never collide.
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
        return;
      }
      // Back-pressure path: wait for drain. We register listeners
      // for BOTH `drain` and `error` and pair them so whichever
      // fires also removes the other. Without the pairing, the
      // `once("error", ...)` listener stays attached forever after
      // a successful drain — and on a long-running agent with many
      // writes, error listeners accumulate until Node emits
      // `MaxListenersExceededWarning: 11 error listeners added to
      // [WriteStream]`.
      const onDrain = () => {
        this.stream.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.stream.removeListener("drain", onDrain);
        reject(err);
      };
      this.stream.once("drain", onDrain);
      this.stream.once("error", onError);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Same listener-leak shape as `writeLine` — pair `end`'s
      // success callback with the `error` listener so the loser is
      // removed. `close` is normally called once, but pairing keeps
      // the contract uniform and avoids a stale error listener if
      // the FileSink is reused.
      const onError = (err: Error) => reject(err);
      this.stream.once("error", onError);
      this.stream.end(() => {
        this.stream.removeListener("error", onError);
        resolve();
      });
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
