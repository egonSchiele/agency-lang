import * as fs from "fs";

import type { Fields } from "../types.js";

import type { FileSelection } from "./discoverFiles.js";
import { checkEligibility, decodeUtf8Strict } from "./eligibility.js";
import type { IngestSkip, LoadedBatch, LoadedOccurrence } from "./types.js";

export type LoadFilesArgs = {
  selection: FileSelection;
  source: string;
  constantFields: Fields;
  maxBytes: number;
};

/**
 * One file, one record.
 *
 * The case none of the comparable tools ship: Label Studio and Prodigy both
 * read a text file line by line, so twenty handwritten answers in twenty files
 * is the wrong shape for them. Discovery and pattern matching belong to
 * `resolveFileSelection`; this reads what it was handed.
 */
export function loadFiles(args: LoadFilesArgs): LoadedBatch {
  const occurrences: LoadedOccurrence[] = [];
  const skips: IngestSkip[] = [];

  for (const file of args.selection.files) {
    if (file.isSymlink) {
      skips.push({ item: file.itemKey, reason: "symlink" });
      continue;
    }

    const text = decodeUtf8Strict(fs.readFileSync(file.absolutePath));
    if (text === undefined) {
      skips.push({ item: file.itemKey, reason: "not-utf8" });
      continue;
    }

    const ineligible = checkEligibility(text, { maxBytes: args.maxBytes });
    if (ineligible !== undefined) {
      skips.push({ item: file.itemKey, reason: ineligible });
      continue;
    }

    const fields: Fields = { ...args.constantFields, output: text };
    occurrences.push({
      fields,
      source: args.source,
      origin: { kind: "file", itemKey: file.itemKey },
    });
  }

  return { occurrences, skips };
}
