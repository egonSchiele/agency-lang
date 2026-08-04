import * as fs from "fs";
import * as path from "path";

import { createHash } from "crypto";

import { z } from "zod";

import { canonicalize } from "@/utils/canonicalize.js";

import {
  AnnotationRowSchema,
  ContentHashSchema,
  JsonValueSchema,
  OutputIdSchema,
  type AnnotationRow,
} from "../types.js";

/**
 * The version 1 durable shapes, kept here verbatim.
 *
 * They live in the migration module rather than in `types.ts` because the
 * current format is the only one the rest of the code should know. Copying
 * them here rather than reconstructing them later is deliberate: a migration
 * that guesses at the old schema silently drops whatever it forgot.
 */
export const V1ExecutionIdentitySchema = z.object({
  traceId: z.string().min(1),
  inputId: z.string().min(1),
  finalOutputIndex: z.number().int().nonnegative(),
}).strict();

export const V1CorpusInputSchema = z.object({
  inputId: z.string().min(1),
  task: JsonValueSchema,
}).strict();

export const V1CorpusProvenanceSchema = z.object({
  runStartedAtMs: z.number().finite().nullable(),
  agent: JsonValueSchema,
  models: z.array(z.string()),
}).strict();

export const V1CorpusRowSchema = z.object({
  schemaVersion: z.literal(1),
  outputId: OutputIdSchema,
  contentHash: ContentHashSchema,
  capturedAt: z.string().min(1),
  execution: V1ExecutionIdentitySchema,
  input: V1CorpusInputSchema,
  value: JsonValueSchema,
  text: z.string(),
  provenance: V1CorpusProvenanceSchema,
}).strict();

export type V1CorpusRow = z.infer<typeof V1CorpusRowSchema>;

export const V1ManifestSchema = z.object({
  schemaVersion: z.literal(1),
}).strict();

/** Everything migration reads. Immutable, and gathered in one pass so planning
 *  can be a pure function of it. */
export type V1StoreSnapshot = {
  storeDir: string;
  corpus: readonly V1CorpusRow[];
  /** Annotation rows in file order. Order is load-bearing: answers fold by
   *  append order, so rewriting must preserve it. */
  annotations: readonly AnnotationRow[];
  checklistsDir: string;
  draftFiles: readonly string[];
};

export class V1ReadError extends Error {}

function readJsonlLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.length === 0) {
    return [];
  }
  if (!raw.endsWith("\n")) {
    throw new V1ReadError(
      `${filePath}: the file does not end in a newline, which means an append was ` +
      "interrupted. Remove the incomplete last line; every earlier row is intact.",
    );
  }
  return raw.split("\n").filter((line) => line.length > 0).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new V1ReadError(
        `${filePath}: line ${index + 1} is not valid JSON: ${(error as Error).message}`,
      );
    }
  });
}

function parseAll<Value>(
  filePath: string,
  schema: z.ZodType<Value>,
  lines: readonly unknown[],
): Value[] {
  return lines.map((line, index) => {
    const parsed = schema.safeParse(line);
    if (!parsed.success) {
      throw new V1ReadError(
        `${filePath}: line ${index + 1} is not a valid version 1 row: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  });
}

/**
 * The version 1 output id formula, reproduced here.
 *
 * Version 1 derived an id from the execution rather than the content. It is
 * gone from `ids.ts` because nothing current should compute one — but migration
 * has to check that the ids on disk really are what that formula produces,
 * which cannot be done without it.
 */
function v1OutputIdOf(execution: V1CorpusRow["execution"]): string {
  const digest = createHash("sha256").update(canonicalize({ ...execution })).digest("hex");
  return `out_${digest}`;
}

/**
 * Reject a corpus that cannot be migrated faithfully.
 *
 * Two rows sharing an output id would collapse in the id map that rewrites
 * annotations, silently moving every label for that id onto whichever row was
 * read last. Recomputing each id catches the related case: a hand-edited row
 * whose id no longer describes its own execution, which would map annotations
 * onto content nobody judged. Both refuse rather than guess — a migration runs
 * once, and a wrong answer here is not visible afterwards.
 */
function assertV1CorpusIsSound(corpusFile: string, rows: readonly V1CorpusRow[]): void {
  const seen: Record<string, number> = Object.create(null);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = seen[row.outputId];
    if (previous !== undefined) {
      throw new V1ReadError(
        `${corpusFile}: lines ${previous} and ${index + 1} share output id "${row.outputId}". ` +
        "Each output may appear once; migration cannot tell which one an annotation judged.",
      );
    }
    seen[row.outputId] = index + 1;

    const expected = v1OutputIdOf(row.execution);
    if (row.outputId !== expected) {
      throw new V1ReadError(
        `${corpusFile}: line ${index + 1} has output id "${row.outputId}", but its recorded ` +
        `execution hashes to "${expected}". The row was edited after it was written, so its ` +
        "labels cannot be moved with confidence.",
      );
    }
  }
}

export function readV1Store(storeDir: string): V1StoreSnapshot {
  const manifestFile = path.join(storeDir, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    throw new V1ReadError(`${storeDir} has no manifest.json, so it is not a label store.`);
  }
  const manifest = V1ManifestSchema.safeParse(
    JSON.parse(fs.readFileSync(manifestFile, "utf8")) as unknown,
  );
  if (!manifest.success) {
    throw new V1ReadError(
      `${storeDir} is not a version 1 label store; nothing to migrate.`,
    );
  }

  const corpusFile = path.join(storeDir, "outputs.jsonl");
  const annotationsFile = path.join(storeDir, "labels.jsonl");
  const draftsDir = path.join(storeDir, "drafts");

  const corpus = parseAll(corpusFile, V1CorpusRowSchema, readJsonlLines(corpusFile));
  assertV1CorpusIsSound(corpusFile, corpus);

  return {
    storeDir,
    corpus,
    annotations: parseAll(annotationsFile, AnnotationRowSchema, readJsonlLines(annotationsFile)),
    checklistsDir: path.join(storeDir, "checklists"),
    draftFiles: fs.existsSync(draftsDir)
      ? fs.readdirSync(draftsDir).filter((name) => name.endsWith(".json")).sort()
      : [],
  };
}
