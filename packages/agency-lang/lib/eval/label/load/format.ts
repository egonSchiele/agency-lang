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
 *  until a non-empty line (bounded), so a large first event is classified
 *  correctly rather than parsed from a truncated prefix, and a leading blank
 *  line the JSONL parser tolerates does not defeat detection. */
function looksLikeStatelog(resolved: string): boolean {
  const firstLine = firstNonEmptyLine(resolved);
  return firstLine !== undefined && isStatelogEnvelope(firstLine);
}

function firstNonEmptyLine(resolved: string): string | undefined {
  const fd = fs.openSync(resolved, "r");
  try {
    // Accumulate BYTES (not per-chunk strings) so a multi-byte char split across
    // a chunk boundary decodes correctly, and keep reading past blank lines until
    // a non-empty line completes or the cap is hit — a JSONL statelog may begin
    // with blank lines, and a single event can exceed one chunk.
    const chunk = Buffer.alloc(SNIFF_CHUNK_BYTES);
    const collected: Buffer[] = [];
    let total = 0;
    let lineStart = 0; // byte offset, within the concatenation, of the current line
    while (total < MAX_FIRST_LINE_BYTES) {
      const want = Math.min(chunk.length, MAX_FIRST_LINE_BYTES - total);
      const bytesRead = fs.readSync(fd, chunk, 0, want, total);
      if (bytesRead === 0) {
        break; // EOF before a non-empty line
      }
      const hasNewline = chunk.subarray(0, bytesRead).includes(0x0a);
      collected.push(Buffer.from(chunk.subarray(0, bytesRead)));
      total += bytesRead;
      if (!hasNewline) {
        continue; // no complete line yet; keep reading within the cap
      }
      const buffer = Buffer.concat(collected);
      for (let nl = buffer.indexOf(0x0a, lineStart); nl !== -1; nl = buffer.indexOf(0x0a, lineStart)) {
        const line = buffer.subarray(lineStart, nl).toString("utf8");
        if (line.trim() !== "") {
          return line;
        }
        lineStart = nl + 1; // this line was blank; move past it
      }
    }
    // Cap or EOF: a final line with no trailing newline is still a candidate.
    const tail = Buffer.concat(collected).subarray(lineStart).toString("utf8");
    return tail.trim() === "" ? undefined : tail;
  } finally {
    fs.closeSync(fd);
  }
}
