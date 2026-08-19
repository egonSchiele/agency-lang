import * as path from "path";

import { evalRecordFor } from "@/runDirectory/evalRecord.js";
import { findRunDirectories, uniqueRunDirectories } from "@/runDirectory/findRuns.js";
import {
  readRunDirectory,
  runDirPaths,
  type ReadRunDirectoryOptions,
  type RunDirectorySnapshot,
} from "@/runDirectory/runDir.js";
import type { Trace } from "@/runDirectory/traces.js";
import { traceInputText, traceOutputText } from "@/runDirectory/traceText.js";
import type { EvalRecord } from "@/eval/types.js";

import type { Fields } from "./types.js";

/**
 * What a labeling session is over: a group (one directory of run directories)
 * and the runs in it that can be labeled, each pinned to its directory and
 * its one trace. Resolving this value is the whole discovery rule for
 * `agency label <path…>`; downstream code never correlates paths with
 * snapshots again, and cannot see two runs claiming one trace id.
 */
export type LabelingRun = {
  dir: string;
  traceId: string;
  snapshot: RunDirectorySnapshot;
  /** What the screen shows for this run. */
  fields: Fields;
};

export type LabelingGroup = {
  /** Where the checklist lineage and session drafts live: the runs' parent. */
  dir: string;
  runs: LabelingRun[];
};

/**
 * Walk the paths like every other command over runs (`findRunDirectories`),
 * drop aliases of one physical directory, require one common parent, read
 * each run, skip the ones that wrote no trace, and refuse two physical
 * directories that carry the same trace id (the session is keyed by trace
 * id, so their answers would collide and a sign-off could land in the wrong
 * directory). One run directory on its own is a group of one: its parent is
 * the group.
 */
export function resolveLabelingGroup(
  paths: string[],
  options: ReadRunDirectoryOptions,
): LabelingGroup {
  const runDirs = uniqueRunDirectories(findRunDirectories(paths));
  const groupDir = commonParentOf(runDirs);
  const runs: LabelingRun[] = [];
  for (const dir of runDirs) {
    const snapshot = readRunDirectory(dir, options);
    const [trace] = snapshot.traces;
    if (trace === undefined) {
      continue;
    }
    const earlier = runs.find((run) => run.traceId === trace.traceId);
    if (earlier !== undefined) {
      throw new Error(
        `${earlier.dir} and ${dir} both hold trace ${trace.traceId}; label one of them, or ` +
          `label the group they are copies from.`,
      );
    }
    runs.push({
      dir,
      traceId: trace.traceId,
      snapshot,
      fields: fieldsOf(trace, evalRecordFor(trace, runDirPaths(dir).statelog)),
    });
  }
  if (runs.length === 0) {
    throw new Error(
      `There is nothing to label: ${paths.join(", ")} holds no run with a trace. Write one ` +
        "with `agency eval run`, or `agency runs add <group> --statelog <file>`.",
    );
  }
  return { dir: groupDir, runs };
}

function commonParentOf(runDirs: string[]): string {
  const parents = runDirs.map((dir) => path.dirname(dir));
  const distinct = parents.filter((parent, index) => parents.indexOf(parent) === index);
  if (distinct.length > 1) {
    throw new Error(
      `These runs are in different groups (${distinct.join(", ")}); a labeling session covers ` +
        `one group, because its checklist and drafts live there. Label them separately, or ` +
        `copy the runs into one directory first.`,
    );
  }
  return distinct[0];
}

// --- projection -----------------------------------------------------------

/** The field the screen shows when a trace recorded no output. Its text is
 *  marked so nobody mistakes a mid-conversation message for the result. */
export const LAST_MESSAGE_FIELD = "last_message";
const LAST_MESSAGE_MARKER = "(no recorded output; this is the agent's last message)\n\n";

function fieldsOf(trace: Trace, record: EvalRecord): Fields {
  const fields: Fields = {};
  const input = traceInputText(trace, record);
  if (input !== null) {
    fields.input = input;
  }
  const output = traceOutputText(trace, record);
  if (output.kind === "output") {
    fields.output = output.text;
  } else if (output.kind === "lastMessage") {
    fields[LAST_MESSAGE_FIELD] = LAST_MESSAGE_MARKER + output.text;
  }
  return fields;
}
