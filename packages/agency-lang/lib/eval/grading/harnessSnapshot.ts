/** Copies a test's harness pairs into the run directory (content-hash
 *  names, like judge files) and the `harness` records that point at them.
 *  Each json is preflighted here, before any agent runs. */
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
  mustPass: boolean | undefined = undefined,
): HarnessSnapshot {
  const files: HarnessSnapshot["files"] = [];
  const records: HarnessRecord[] = [];
  const store = (content: string, extension: string): string => {
    const name = `${sha256Text(content)}${extension}`;
    if (!files.some((file) => file.name === name)) files.push({ name, content });
    return name;
  };
  for (const def of defs) {
    const jsonText = fs.readFileSync(def.testJsonFile, "utf-8");
    parseTestFileEvalHarness(jsonText, def.testJsonFile, path.basename(def.agencyFile));
    const agencySource = fs.readFileSync(def.agencyFile, "utf-8");
    records.push({
      name: def.name,
      visibility: def.visibility,
      agency: store(agencySource, ".agency"),
      json: store(jsonText, ".test.json"),
      sha256: harnessSha256(agencySource, jsonText),
      ...(maxCost === undefined ? {} : { maxCost }),
      ...(mustPass === undefined ? {} : { mustPass }),
    });
  }
  return { files, records };
}
