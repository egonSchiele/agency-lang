import * as fs from "fs";
import * as path from "path";

import type { z } from "zod";

import { canonicalize } from "@/utils/canonicalize.js";

import type { DeepReadonly } from "./types.js";

/**
 * Corruption in the label store is a hard failure, never a warning.
 *
 * `lib/eval/readRun.ts` degrades one bad file and continues, because grading
 * happens after every agent has already been paid for and one unreadable
 * record must not waste the whole pass. Nothing here has that excuse: these
 * rows are human judgements and no rerun regenerates them.
 */
export class LabelStoreCorruptionError extends Error {}

export type OpenJsonlArgs<Value> = {
  filePath: string;
  schema: z.ZodType<Value>;
  /** What makes two rows the same row, for replay and conflict detection. */
  identityOf(value: Value): string;
};

export type OpenedJsonl<Value> = {
  rows(): readonly DeepReadonly<Value>[];
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
  for (const row of loaded) {
    canonicalById[args.identityOf(row)] = canonicalize(row);
  }

  return {
    rows(): readonly DeepReadonly<Value>[] {
      return loaded as readonly DeepReadonly<Value>[];
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
        throw new LabelStoreCorruptionError(
          `${args.filePath}: "${identity}" already exists with different content. ` +
          `An identity may be reused only to replay an identical row.`,
        );
      }

      fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
      fs.appendFileSync(args.filePath, `${JSON.stringify(validated)}\n`);
      loaded.push(validated);
      canonicalById[identity] = canonical;
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
    throw new LabelStoreCorruptionError(
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
    throw new LabelStoreCorruptionError(
      `${args.filePath}: line ${lineNumber} is not valid JSON (${(error as Error).message}). ` +
      `Repair it by hand — this file holds human judgements and nothing regenerates them.`,
    );
  }
  const result = args.schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new LabelStoreCorruptionError(
      `${args.filePath}: line ${lineNumber} does not match the expected row shape (${detail}).`,
    );
  }
  return result.data;
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

  fs.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { flag: "w" });
  try {
    fs.renameSync(temporaryPath, args.targetPath);
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
