import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { harnessSha256, snapshotHarness } from "./harnessSnapshot.js";
import type { AgencyTestDefinition } from "../runTypes.js";

const JSON_OK = JSON.stringify({
  tests: [{ nodeName: "t", expectedOutput: "1", evaluationCriteria: [{ type: "exact" }] }],
});
const AGENCY = "export node t(): number {\n  return 1\n}\n";

function pair(dir: string, name: string, json = JSON_OK, agency = AGENCY): AgencyTestDefinition {
  fs.writeFileSync(path.join(dir, `${name}.test.json`), json);
  fs.writeFileSync(path.join(dir, `${name}.agency`), agency);
  return {
    name,
    visibility: "visible",
    testJsonFile: path.join(dir, `${name}.test.json`),
    agencyFile: path.join(dir, `${name}.agency`),
  };
}

describe("snapshotHarness", () => {
  test("two pairs: files named by hash and extension, one record each, sha stable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-snap-"));
    try {
      const defs = [
        pair(dir, "a"),
        pair(dir, "b", JSON_OK, "export node t(): number {\n  return 2\n}\n"),
      ];
      const snap = snapshotHarness(defs, 2);
      expect(snap.records.map((r) => r.name)).toEqual(["a", "b"]);
      expect(snap.records[0].maxCost).toBe(2);
      expect(snap.records[0].agency).toMatch(/^[0-9a-f]{64}\.agency$/);
      expect(snap.records[0].json).toMatch(/^[0-9a-f]{64}\.test\.json$/);
      // The two pairs share the json content: stored once.
      expect(snap.files.map((f) => f.name).sort()).toEqual(
        [snap.records[0].agency, snap.records[1].agency, snap.records[0].json].sort(),
      );
      expect(snapshotHarness(defs, 2).records[0].sha256).toBe(snap.records[0].sha256);
      expect(snap.records[0].sha256).toBe(harnessSha256(AGENCY, JSON_OK));
      expect(snap.records[0].sha256).not.toBe(snap.records[1].sha256);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a preflight refusal names the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-snap-"));
    try {
      const bad = pair(
        dir,
        "bad",
        JSON.stringify({
          tests: [
            {
              nodeName: "t",
              expectedOutput: "1",
              evaluationCriteria: [{ type: "exact" }],
              interruptHandlers: [{ action: "approve" }],
            },
          ],
        }),
      );
      expect(() => snapshotHarness([bad], undefined)).toThrow(/bad\.test\.json.*interruptHandlers/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
