import * as fs from "fs";
import * as path from "path";

import type { z } from "zod";

import { canonicalize } from "@/utils/canonicalize.js";

import type { DeepReadonly } from "./types.js";

/**
 * Corruption in the label dataset is a hard failure, never a warning.
 *
 * `lib/eval/readRun.ts` degrades one bad file and continues, because grading
 * happens after every agent has already been paid for and one unreadable
 * record must not waste the whole pass. Nothing here has that excuse: these
 * rows are human judgements and no rerun regenerates them.
 */
export class LabelDatasetCorruptionError extends Error {}

export type OpenJsonlArgs<Value> = {
  filePath: string;
  schema: z.ZodType<Value>;
  /** What makes two rows the same row, for replay and conflict detection. */
  identityOf(value: Value): string;
};

export type OpenedJsonl<Value> = {
  rows(): readonly DeepReadonly<Value>[];
  /**
   * The row with this identity, if the log holds one.
   *
   * Exposed so callers that need "already present?" reuse the index this log
   * already maintains. A second index built outside would be a second owner of
   * the same question, free to disagree with this one.
   */
  find(identity: string): DeepReadonly<Value> | undefined;
  /**
   * The row with this identity, or the one `build` produces, appended.
   *
   * Distinct from `appendExact`, which compares content and throws when it
   * differs. A log whose rows carry a field outside their identity, such as a
   * capture time or an observation time, cannot use that: rebuilding the row
   * tomorrow yields the same identity with a different timestamp, and
   * `appendExact` would call a legitimate re-ingest corruption. Here the stored
   * row wins and the rebuilt one is discarded.
   */
  findOrAppend(identity: string, build: () => Value): { row: Value; added: boolean };
  /**
   * Append unless this exact row is already present.
   *
   * `"replayed"` means the identity is present and the content matches
   * byte-for-byte after canonicalization, which is what a retried commit looks
   * like. A matching identity with different content is a bug, not a retry,
   * and throws.
   */
  appendExact(value: Value): "appended" | "replayed";
};

/**
 * Read, validate and index a JSONL log once; afterwards replay checks and
 * appends are O(1).
 *
 * The naive alternative — re-reading the file to decide whether a row is
 * already present — is quadratic over a session, and a labelling session is
 * exactly the workload that would notice.
 */
export function openJsonlStrict<Value>(args: OpenJsonlArgs<Value>): OpenedJsonl<Value> {
  const loaded = readAll(args);
  const canonicalById: Record<string, string> = Object.create(null);
  const rowById: Record<string, Value> = Object.create(null);
  for (let index = 0; index < loaded.length; index += 1) {
    const identity = args.identityOf(loaded[index]);
    const canonical = canonicalize(loaded[index]);
    const existing = canonicalById[identity];
    // A duplicate identity already on disk is corruption either way: appendExact
    // replays rather than writing a second copy, so no correct writer produces
    // one. Detecting it only on append would let an already-broken file load
    // clean and then be labelled against.
    if (existing !== undefined) {
      throw new LabelDatasetCorruptionError(
        `${args.filePath}: line ${index + 1} repeats identity "${identity}" ` +
          `${existing === canonical ? "with identical content" : "with different content"}. ` +
          `Each identity may appear once; remove the later line.`,
      );
    }
    canonicalById[identity] = canonical;
    rowById[identity] = loaded[index];
  }

  return {
    rows(): readonly DeepReadonly<Value>[] {
      return loaded as readonly DeepReadonly<Value>[];
    },

    find(identity: string): DeepReadonly<Value> | undefined {
      return rowById[identity] as DeepReadonly<Value> | undefined;
    },

    findOrAppend(identity: string, build: () => Value): { row: Value; added: boolean } {
      const existing = rowById[identity];
      if (existing !== undefined) {
        return { row: existing, added: false };
      }
      const row = build();
      this.appendExact(row);
      return { row, added: true };
    },

    appendExact(value: Value): "appended" | "replayed" {
      const validated = args.schema.parse(value);
      const identity = args.identityOf(validated);
      const canonical = canonicalize(validated);
      const existing = canonicalById[identity];

      if (existing !== undefined) {
        if (existing === canonical) {
          return "replayed";
        }
        throw new LabelDatasetCorruptionError(
          `${args.filePath}: "${identity}" already exists with different content. ` +
            `An identity may be reused only to replay an identical row.`,
        );
      }

      fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
      appendDurably(args.filePath, `${JSON.stringify(validated)}\n`);
      loaded.push(validated);
      canonicalById[identity] = canonical;
      rowById[identity] = validated;
      return "appended";
    },
  };
}

