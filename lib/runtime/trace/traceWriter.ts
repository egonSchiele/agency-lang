import * as fs from "fs";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import type { TraceManifest } from "./types.js";
import { CHECKPOINT_SCHEMA } from "./types.js";
import type { Checkpoint } from "../state/checkpointStore.js";

export class TraceWriter {
  private fd: number;
  private store: ContentAddressableStore;
  private checkpointCount = 0;

  constructor(filePath: string, program: string) {
    this.fd = fs.openSync(filePath, "w");
    this.store = new ContentAddressableStore();
    this.writeLine({
      type: "header",
      version: 1,
      program,
      timestamp: new Date().toISOString(),
      config: { hashAlgorithm: "sha256" },
    });
  }

  writeCheckpoint(checkpoint: Checkpoint): void {
    const json = checkpoint.toJSON();
    const { record, chunks } = this.store.process(json, CHECKPOINT_SCHEMA);

    for (const chunk of chunks) {
      this.writeLine({ type: "chunk", hash: chunk.hash, data: chunk.data });
    }

    const manifest: TraceManifest = { type: "manifest", ...record };
    this.writeLine(manifest);
    this.checkpointCount++;
  }

  private writeLine(obj: any): void {
    fs.writeSync(this.fd, JSON.stringify(obj) + "\n");
  }
}
