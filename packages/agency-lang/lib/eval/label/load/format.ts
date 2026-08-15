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

/** True when the file's first non-empty line is a statelog event envelope. Reads
 *  only a bounded prefix, so a large statelog is not slurped just to classify. */
function looksLikeStatelog(resolved: string): boolean {
  const firstLine = firstNonEmptyLine(resolved);
  return firstLine !== undefined && isStatelogEnvelope(firstLine);
}

function firstNonEmptyLine(resolved: string): string | undefined {
  const fd = fs.openSync(resolved, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_CHUNK_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim() !== "") {
        return line;
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}