function readAll<Value>(args: OpenJsonlArgs<Value>): Value[] {
  if (!fs.existsSync(args.filePath)) {
    return [];
  }
  const raw = fs.readFileSync(args.filePath, "utf8");
  if (raw.length === 0) {
    return [];
  }
  // A file that does not end in a newline was cut off mid-append. Reading the
  // rows before it would look fine and silently drop the torn one.
  if (!raw.endsWith("\n")) {
    throw new LabelDatasetCorruptionError(
      `${args.filePath}: the file does not end in a newline, which means an append was ` +
        `interrupted. The last line is incomplete — remove it and every earlier row is intact.`,
    );
  }

  const lines = raw.split("\n");
  const rows: Value[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0) {
      continue;
    }
    rows.push(parseLine(args, line, index + 1));
  }
  return rows;
}

function parseLine<Value>(args: OpenJsonlArgs<Value>, line: string, lineNumber: number): Value {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new LabelDatasetCorruptionError(
      `${args.filePath}: line ${lineNumber} is not valid JSON (${(error as Error).message}). ` +
        `Repair it by hand — this file holds human judgements and nothing regenerates them.`,
    );
  }
  const result = args.schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new LabelDatasetCorruptionError(
      `${args.filePath}: line ${lineNumber} does not match the expected row shape (${detail}).`,
    );
  }
  return result.data;
}

/**
 * Append and flush to disk before returning.
 *
 * `appendFileSync` returns once the write reaches the OS page cache, not the
 * device. Without the fsync, a power loss can lose an annotation the tool
 * already told the person was recorded — and this dataset exists precisely
 * because those judgements cannot be regenerated.
 */
export function appendDurably(filePath: string, line: string): void {
  const handle = fs.openSync(filePath, "a");
  try {
    fs.writeSync(handle, line);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Flush a directory entry, so a rename or creation survives a power loss.
 *
 * Renaming is atomic with respect to readers, but the directory entry itself
 * sits in cache until it is synced. Failures to open a directory for sync are
 * ignored: some platforms and filesystems refuse it, and that is not a reason
 * to fail a write that otherwise succeeded.
 */
export function syncDirectory(directoryPath: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(directoryPath, "r");
    fs.fsyncSync(handle);
  } catch {
    // Directory fsync is unsupported on some platforms; the rename still
    // happened, and there is nothing further this layer can do about it.
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
}

export type AtomicWriteArgs<Value> = {
  targetPath: string;
  value: Value;
  schema: z.ZodType<Value>;
};

/**
 * Validate, then replace a whole file atomically.
 *
 * A plain write truncates before it writes, so a crash part-way leaves a file
 * that is neither the old content nor the new. Writing a uniquely named
 * temporary and renaming means a reader always sees one or the other. The temp
 * name carries the pid so two processes cannot collide on it.
 */
export function atomicWriteValidated<Value>(args: AtomicWriteArgs<Value>): void {
  const validated = args.schema.parse(args.value);
  fs.mkdirSync(path.dirname(args.targetPath), { recursive: true });
  const temporaryPath = `${args.targetPath}.${process.pid}.tmp`;

  // Flush the temp file's contents before the rename: renaming a file whose
  // bytes are still in cache can publish an empty or partial file.
  const handle = fs.openSync(temporaryPath, "w");
  try {
    fs.writeSync(handle, `${JSON.stringify(validated, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporaryPath, args.targetPath);
    syncDirectory(path.dirname(args.targetPath));
  } catch (renameError) {
    // Report the cleanup failure alongside the real one rather than letting
    // either hide the other.
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `Failed to write ${args.targetPath} (${(renameError as Error).message}) and failed to ` +
          `remove ${temporaryPath} (${(cleanupError as Error).message})`,
      );
    }
    throw renameError;
  }
}
