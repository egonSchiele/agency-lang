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

export class TraceWriter {
  private store: ContentAddressableStore;
  private sinks: TraceSink[];
  private checkpointCount = 0;
  private chunkCount = 0;
  private program: string = "";
  private runId: string = "";

  constructor(runId: string, program: string, sinks: TraceSink[]) {
    // Per-writer CAS. Cross-segment dedup is intentionally not done — it
    // would require shared state on the parent ctx (broken for concurrent
    // runs) or in globals (extra serialization overhead). The trade-off is
    // that some chunks may be duplicated across segments in the file; the
    // reader handles duplicates idempotently via loadChunks, so correctness
    // is unaffected. Files are slightly larger but readable and concurrency
    // -safe.
    this.store = new ContentAddressableStore();
    this.sinks = sinks;
    this.runId = runId;
    this.program = program;
  }

  async writeHeader(): Promise<void> {
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
    const writer = new TraceWriter(runId, traceConfig.program || "unknown.agency", sinks);
    await writer.writeHeader();
    return writer;
  }
}
