import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { describeIngestSkip } from "@/eval/label/load/eligibility.js";
import { parseFormat, type Format } from "@/eval/label/load/format.js";
import { loadBatch } from "@/eval/label/load/index.js";
import {
  DEFAULT_MAX_INGEST_BYTES,
  EmptyIngestError,
  IngestSourceError,
  type LoadedBatch,
} from "@/eval/label/load/types.js";
import { acquireStoreLock } from "@/eval/label/lock.js";
import { openStore, type IngestResult, type LabelStore } from "@/eval/label/store.js";
import type { Fields } from "@/eval/label/types.js";
import { color } from "@/utils/termcolors.js";

import { resolveLabelStore } from "./label.js";

export type EvalIngestOptions = {
  path: string;
  source?: string;
  format?: string;
  task?: string;
  field?: string[];
  taskField?: boolean;
  recursive?: boolean;
  maxBytes?: number;
  store?: string;
  config?: AgencyConfig;
  /** Extra positional arguments. Only ever non-empty when an unquoted glob was
   *  expanded by the shell, which is worth saying out loud. */
  extraArgs?: string[];
};

/** @internal Injected so the command can be tested without a store or a disk. */
export type EvalIngestDependencies = {
  loadBatch: typeof loadBatch;
  openStore: typeof openStore;
  report(message: string): void;
};

const defaultDependencies: EvalIngestDependencies = {
  loadBatch,
  openStore,
  report: (message) => console.log(message),
};

/**
 * Merge `--task` and `--field` into one constant-field map.
 *
 * Every collision is an error rather than a merge, because a field's value must
 * have exactly one origin: silently letting the last flag win would make the
 * stored artifact depend on argument order.
 */
export function parseFieldArgs(options: {
  task?: string;
  field?: string[];
}): Fields {
  const fields: Fields = {};

  for (const raw of options.field ?? []) {
    // Split on the FIRST `=` only, so a value may contain one without escaping.
    const separator = raw.indexOf("=");
    if (separator <= 0) {
      throw new IngestSourceError(
        `--field must be written name=value; got "${raw}".`,
      );
    }
    const name = raw.slice(0, separator);
    if (Object.hasOwn(fields, name)) {
      throw new IngestSourceError(`--field ${name}= was given twice.`);
    }
    fields[name] = raw.slice(separator + 1);
  }

  if (options.task !== undefined) {
    if (Object.hasOwn(fields, "task")) {
      throw new IngestSourceError(
        "--task is sugar for --field task=..., so passing both is ambiguous. Use one.",
      );
    }
    fields.task = options.task;
  }

  return fields;
}

/** Field names a loader builds itself. A constant may not collide with one:
 *  the record would then depend on which assignment happened to run last. */
const LOADER_FIELD_NAMES: Record<Format, readonly string[]> = {
  auto: [],
  run: ["task", "output"],
  files: ["output"],
  json: ["output"],
};

export function assertNoLoaderCollision(
  format: Format,
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
        `Cannot set "${name}" as a constant: the loader already produces "${name}" for this ` +
        (name === "task"
          ? "source. Pass --no-task-field as well if you mean to replace it."
          : "source."),
      );
    }
  }
}

function summarize(result: IngestResult, sourceName: string): string[] {
  const out = [
    `Ingested into source "${sourceName}":`,
    `  ${result.recordsAdded} new record${result.recordsAdded === 1 ? "" : "s"}, ` +
    `${result.recordsReplayed} already stored`,
    `  ${result.occurrencesAdded} new occurrence${result.occurrencesAdded === 1 ? "" : "s"}, ` +
    `${result.occurrencesReplayed} already recorded`,
  ];
  if (result.skips.length > 0) {
    out.push(`  ${result.skips.length} skipped:`);
    for (const skip of result.skips) {
      out.push(`    ${describeIngestSkip(skip)}`);
    }
  }
  return out;
}

export async function evalIngest(
  options: EvalIngestOptions,
  dependencies: EvalIngestDependencies = defaultDependencies,
): Promise<void> {
  if ((options.extraArgs ?? []).length > 0) {
    throw new IngestSourceError(
      "This command takes one source, but the shell passed several. Quote the pattern so it " +
      `reaches agency unexpanded, for example --format files "answers/*.txt".`,
    );
  }

  const sourceName = (options.source ?? "").trim();
  if (sourceName.length === 0) {
    throw new IngestSourceError(
      "--source is required: it names this batch on every occurrence, and is how you tell " +
      "one agent's outputs from another's when you read the labels back.",
    );
  }

  const requestedFormat = parseFormat(options.format ?? "auto");
  const includeTaskField = options.taskField !== false;
  const constantFields = parseFieldArgs(options);
  assertNoLoaderCollision(requestedFormat, constantFields, includeTaskField);

  const batch: LoadedBatch = dependencies.loadBatch({
    source: {
      path: options.path,
      requestedFormat,
      includeTaskField,
      recursive: options.recursive === true,
    },
    sourceName,
    constantFields,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_INGEST_BYTES,
    reportWarning: (message) => console.warn(message),
  });

  // A silent zero-record success is how you end up labelling an empty store and
  // wondering where everything went.
  if (batch.occurrences.length === 0) {
    const detail = batch.skips.length === 0
      ? "Nothing matched."
      : `Every candidate was skipped:\n${batch.skips.map((skip) => `  ${describeIngestSkip(skip)}`).join("\n")}`;
    throw new EmptyIngestError(`No records to ingest from ${options.path}. ${detail}`);
  }

  const storeDir = resolveLabelStore(options, options.config ?? {});
  const lock = acquireStoreLock({
    storeDir,
    reportWarning: (message) => console.warn(message),
  });
  let store: LabelStore | undefined;
  try {
    store = dependencies.openStore({
      storeDir,
      lock,
      reportWarning: (message) => console.warn(message),
    });
    const result = store.ingest(batch);
    for (const message of summarize(result, sourceName)) {
      dependencies.report(message);
    }
    if (result.newFieldNames.length > 0) {
      dependencies.report(color.yellow(
        `  note: this batch introduced ${result.newFieldNames.join(", ")}, which the store had ` +
        "not seen. Records with different field names cannot be judged by the same question.",
      ));
    }
  } finally {
    store?.close();
    lock.release();
  }
}

/** Where `--source` is explained, once, for both commands that take it. */
export const SOURCE_FLAG_DESCRIPTION =
  "Batch name recorded on every occurrence. Reusing a name says these observations belong to " +
  "the same logical source; a distinct batch must use a distinct source name";

export const INGEST_PATH_DESCRIPTION =
  "A run directory, a directory of files (one file per record), a quoted glob, or a .json " +
  "file holding an array of strings";
