import * as fs from "fs";
import * as path from "path";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import type { TraceHeader, TraceManifest, CheckpointJSON } from "./types.js";
import { CHECKPOINT_SCHEMA } from "./types.js";
import { Checkpoint } from "../state/checkpointStore.js";

export class TraceReader {
  readonly header: TraceHeader;
  readonly checkpoints: Checkpoint[];
  readonly sources: Record<string, string>;

  private constructor(
    header: TraceHeader,
    checkpoints: Checkpoint[],
    sources: Record<string, string>,
  ) {
    this.header = header;
    this.checkpoints = checkpoints;
    this.sources = sources;
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
    const sources: Record<string, string> = {};

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      switch (line.type) {
        case "chunk":
          store.loadChunks({ [line.hash]: line.data });
          break;
        case "manifest":
          manifests.push(line as TraceManifest);
          break;
        case "source":
          sources[line.path] = line.content;
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

    return new TraceReader(header, checkpoints, sources);
  }

  writeSourcesToDisk(dir: string): void {
    const baseDir = path.resolve(dir);
    for (const [filePath, content] of Object.entries(this.sources)) {
      if (path.isAbsolute(filePath)) {
        throw new Error(`Invalid source path: absolute paths not allowed: ${filePath}`);
      }
      const fullPath = path.resolve(baseDir, filePath);
      if (!fullPath.startsWith(baseDir + path.sep)) {
        throw new Error(`Invalid source path: escapes target directory: ${filePath}`);
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }
}
