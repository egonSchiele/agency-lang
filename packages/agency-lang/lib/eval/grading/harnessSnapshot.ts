/**
 * What a run directory keeps of a test's harness pairs: both files of every
 * pair, named by content hash like judge files are, plus the `harness`
 * records the run row carries so `eval grade` can find them again.
 *
 * This is where a harness is preflighted. A malformed json, a field the
 * grading policy makes meaningless, or a json naming a file other than its
 * sibling all fail here, before any agent runs.
 */
import * as fs from "fs";
import * as path from "path";
import type { HarnessRecord } from "@/runDirectory/annotations.js";
import type { AgencyTestDefinition } from "../runTypes.js";
import { parseTestFileEvalHarness } from "../../testFormat/schema.js";
import { sha256Text } from "@/utils/hash.js";

export type HarnessSnapshot = {
  files: { name: string; content: string }[];
  records: HarnessRecord[];
};

/** The harness grader's revision: one hash over both files. */
export function harnessSha256(agencySource: string, jsonText: string): string {
  return sha256Text(`${agencySource}\0${jsonText}`);
}

export function snapshotHarness(
  defs: AgencyTestDefinition[],
  maxCost: number | undefined,
): HarnessSnapshot {
  const files: HarnessSnapshot["files"] = [];
  const records: HarnessRecord[] = [];
  const store = (content: string, extension: string): string => {
    const name = `${sha256Text(content)}${extension}`;
    if (!files.some((file) => file.name === name)) files.push({ name, content });
    return name;
  };
  for (const def of defs) {
    const jsonText = fs.readFileSync(def.harnessJson, "utf-8");
    parseTestFileEvalHarness(jsonText, def.harnessJson, path.basename(def.harnessAgency));
    const agencySource = fs.readFileSync(def.harnessAgency, "utf-8");
    records.push({
      name: def.name,
      visibility: def.visibility,
      agency: store(agencySource, ".agency"),
      json: store(jsonText, ".test.json"),
      sha256: harnessSha256(agencySource, jsonText),
      ...(maxCost === undefined ? {} : { maxCost }),
    });
  }
  return { files, records };
}
