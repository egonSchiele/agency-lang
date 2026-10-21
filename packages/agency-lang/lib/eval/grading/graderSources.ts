import * as path from "path";

import {
  loadGradersJson,
  loadGradersJsonSnapshot,
  snapshotGradersJson,
} from "../gradersJson/load.js";
import type { BaseGrader } from "./baseGrader.js";
import {
  loadGradingModule,
  loadGradingSnapshot,
  snapshotGradingModule,
  type GradersSnapshot,
  type RecordedGraders,
} from "./gradingModule.js";

/**
 * A test's graders come from one of two sources: a `graders.ts` module or a
 * `graders.json` file. Each source does three things: load the graders live,
 * store them in a run directory, and load them back from the store. The
 * call sites look the source up here and never mention an extension or a
 * stored file's name.
 */
export type GraderSource = {
  matchesPath: (filePath: string) => boolean;
  matchesRecord: (recorded: RecordedGraders) => boolean;
  load: (filePath: string) => Promise<BaseGrader[]>;
  snapshot: (filePath: string) => Promise<GradersSnapshot>;
  loadSnapshot: (gradersDir: string, recorded: RecordedGraders) => Promise<BaseGrader[]>;
};

export const MODULE_SOURCE: GraderSource = {
  matchesPath: (filePath) => path.extname(filePath) === ".ts",
  matchesRecord: (recorded) => recorded.bundleFile !== undefined,
  load: (filePath) => loadGradingModule(filePath, {}),
  snapshot: snapshotGradingModule,
  loadSnapshot: loadGradingSnapshot,
};

export const JSON_SOURCE: GraderSource = {
  matchesPath: (filePath) => path.extname(filePath) === ".json",
  matchesRecord: (recorded) => recorded.jsonFile !== undefined,
  load: loadGradersJson,
  snapshot: snapshotGradersJson,
  loadSnapshot: loadGradersJsonSnapshot,
};

const GRADER_SOURCES: GraderSource[] = [MODULE_SOURCE, JSON_SOURCE];

export function graderSourceForPath(filePath: string): GraderSource {
  const source = GRADER_SOURCES.find((candidate) => candidate.matchesPath(filePath));
  if (source === undefined) throw new Error(`no grader source for ${filePath}`);
  return source;
}

export function graderSourceForRecord(recorded: RecordedGraders): GraderSource {
  const source = GRADER_SOURCES.find((candidate) => candidate.matchesRecord(recorded));
  if (source === undefined) throw new Error(`no grader source for ${recorded.source}`);
  return source;
}
