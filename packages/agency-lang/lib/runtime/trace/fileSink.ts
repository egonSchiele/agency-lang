// The trace sink that writes to a file through the host's files, and the
// scan of an existing trace file that a new writer in the same run seeds
// itself from.
import type { AppendableFile, HostFiles, Located } from "../../host/host.js";
import type { TraceSink } from "./sinks.js";
import type { TraceLine } from "./types.js";

export class FileSink implements TraceSink {
  private constructor(
    private files: HostFiles,
    private located: Located,
    private handle: AppendableFile,
  ) {}

  // Append mode: a single logical run can produce multiple TraceWriters
  // (one per execCtx — i.e. one per respondToInterrupts call). Truncating
  // would lose data from previous segments. Truncation of the trace file
  // at the start of a fresh run is handled by `runNode` via
  // `resolveTraceFilePath` and an empty write. Resume paths
  // (respondToInterrupts) never truncate, so per-execCtx writers within
  // one run accumulate into the same file naturally. Cross-segment
  // header/chunk dedup is implemented in `TraceWriter.create` via
  // `existing`, which reads the on-disk state and seeds the new writer's
  // CAS + header flag — no shared in-memory state on the parent ctx, so
  // concurrent runs (each writing to a distinct `${runId}.agencytrace`
  // file in `traceDir` mode) never collide.
  static async open(files: HostFiles, filePath: string): Promise<FileSink> {
    const located = await files.wholePath(filePath);
    const parent = await files.stat(located.root, ".");
    if (parent === null) {
      await files.mkdir(located.root, ".");
    } else if (parent.kind !== "dir") {
      throw new Error(
        `Path ${await files.resolvePath(located.root, ".")} exists and is not a directory`,
      );
    }
    const handle = await files.openForAppend(located.root, located.target);
    return new FileSink(files, located, handle);
  }

  /** What an earlier writer in this run already put in the file. */
  existing(): Promise<ExistingTrace> {
    return scanExistingTraceFile(this.files, this.located);
  }

  async writeLine(line: TraceLine): Promise<void> {
    await this.handle.append(new TextEncoder().encode(JSON.stringify(line) + "\n"));
  }

  close(): Promise<void> {
    return this.handle.close();
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
 * Reads the file in pieces and keeps one line at a time, so peak memory
 * stays at roughly one line, not the full file content. Each parsed chunk
 * line becomes GC-eligible after we extract its `hash` — the chunk's `data`
 * payload (potentially large) is never retained.
 */
export async function scanExistingTraceFile(
  files: HostFiles,
  located: Located,
): Promise<ExistingTrace> {
  const empty = { hasHeader: false, chunkHashes: new Set<string>() };
  if ((await files.stat(located.root, located.target)) === null) {
    return empty;
  }

  let hasHeader = false;
  const chunkHashes = new Set<string>();
  const note = (line: string) => {
    if (line.trim() === "") {
      return;
    }
    let parsed: TraceLine;
    try {
      parsed = JSON.parse(line) as TraceLine;
    } catch {
      // Partial / corrupt line from a crashed writer — skip and keep going.
      return;
    }
    if (parsed.type === "header") {
      hasHeader = true;
    } else if (parsed.type === "chunk" && typeof parsed.hash === "string") {
      chunkHashes.add(parsed.hash);
    }
  };

  const decoder = new TextDecoder();
  let rest = "";
  for await (const piece of files.readChunks(located.root, located.target)) {
    rest += decoder.decode(piece, { stream: true });
    let newline = rest.indexOf("\n");
    while (newline !== -1) {
      note(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
      newline = rest.indexOf("\n");
    }
  }
  rest += decoder.decode();
  note(rest);
  return { hasHeader, chunkHashes };
}
