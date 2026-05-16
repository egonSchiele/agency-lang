import * as crypto from "crypto";
import { canonicalize } from "./canonicalize.js";

export type CASSchema = {
  [key: string]: true | CASSchema;
};

export type CASResult<T, S extends CASSchema> = {
  [K in keyof T]: K extends keyof S
    ? S[K] extends true
      ? T[K] extends any[]
        ? string[]
        : T[K] extends Record<string, any>
          ? Record<string, string>
          : string
      : S[K] extends CASSchema
        ? CASResult<T[K], S[K]>
        : T[K]
    : T[K]
};

export type Chunk = {
  hash: string;
  data: any;
};

export class ContentAddressableStore {
  private seenHashes: Set<string> = new Set();
  private chunkData: Record<string, any> = {};

  process<T, S extends CASSchema>(
    record: T,
    schema: S,
  ): { record: CASResult<T, S>; chunks: Chunk[] } {
    const chunks: Chunk[] = [];
    const result = this.walk(record, schema, chunks);
    return { record: result as CASResult<T, S>, chunks };
  }

  reconstruct<T>(record: any, schema: CASSchema): T {
    return this.walkReverse(record, schema) as T;
  }

  loadChunks(chunks: Record<string, any>): void {
    for (const [hash, data] of Object.entries(chunks)) {
      this.seenHashes.add(hash);
      this.chunkData[hash] = data;
    }
  }

  /**
   * Seed the set of hashes that should be treated as already-emitted, without
   * loading their chunk data. Used by `TraceWriter` when it scans an existing
   * trace file at construction time so that subsequent `process()` calls don't
   * re-emit chunks that prior writers in the same run already wrote. Unlike
   * `loadChunks`, this does NOT populate `chunkData` (the writer never needs to
   * reconstruct values, only check whether to emit them), keeping memory low
   * for long traces.
   */
  seedSeenHashes(hashes: Set<string>): void {
    for (const h of hashes) this.seenHashes.add(h);
  }

  private walk(data: any, schema: CASSchema, chunks: Chunk[]): any {
    if (data === null || data === undefined) return data;
    const result = Array.isArray(data) ? [...data] : { ...data };

    for (const key of Object.keys(schema)) {
      if (!(key in data)) continue;
      const schemaValue = schema[key];

      if (schemaValue === true) {
        const val = data[key];
        if (Array.isArray(val)) {
          result[key] = val.map((item: any) => this.hashAndStore(item, chunks));
        } else if (typeof val === "object" && val !== null) {
          const hashed: Record<string, string> = {};
          for (const k of Object.keys(val)) {
            hashed[k] = this.hashAndStore(val[k], chunks);
          }
          result[key] = hashed;
        } else {
          result[key] = this.hashAndStore(val, chunks);
        }
      } else {
        result[key] = this.walk(data[key], schemaValue, chunks);
      }
    }

    return result;
  }

  private walkReverse(data: any, schema: CASSchema): any {
    if (data === null || data === undefined) return data;
    const result = Array.isArray(data) ? [...data] : { ...data };

    for (const key of Object.keys(schema)) {
      if (!(key in data)) continue;
      const schemaValue = schema[key];

      if (schemaValue === true) {
        const val = data[key];
        if (Array.isArray(val)) {
          result[key] = val.map((hash: string) => this.chunkData[hash]);
        } else if (typeof val === "object" && val !== null) {
          const resolved: Record<string, any> = {};
          for (const k of Object.keys(val)) {
            resolved[k] = this.chunkData[val[k]];
          }
          result[key] = resolved;
        } else {
          result[key] = this.chunkData[val];
        }
      } else {
        result[key] = this.walkReverse(data[key], schemaValue);
      }
    }

    return result;
  }

  private hashAndStore(value: any, chunks: Chunk[]): string {
    const canonical = canonicalize(value);
    const hash = crypto
      .createHash("sha256")
      .update(canonical)
      .digest("hex")
      .slice(0, 16);

    if (!this.seenHashes.has(hash)) {
      this.seenHashes.add(hash);
      this.chunkData[hash] = value;
      chunks.push({ hash, data: value });
    }

    return hash;
  }
}
