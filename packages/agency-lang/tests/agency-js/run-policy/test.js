import { readIt, writeIt, inputIt } from "./agent.js";
import { existsSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const s = (x) => JSON.stringify(x);

// Scenario 1: explicit policy — read approved, write rejected.
// Discriminating assertions (NOT Array.isArray-only, which is true for both
// approve and reject): read APPROVED proven by content coming back; write
// REJECTED proven by no file on disk + a handled failure carrying "reject".
process.env.AGENCY_RUN_POLICY = s({
  "std::read": [{ action: "approve" }],
  "std::write": [{ action: "reject" }],
});
const dir1 = mkdtempSync(join(tmpdir(), "runpol-"));
writeFileSync(join(dir1, "in.txt"), "READABLE_CONTENT");
const readRes = await readIt({ dir: dir1, filename: "in.txt" });
const writeRes = await writeIt({ dir: dir1, filename: "out.txt" });
const readApproved =
  s(readRes.data).includes("READABLE_CONTENT") && !/reject/i.test(s(readRes.data));
const writeRejected =
  !existsSync(join(dir1, "out.txt")) &&
  !Array.isArray(writeRes.data) &&
  /reject/i.test(s(writeRes.data));

// Scenario 2: empty policy — fail-closed. Write is unlisted → rejected.
// "handled (not an Interrupt[]) AND no file" together rule out both fail-open
// (would create the file) and unhandled (would leave data as an array).
process.env.AGENCY_RUN_POLICY = "{}";
const dir2 = mkdtempSync(join(tmpdir(), "runpol-"));
const writeRes2 = await writeIt({ dir: dir2, filename: "out.txt" });
const failClosedRejected =
  !Array.isArray(writeRes2.data) && !existsSync(join(dir2, "out.txt"));

// Scenario 3: input-style interrupt under empty policy → reject, not a value.
const inputRes = await inputIt();
const inputRejected =
  !Array.isArray(inputRes.data) && /reject/i.test(s(inputRes.data));

writeFileSync(
  "__result.json",
  JSON.stringify(
    { readApproved, writeRejected, failClosedRejected, inputRejected },
    null,
    2,
  ),
);
