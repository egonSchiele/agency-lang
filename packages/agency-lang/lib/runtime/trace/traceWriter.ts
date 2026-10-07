import path from "#path";
import type { HostFiles } from "../../host/host.js";
import { VERSION } from "../../stdlib/version.js";
import type { Checkpoint } from "../state/checkpointStore.js";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import { CallbackSink, type TraceSink } from "./sinks.js";
import { FileSink } from "./fileSink.js";
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
export function resolveTraceFilePath(traceConfig: TraceConfig, runId: string): string | null {
  if (traceConfig.traceFile) return traceConfig.traceFile;
  if (traceConfig.traceDir) return path.join(traceConfig.traceDir, `${runId}.agencytrace`);
  return null;
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

  /** `files` is the file part of the run's host, which the trace file is
   *  written through. A host without `fileWrite` refuses the open here,
   *  while the context is built. */
  static async create({
    runId,
    traceConfig,
    files,
  }: {
    runId: string;
    traceConfig: TraceConfig;
    files: HostFiles;
  }): Promise<TraceWriter | null> {
    const sinks: TraceSink[] = [];
    const filePath = resolveTraceFilePath(traceConfig, runId);
    if (filePath) {
      sinks.push(await FileSink.open(files, filePath));
    }
    if (traceConfig.traceCallback) {
      sinks.push(new CallbackSink(runId, traceConfig.traceCallback));
    }
    if (sinks.length === 0) {
      return null;
    }

    // Ask the sinks what an earlier writer in the same run already put in
    // them, so this writer seeds its CAS with those hashes and skips a
    // duplicate header. `runNode` truncates the file at the start of every
    // fresh run, so this only ever sees state from earlier execCtxs within
    // the same run (e.g. across `respondToInterrupts`).
    const scan = { hasHeader: false, chunkHashes: new Set<string>() };
    for (const sink of sinks) {
      const held = await sink.existing?.();
      if (!held) continue;
      scan.hasHeader = scan.hasHeader || held.hasHeader;
      for (const hash of held.chunkHashes) scan.chunkHashes.add(hash);
    }

    const writer = new TraceWriter(runId, traceConfig.program || "unknown.agency", sinks, {
      seenHashes: scan.chunkHashes,
      headerWritten: scan.hasHeader,
    });
    await writer.writeHeader();
    return writer;
  }
}
