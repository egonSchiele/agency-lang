import * as fs from "fs";
import * as path from "path";

import { looksLikeGlob } from "./discoverFiles.js";
import { IngestSourceError } from "./types.js";

export type Format = "auto" | "run" | "files" | "json";

export const FORMATS: readonly Format[] = ["auto", "run", "files", "json"];

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
export function resolveFormat(args: { source: string; requested: Format }): Format {
  if (args.requested !== "auto") {
    return args.requested;
  }

  if (looksLikeGlob(args.source)) {
    return "files";
  }

  const resolved = path.resolve(args.source);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return isRunDirectory(resolved) ? "run" : "files";
  }

  if (args.source.toLowerCase().endsWith(".json")) {
    return "json";
  }

  throw new IngestSourceError(
    `Cannot tell what kind of source ${args.source} is. Pass a run directory, a directory ` +
    `of files, a quoted glob, or a .json file — or say which with --format run|files|json.`,
  );
}
