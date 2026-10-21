import * as fs from "fs";
import * as path from "path";

import { sha256Text } from "@/utils/hash.js";

import type { BaseGrader } from "../grading/baseGrader.js";
import type { GradersSnapshot, RecordedGraders } from "../grading/gradingModule.js";
import { buildGraders } from "./build.js";
import { parseGradersJson } from "./schema.js";

/** Load the graders of a `graders.json` from disk. Each grader is named by
 *  the file and its hash, as a module's graders are, so a score row says
 *  which version of the file produced it. */
export async function loadGradersJson(filePath: string): Promise<BaseGrader[]> {
  const text = fs.readFileSync(filePath, "utf8");
  return build(text, filePath, filePath);
}

/** What a run directory keeps for a `graders.json`: the file itself under
 *  its hash. Loads the graders once so a broken file fails here, before any
 *  agent runs. No JSON kind reads a file by path, so there are no judge
 *  files; a checklist's context lives under `graderFiles/`, which the run
 *  directory stores on its own. */
export async function snapshotGradersJson(filePath: string): Promise<GradersSnapshot> {
  const text = fs.readFileSync(filePath, "utf8");
  await build(text, filePath, filePath);
  const jsonFile = `${sha256Text(text)}.json`;
  return { source: filePath, jsonFile, judgeFiles: {}, files: [{ name: jsonFile, content: text }] };
}

/** Load graders from a run directory's stored `graders.json`. The revision
 *  is the hash under the original source path, so a row graded from the
 *  snapshot and one graded live from the unchanged file agree. */
export async function loadGradersJsonSnapshot(
  gradersDir: string,
  recorded: RecordedGraders,
): Promise<BaseGrader[]> {
  const stored = path.join(gradersDir, recorded.jsonFile ?? "");
  if (recorded.jsonFile === undefined || !fs.existsSync(stored)) {
    throw new Error(`Grading snapshot not found: ${stored} (recorded for ${recorded.source}).`);
  }
  const text = fs.readFileSync(stored, "utf8");
  return build(text, stored, recorded.source);
}

async function build(text: string, parsedAs: string, source: string): Promise<BaseGrader[]> {
  const graders = buildGraders(parseGradersJson(text, parsedAs));
  const revision = `${source}@${sha256Text(text)}`;
  for (const grader of graders) grader.revision = revision;
  return graders;
}
