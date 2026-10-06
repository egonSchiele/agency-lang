// The trace sink that writes to a file, and the scan of an existing trace
// file that a new writer in the same run seeds itself from. Node-only: the
// other sinks, and the writer, are in sinks.ts and traceWriter.ts and
// reach the browser.
import * as fs from "fs";
import path from "path";
import readline from "readline";
import type { TraceSink } from "./sinks.js";
import type { TraceLine } from "./types.js";

export class FileSink implements TraceSink {
  private filePath: string;

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
    this.filePath = filePath;
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

  /** What an earlier writer in this run already put in the file. */
  existing(): Promise<ExistingTrace> {
    return scanExistingTraceFile(this.filePath);
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

/** What a sink already holds from an earlier writer in the same run. */
export type ExistingTrace = { hasHeader: boolean; chunkHashes: Set<string> };

/**
 * Scan an existing trace file to learn what a prior writer in the same run
 * already emitted, so that a freshly-constructed `TraceWriter` can avoid
 * writing a duplicate header or re-emitting chunks that are already on disk.
 *
 * Best-effort: malformed lines (e.g. a partial JSON line from a crashed prior
 * writer) are skipped, not propagated. Returns `{ hasHeader: false,
 * chunkHashes: new Set() }` for empty or non-existent files. Only `header` and
 * `chunk` line types affect the result; other types (`source`, `static-state`,
 * `manifest`, `footer`) are ignored — they don't need cross-writer dedup
 * because either they're never emitted at runtime (`source`) or they're
 * already gated to once per run elsewhere (`static-state` via
 * `globals.markInitialized`; `manifest`/`footer` are per-checkpoint /
 * per-close events that shouldn't be deduped).
 *
 * Uses streaming line I/O (`createReadStream` + `readline`) so peak memory
 * stays at roughly one line, not the full file content. Each parsed chunk
 * line becomes GC-eligible after we extract its `hash` — the chunk's `data`
 * payload (potentially large) is never retained.
 */
export async function scanExistingTraceFile(filePath: string): Promise<{
  hasHeader: boolean;
  chunkHashes: Set<string>;
}> {
  const empty = { hasHeader: false, chunkHashes: new Set<string>() };
  if (!fs.existsSync(filePath)) return empty;

  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let hasHeader = false;
  const chunkHashes = new Set<string>();
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let parsed: TraceLine;
    try {
      parsed = JSON.parse(line) as TraceLine;
    } catch {
      // Partial / corrupt line from a crashed writer — skip and keep going.
      continue;
    }
    if (parsed.type === "header") {
      hasHeader = true;
    } else if (parsed.type === "chunk" && typeof parsed.hash === "string") {
      chunkHashes.add(parsed.hash);
    }
  }
  return { hasHeader, chunkHashes };
}
