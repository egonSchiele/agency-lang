import * as fs from "fs";
import * as path from "path";

import type { Fields } from "../types.js";

import { resolveFileSelection } from "./discoverFiles.js";
import { decodeUtf8Strict } from "./eligibility.js";
import { loadFiles } from "./files.js";
import { resolveFormat, type Format } from "./format.js";
import { loadJsonArray } from "./json.js";
import { loadRun } from "./run.js";
import { loadStatelog } from "./statelog.js";
import { IngestSourceError, type IngestSelection, type LoadedBatch } from "./types.js";

/** Field names each loader builds itself. A constant may not collide with one:
 *  the loader's value wins on merge, so the constant would vanish without a
 *  word. */
const LOADER_FIELD_NAMES: Record<Exclude<Format, "auto">, readonly string[]> = {
  run: ["task", "output"],
  files: ["output"],
  json: ["output"],
  statelog: ["task", "output"],
};

export function assertNoLoaderCollision(
  format: Exclude<Format, "auto">,
  constantFields: Fields,
  includeTaskField: boolean,
): void {
  for (const name of LOADER_FIELD_NAMES[format]) {
    // `--no-task-field --task "..."` is the documented way to replace a run's
    // own task, so the task field only collides while the loader still emits it.
    if (name === "task" && !includeTaskField) {
      continue;
    }
    if (Object.hasOwn(constantFields, name)) {
      throw new IngestSourceError(
        `Cannot set "${name}" as a constant: the ${format} loader already produces "${name}"` +
        (name === "task"
          ? ". Pass --no-task-field as well if you mean to replace it."
          : "."),
      );
    }
  }
}

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
  /** Interactive-free selection. `statelog` sources carry their chosen traces
   *  here; every other source uses `{ kind: "none" }`. */
  selection: IngestSelection;
  reportWarning(message: string): void;
};

/** @internal Injected so dispatch can be tested without a filesystem. */
export type LoadDependencies = {
  loadRun: typeof loadRun;
  loadFiles: typeof loadFiles;
  loadJsonArray: typeof loadJsonArray;
  loadStatelog: typeof loadStatelog;
  resolveFileSelection: typeof resolveFileSelection;
};

const defaultDependencies: LoadDependencies = {
  loadRun,
  loadFiles,
  loadJsonArray,
  loadStatelog,
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
  // Checked HERE, not in the CLI. With `auto` the caller does not yet know
  // which loader will run, so a constant `output=` would pass a caller-side
  // check and then be silently overwritten by the loader — changing the stored
  // record, and its id, from what the arguments said.
  assertNoLoaderCollision(format, request.constantFields, request.source.includeTaskField);

  // Trace selection only means something for a statelog source. Rejecting it
  // elsewhere turns "I put --trace on the wrong kind of source" into a clear
  // error instead of a silently ignored flag.
  if (format !== "statelog" && request.selection.kind === "statelog") {
    throw new IngestSourceError(
      `--trace and --output only apply to a statelog source, but ${request.source.path} is a ` +
      `${format} source.`,
    );
  }

  if (format === "statelog") {
    const request_ = request.selection.kind === "statelog"
      ? request.selection.request
      : { traceIds: [], printSelections: {} };
    return dependencies.loadStatelog({
      path: request.source.path,
      request: request_,
      source: request.sourceName,
      constantFields: request.constantFields,
      includeTaskField: request.source.includeTaskField,
      maxBytes: request.maxBytes,
    });
  }

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
