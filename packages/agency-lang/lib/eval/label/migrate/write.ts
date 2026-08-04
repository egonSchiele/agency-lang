import * as fs from "fs";
import * as path from "path";

import { annotationsPath } from "../annotations.js";
import { corpusPath } from "../corpus.js";
import { appendDurably, atomicWriteValidated, syncDirectory } from "../jsonl.js";
import { occurrencesPath } from "../occurrences.js";
import { manifestPath } from "../store.js";
import { ManifestSchema, type Manifest } from "../types.js";

import type { MigrationPlan } from "./plan.js";

/**
 * Write one complete version 2 store into an empty directory.
 *
 * The manifest goes LAST and is the store's format marker, so an interrupted
 * write can never look like a finished store: `openStore` reads the manifest
 * before anything else, and its absence means this directory was never
 * published.
 */
export function writeStagedStore(plan: MigrationPlan, stagingDir: string): void {
  fs.mkdirSync(stagingDir, { recursive: true });

  writeJsonl(corpusPath(stagingDir), plan.records);
  writeJsonl(occurrencesPath(stagingDir), plan.occurrences);
  writeJsonl(annotationsPath(stagingDir), plan.annotations);

  const manifest: Manifest = { schemaVersion: 2, fieldOrder: [...plan.fieldOrder] };
  atomicWriteValidated({
    targetPath: manifestPath(stagingDir),
    value: manifest,
    schema: ManifestSchema,
  });
  syncDirectory(stagingDir);
}

function writeJsonl(filePath: string, rows: readonly unknown[]): void {
  if (rows.length === 0) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  appendDurably(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}
