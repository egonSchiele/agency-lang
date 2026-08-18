import * as fs from "fs";
import * as path from "path";

import {
  foldAnnotations,
  readAnnotations,
  type Annotation,
  type EffectiveTraceAnnotations,
} from "./annotations.js";
import type { ParseError } from "@/statelog/parse.js";

import { readTraces, type Trace } from "./traces.js";

/**
 * A run directory is a plain folder: `statelog.jsonl` (any number of traces),
 * `annotations.jsonl`, and optional attachments. This module names its paths
 * and reads it into one coherent snapshot. It never writes; `mutations.ts` does.
 */
export type RunDirectoryPaths = {
  dir: string;
  statelog: string;
  annotations: string;
  codeDir: string;
  workdirDir: string;
  checklistsDir: string;
  lock: string;
};

export function runDirPaths(dir: string): RunDirectoryPaths {
  return {
    dir,
    statelog: path.join(dir, "statelog.jsonl"),
    annotations: path.join(dir, "annotations.jsonl"),
    codeDir: path.join(dir, "code"),
    workdirDir: path.join(dir, "workdir"),
    checklistsDir: path.join(dir, "checklists"),
    lock: path.join(dir, ".lock"),
  };
}

export type RunDirectorySnapshot = {
  dir: string;
  hasStatelog: boolean;
  traces: Trace[];
  annotationRows: Annotation[];
  effectiveAnnotations: Record<string, EffectiveTraceAnnotations>;
};

export type ReadRunDirectoryOptions = { reportWarning(message: string): void };

/** How many times a reader re-reads when a writer changed the statelog between
 *  its two passes. Writers hold the lock and append quickly, so one retry is
 *  the norm; more than this means something is rewriting the file in a loop. */
const MAX_SNAPSHOT_ATTEMPTS = 5;

/**
 * Read a run directory without taking the lock, and still get one coherent
 * picture: statelog, then annotations, then the statelog again — if the second
 * statelog read differs from the first, a writer landed in between, so start
 * over. A missing statelog is an empty, valid directory, not an error.
 */
export function readRunDirectory(
  dir: string,
  options: ReadRunDirectoryOptions,
): RunDirectorySnapshot {
  const paths = runDirPaths(dir);
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = readStatelog(paths);
    const annotationRows = readAnnotations(paths.annotations, options.reportWarning);
    const after = readStatelog(paths);
    if (before.fingerprint === after.fingerprint) {
      // Only the read we keep reports its problems, so a warning shows once.
      for (const error of after.errors) {
        options.reportWarning(`${paths.statelog}:${error.line}: ${error.kind}: ${error.detail}`);
      }
      return {
        dir,
        hasStatelog: after.exists,
        traces: after.traces,
        annotationRows,
        effectiveAnnotations: foldAnnotations(annotationRows),
      };
    }
  }
  throw new Error(
    `${paths.statelog} kept changing while it was being read; retry when the writer is done.`,
  );
}

function readStatelog(paths: RunDirectoryPaths): {
  exists: boolean;
  traces: Trace[];
  errors: ParseError[];
  fingerprint: string;
} {
  if (!fs.existsSync(paths.statelog)) {
    return { exists: false, traces: [], errors: [], fingerprint: "" };
  }
  const { traces, errors } = readTraces(paths.statelog);
  return {
    exists: true,
    traces,
    errors,
    fingerprint: traces.map((trace) => trace.digest).join("\n"),
  };
}
