import { ContentAddressableStore } from "./contentAddressableStore.js";
import type { TraceSink } from "./sinks.js";
import type { TraceManifest } from "./types.js";
import { CHECKPOINT_SCHEMA } from "./types.js";
import type { Checkpoint } from "../state/checkpointStore.js";
import { VERSION } from "../../version.js";

export class TraceWriter {
  private store: ContentAddressableStore;
  private sinks: TraceSink[];
  private checkpointCount = 0;
  private chunkCount = 0;
  private headerPromise: Promise<void>;

  constructor(program: string, sinks: TraceSink[]) {
    this.store = new ContentAddressableStore();
    this.sinks = sinks;
    this.headerPromise = this.writeLine({
      type: "header",
      version: 1,
      agencyVersion: VERSION,
      program,
      timestamp: new Date().toISOString(),
      config: { hashAlgorithm: "sha256" },
    });
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.headerPromise;
    const json = checkpoint.toJSON();
    const { record, chunks } = this.store.process(json, CHECKPOINT_SCHEMA);

    for (const chunk of chunks) {
      await this.writeLine({ type: "chunk", hash: chunk.hash, data: chunk.data });
      this.chunkCount++;
    }

    const manifest: TraceManifest = { type: "manifest", ...record };
    await this.writeLine(manifest);
    this.checkpointCount++;
  }

  async close(): Promise<void> {
    await this.headerPromise;
    await this.writeLine({
      type: "footer",
      checkpointCount: this.checkpointCount,
      chunkCount: this.chunkCount,
      timestamp: new Date().toISOString(),
    });
    for (const sink of this.sinks) {
      try {
        await sink.close?.();
      } catch (error) {
        console.error("[agency] Error closing trace sink:", error);
      }
    }
  }

  private async writeLine(obj: any): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.writeLine(obj);
      } catch (error) {
        console.error("[agency] Trace sink error:", error);
      }
    }
  }
}
