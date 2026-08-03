import * as fs from "fs";
import * as path from "path";

import type { Fields } from "../types.js";

import { resolveFileSelection } from "./discoverFiles.js";
import { decodeUtf8Strict } from "./eligibility.js";
import { loadFiles } from "./files.js";
import { resolveFormat, type Format } from "./format.js";
import { loadJsonArray } from "./json.js";
import { loadRun } from "./run.js";
import { IngestSourceError, type LoadedBatch } from "./types.js";

export type IngestSourceSpec = {
  path: string;
  requestedFormat: Format;
  includeTaskField: boolean;
  recursive: boolean;
};

/** Everything a caller states about one batch. Declarative on purpose: the CLI
 *  describes what it wants and never picks a loader itself. */
export type IngestRequest = {
  source: IngestSourceSpec;
  sourceName: string;
  constantFields: Fields;
  maxBytes: number;
  reportWarning(message: string): void;
};

/** @internal Injected so dispatch can be tested without a filesystem. */
export type LoadDependencies = {
  loadRun: typeof loadRun;
  loadFiles: typeof loadFiles;
  loadJsonArray: typeof loadJsonArray;
  resolveFileSelection: typeof resolveFileSelection;
};

const defaultDependencies: LoadDependencies = {
  loadRun,
  loadFiles,
  loadJsonArray,
  resolveFileSelection,
};

/**
 * The only loader-dispatch entry point.
 *
 * Format selection, glob discovery and loader-specific argument construction
 * all live behind this call, so a caller cannot accidentally reach past it and
 * pass a loader arguments no other caller would.
 */
export function loadBatch(
  request: IngestRequest,
  dependencies: LoadDependencies = defaultDependencies,
): LoadedBatch {
  const format = resolveFormat({
    source: request.source.path,
    requested: request.source.requestedFormat,
  });

  if (format === "run") {
    return dependencies.loadRun({
      sourceDir: request.source.path,
      source: request.sourceName,
      constantFields: request.constantFields,
      includeTaskField: request.source.includeTaskField,
      maxBytes: request.maxBytes,
      reportWarning: request.reportWarning,
    });
  }

  if (format === "files") {
    return dependencies.loadFiles({
      selection: dependencies.resolveFileSelection(
        request.source.path,
        request.source.recursive,
      ),
      source: request.sourceName,
      constantFields: request.constantFields,
      maxBytes: request.maxBytes,
    });
  }

  const resolved = path.resolve(request.source.path);
  if (!fs.existsSync(resolved)) {
    throw new IngestSourceError(`Source not found: ${request.source.path}`);
  }
  const text = decodeUtf8Strict(fs.readFileSync(resolved));
  if (text === undefined) {
    throw new IngestSourceError(`${request.source.path} is not valid UTF-8.`);
  }
  return dependencies.loadJsonArray({
    // The document's own name, not its full path: an occurrence key must not
    // change because the file was ingested from a different directory.
    itemKey: path.basename(resolved),
    text,
    source: request.sourceName,
    constantFields: request.constantFields,
    maxBytes: request.maxBytes,
  });
}
