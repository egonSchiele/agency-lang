import fs from "fs";
import path from "path";
import { VERSION } from "../../version.js";
import type { Checkpoint } from "../state/checkpointStore.js";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import { CallbackSink, FileSink, type TraceSink } from "./sinks.js";
import type { TraceConfig, TraceLine, TraceManifest } from "./types.js";
import { CHECKPOINT_SCHEMA } from "./types.js";

/**
 * Decide which file (if any) a trace writer should target for a given run.
 *
 * - `traceFile` set: use it verbatim. This is a fixed, process-wide path —
 *   useful for tests and single-run inspection, but NOT safe with concurrent
 *   runs of the same agent (they'd interleave into one file). Documented.
 * - `traceFile` unset, `traceDir` set: derive `${traceDir}/${runId}.agencytrace`.
 *   Each run gets its own file, naturally supporting concurrent runs without
 *   any shared state.
 * - Neither set: returns null (no file output; callback-only or disabled).
 */
export function resolveTraceFilePath(
  traceConfig: TraceConfig,
  runId: string,
): string | null {
  if (traceConfig.traceFile) return traceConfig.traceFile;
  if (traceConfig.traceDir) return path.join(traceConfig.traceDir, `${runId}.agencytrace`);
  return null;
}

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
 */
export function scanExistingTraceFile(filePath: string): {
  hasHeader: boolean;
  chunkHashes: Set<string>;
} {
  const empty = { hasHeader: false, chunkHashes: new Set<string>() };
  if (!fs.existsSync(filePath)) return empty;
  const content = fs.readFileSync(filePath, "utf-8");
  if (content.trim() === "") return empty;

  let hasHeader = false;
  const chunkHashes = new Set<string>();
  for (const line of content.split("\n")) {
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

export class TraceWriter {
  private store: ContentAddressableStore;
  private sinks: TraceSink[];
  private checkpointCount = 0;
  private chunkCount = 0;
  private program: string = "";
  private runId: string = "";
  private headerWritten = false;

  constructor(
    runId: string,
    program: string,
    sinks: TraceSink[],
    options: { seenHashes?: Set<string>; headerWritten?: boolean } = {},
  ) {
    // Per-writer CAS, but seeded with hashes already on disk from prior
    // writers in the same run. This gives cross-segment dedup without
    // putting any shared state on the parent ctx — each new writer
    // independently scans the file (see `scanExistingTraceFile` /
    // `TraceWriter.create`) and seeds itself.
    this.store = new ContentAddressableStore();
    if (options.seenHashes && options.seenHashes.size > 0) {
      this.store.seedSeenHashes(options.seenHashes);
    }
    this.sinks = sinks;
    this.runId = runId;
    this.program = program;
    this.headerWritten = options.headerWritten ?? false;
  }

  async writeHeader(): Promise<void> {
    // Idempotent: at most one `header` line per writer. Combined with the
    // file-scan in `create()`, the file ends up with exactly one header
    // (the first writer's), which is what `TraceReader` requires
    // (`lines[0].type === "header"`).
    if (this.headerWritten) return;
    this.headerWritten = true;
    await this.writeLine({
      type: "header",
      version: 1,
      agencyVersion: VERSION,
      program: this.program,
      timestamp: new Date().toISOString(),
      config: { hashAlgorithm: "sha256" },
      runId: this.runId,
    });
  }

  async writeStaticState(values: Record<string, unknown>): Promise<void> {
    await this.writeLine({
      type: "static-state",
      values,
    });
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.writeHeader();
    const json = checkpoint.toJSON();
    const { record, chunks } = this.store.process(json, CHECKPOINT_SCHEMA);

    for (const chunk of chunks) {
      await this.writeLine({
        type: "chunk",
        hash: chunk.hash,
        data: chunk.data,
      });
      this.chunkCount++;
    }

    const manifest: TraceManifest = { type: "manifest", ...record };
    await this.writeLine(manifest);
    this.checkpointCount++;
  }

  /** Flush and close all sinks without emitting a footer.
   *  Used when execution is pausing for an interrupt. */
  async pause(): Promise<void> {
    await this.writeHeader();
    for (const sink of this.sinks) {
      try {
        await sink.close?.();
      } catch (error) {
        console.error("[agency] Error closing trace sink:", error);
      }
    }
  }

  /** Emit a footer and close all sinks.
   *  Used when the agent run is truly finished. */
  async close(): Promise<void> {
    await this.writeHeader();
    await this.writeLine({
      type: "footer",
      checkpointCount: this.checkpointCount,
      chunkCount: this.chunkCount,
      timestamp: new Date().toISOString(),
    });
    await this.pause();
  }

  private async writeLine(obj: TraceLine): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.writeLine(obj);
      } catch (error) {
        console.error("[agency] Trace sink error:", error);
      }
    }
  }



  static async create({
    runId,
    traceConfig,
  }: {
    runId: string;
    traceConfig: TraceConfig;
  }): Promise<TraceWriter | null> {
    const sinks: TraceSink[] = [];
    const filePath = resolveTraceFilePath(traceConfig, runId);
    if (filePath) {
      sinks.push(new FileSink(filePath));
    }
    if (traceConfig.traceCallback) {
      sinks.push(new CallbackSink(runId, traceConfig.traceCallback));
    }
    if (sinks.length === 0) {
      return null;
    }

    // Scan the existing trace file (if any) so this writer can seed its CAS
    // with hashes already on disk from prior writers in the same run, and
    // skip writing a duplicate header. `runNode` truncates the file at the
    // start of every fresh run, so this only ever sees state from earlier
    // execCtxs within the same run (e.g. across `respondToInterrupts`).
    const scan = filePath
      ? scanExistingTraceFile(filePath)
      : { hasHeader: false, chunkHashes: new Set<string>() };

    const writer = new TraceWriter(
      runId,
      traceConfig.program || "unknown.agency",
      sinks,
      { seenHashes: scan.chunkHashes, headerWritten: scan.hasHeader },
    );
    await writer.writeHeader();
    return writer;
  }
}
