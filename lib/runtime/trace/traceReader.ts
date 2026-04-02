import * as fs from "fs";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import type { TraceHeader, TraceManifest, TraceFooter, CheckpointJSON } from "./types.js";
import { CHECKPOINT_SCHEMA } from "./types.js";
import { Checkpoint } from "../state/checkpointStore.js";

export class TraceReader {
  readonly header: TraceHeader;
  readonly footer: TraceFooter | null;
  readonly checkpoints: Checkpoint[];

  private constructor(
    header: TraceHeader,
    footer: TraceFooter | null,
    checkpoints: Checkpoint[],
  ) {
    this.header = header;
    this.footer = footer;
    this.checkpoints = checkpoints;
  }

  static fromFile(filePath: string): TraceReader {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (content === "") {
      throw new Error("Invalid trace file: empty");
    }

    const lines = content.split("\n").map((line) => JSON.parse(line));

    if (lines.length === 0 || lines[0].type !== "header") {
      throw new Error("Invalid trace file: missing header");
    }

    const header = lines[0] as TraceHeader;
    const store = new ContentAddressableStore();
    const manifests: TraceManifest[] = [];
    let footer: TraceFooter | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      switch (line.type) {
        case "chunk":
          store.loadChunks({ [line.hash]: line.data });
          break;
        case "manifest":
          manifests.push(line as TraceManifest);
          break;
        case "footer":
          footer = line as TraceFooter;
          break;
      }
    }

    const checkpoints = manifests.map((manifest, index) => {
      const { type, ...casProcessed } = manifest;
      const json = store.reconstruct<CheckpointJSON>(casProcessed, CHECKPOINT_SCHEMA);
      const checkpoint = Checkpoint.fromJSON(json);
      if (!checkpoint) {
        throw new Error(
          `Invalid trace file: failed to reconstruct checkpoint at manifest index ${index}`,
        );
      }
      return checkpoint;
    });

    return new TraceReader(header, footer, checkpoints);
  }
}
