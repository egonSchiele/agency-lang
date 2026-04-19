import { VERSION } from "../../version.js";
import type { Checkpoint } from "../state/checkpointStore.js";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import { CallbackSink, FileSink, type TraceSink } from "./sinks.js";
import type { TraceConfig, TraceLine, TraceManifest } from "./types.js";
import { CHECKPOINT_SCHEMA } from "./types.js";

export class TraceWriter {
  private store: ContentAddressableStore;
  private sinks: TraceSink[];
  private checkpointCount = 0;
  private chunkCount = 0;
  private program: string = "";
  private runId: string = "";

  constructor(runId: string, program: string, sinks: TraceSink[]) {
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
    program,
    traceConfig,
  }: {
    runId: string;
    program: string;
    traceConfig: TraceConfig;
  }): Promise<TraceWriter> {
    const sinks: TraceSink[] = [];
    if (traceConfig.traceFile) {
      sinks.push(new FileSink(traceConfig.traceFile));
    }
    if (traceConfig.traceDir) {
      const filePath = `${traceConfig.traceDir}/trace-${Date.now()}.trace`;
      sinks.push(new FileSink(filePath));
    }
    if (traceConfig.traceCallback) {
      sinks.push(new CallbackSink(runId, traceConfig.traceCallback));
    }
    const writer = new TraceWriter(runId, program, sinks);
    await writer.writeHeader();
    return writer;
  }
}
