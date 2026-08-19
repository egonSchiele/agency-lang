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
 * A run directory is a plain folder holding one run: `statelog.jsonl` (one
 * trace; more is refused), `annotations.jsonl`, and optional attachments — the agent's code
 * closure directly under `code/`, a working-directory snapshot directly under
 * `workdir/` with its `workdir.json` sidecar, free-form `notes.md`. This
 * module names its paths and reads it into one snapshot: the statelog and
 * annotations are paired coherently (see `readRunDirectory`); `notes.md` is
 * sampled independently, best effort (see `readNotes`). It never writes;
 * `mutations.ts` does.
 */
export type RunDirectoryPaths = {
  dir: string;
  statelog: string;
  annotations: string;
  notes: string;
  codeDir: string;
  workdirDir: string;
  workdirSidecar: string;
  checklistsDir: string;
  lock: string;
};

export function runDirPaths(dir: string): RunDirectoryPaths {
  return {
    dir,
    statelog: path.join(dir, "statelog.jsonl"),
    annotations: path.join(dir, "annotations.jsonl"),
    notes: path.join(dir, "notes.md"),
    codeDir: path.join(dir, "code"),
    workdirDir: path.join(dir, "workdir"),
    workdirSidecar: path.join(dir, "workdir.json"),
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
  /** The text of `notes.md`, written by a person with any editor; null when absent. */
  notes: string | null;
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
    const notes = readNotes(paths);
    if (before.fingerprint === after.fingerprint) {
      // Only the read we keep reports its problems, so a warning shows once.
      for (const error of after.errors) {
        options.reportWarning(`${paths.statelog}:${error.line}: ${error.kind}: ${error.detail}`);
      }
      assertOneRun(paths, after.traces);
      return {
        dir,
        hasStatelog: after.exists,
        traces: after.traces,
        annotationRows,
        effectiveAnnotations: foldAnnotations(annotationRows),
        notes,
      };
    }
  }
  throw new Error(
    `${paths.statelog} kept changing while it was being read; retry when the writer is done.`,
  );
}

/** The guard that keeps the pre-atomic shape from creeping back through a
 *  hand-copied file: one run directory, one trace id. */
function assertOneRun(paths: RunDirectoryPaths, traces: readonly Trace[]): void {
  if (traces.length <= 1) {
    return;
  }
  const ids = traces.map((trace) => trace.traceId).join(", ");
  throw new Error(
    `${paths.statelog} holds ${traces.length} traces (${ids}); a run directory holds one run. ` +
      `Split it with \`agency runs add <group> --statelog ${paths.statelog}\`.`,
  );
}

/**
 * One best-effort read of `notes.md`. The file is a person's, edited with any
 * editor and outside the writer lock, so it is not part of the statelog
 * coherence check: during an atomic editor save this may return the old text,
 * the new text, or null (the path vanished between unlink and rename).
 */
function readNotes(paths: RunDirectoryPaths): string | null {
  try {
    return fs.readFileSync(paths.notes, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
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
