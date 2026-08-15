import * as fs from "fs";
import * as path from "path";

import { isStatelogEnvelope } from "@/runsExplorer/sources.js";

import { IngestSourceError } from "./types.js";

export type Format = "auto" | "run" | "files" | "json" | "statelog";

export const FORMATS: readonly Format[] = ["auto", "run", "files", "json", "statelog"];

export function parseFormat(value: string): Format {
  if ((FORMATS as readonly string[]).includes(value)) {
    return value as Format;
  }
  throw new IngestSourceError(
    `Unknown --format "${value}". Use one of: ${FORMATS.join(", ")}.`,
  );
}

/**
 * An eval run directory, identified by two markers rather than one.
 *
 * Requiring both is deliberate: a folder of handwritten answers that happens to
 * contain a `config.json` is a folder of files, and guessing wrong would ingest
 * it through a loader that cannot read it.
 */
function isRunDirectory(resolved: string): boolean {
  return fs.existsSync(path.join(resolved, "config.json")) &&
    fs.existsSync(path.join(resolved, "inputs"));
}

/**
 * Decide which loader reads a source.
 *
 * `auto` is a documented guess, not magic — every branch below is covered by a
 * test, and anything it cannot classify is an error naming the explicit
 * formats rather than a silent fallback.
 */
export function resolveFormat(
  args: { source: string; requested: Format },
): Exclude<Format, "auto"> {
  if (args.requested !== "auto") {
    return args.requested;
  }

  const resolved = path.resolve(args.source);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return isRunDirectory(resolved) ? "run" : "files";
  }

  // A file whose first line is a statelog envelope is a statelog, whatever its
  // extension — reusing the same classifier `agency logs` uses to route paths.
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile() && looksLikeStatelog(resolved)) {
    return "statelog";
  }

  if (args.source.toLowerCase().endsWith(".json")) {
    return "json";
  }

  throw new IngestSourceError(
    `Cannot tell what kind of source ${args.source} is. Pass a run directory, a directory ` +
    `of files, a quoted glob, a .json file, or a statelog file — or say which with ` +
    `--format run|files|json|statelog.`,
  );
}

const SNIFF_CHUNK_BYTES = 65_536;
/** A statelog line can legitimately be large (a promptCompletion carries full
 *  messages), so the first line is read up to this cap — well past a chunk —
 *  rather than assuming it fits in one read. */
const MAX_FIRST_LINE_BYTES = 16 * 1024 * 1024;

/** True when the file's first non-empty line is a statelog event envelope. Reads
 *  through the first newline (bounded), so a large first event is still
 *  classified correctly rather than parsed from a truncated prefix. */
function looksLikeStatelog(resolved: string): boolean {
  const firstLine = firstNonEmptyLine(resolved);
  return firstLine !== undefined && isStatelogEnvelope(firstLine);
}

function firstNonEmptyLine(resolved: string): string | undefined {
  const fd = fs.openSync(resolved, "r");
  try {
    // Accumulate BYTES (not per-chunk strings) so a multi-byte char split across
    // a chunk boundary decodes correctly. Stop at the first newline byte or the
    // cap, whichever comes first.
    const chunk = Buffer.alloc(SNIFF_CHUNK_BYTES);
    const collected: Buffer[] = [];
    let total = 0;
    let offset = 0;
    let newlineFound = false;
    while (total < MAX_FIRST_LINE_BYTES && !newlineFound) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (bytesRead === 0) {
        break; // EOF before any newline
      }
      offset += bytesRead;
      const newlineAt = chunk.subarray(0, bytesRead).indexOf(0x0a);
      const end = newlineAt === -1 ? bytesRead : newlineAt;
      collected.push(Buffer.from(chunk.subarray(0, end)));
      total += end;
      newlineFound = newlineAt !== -1;
    }
    const text = Buffer.concat(collected).toString("utf8");
    return text.split("\n").find((line) => line.trim() !== "");
  } finally {
    fs.closeSync(fd);
  }
}
