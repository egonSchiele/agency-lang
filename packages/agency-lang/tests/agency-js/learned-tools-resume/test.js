import { main } from "./agent.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { safeDeleteDirectoryWithin } from "../../../dist/lib/utils.js";

// These directories belong to this fixture. Never delete the shared
// subprocess artifact directory or anything outside the fixture.
const fixtureRoot = process.cwd();
safeDeleteDirectoryWithin(fixtureRoot, resolve("test-output"));
mkdirSync("test-output/source", { recursive: true });
writeFileSync("test-output/source/tools.agency", 'export def seriesInfo(seriesId | id: string): string { return "original:${seriesId}" }');
process.env.LINES = "learn";
await main();
const checkpoint = JSON.parse(readFileSync("test-output/sessions/session-tools.json", "utf8"));

function recordsIn(value) {
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if (key.endsWith("learnedRecords") && Array.isArray(child)) {
      return child;
    }
    return recordsIn(child);
  });
}

const records = recordsIn(checkpoint);
writeFileSync("test-output/record-check.json", JSON.stringify({
  count: records.length,
  onlyData: !JSON.stringify(records).includes('"__nativeType":"FunctionRef"'),
}));
safeDeleteDirectoryWithin(fixtureRoot, resolve("test-output/source"));
execFileSync(process.execPath, ["./resume-stage.js"], {
  stdio: "inherit",
  env: { ...process.env, RESUME: "1", LINES: "use" },
});
