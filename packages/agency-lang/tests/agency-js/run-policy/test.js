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

// Scenario 2: empty policy — effects the policy does not mention are left to
// the program (and ultimately the caller). Write is unlisted → the chain stays
// silent and the interrupt SURFACES to this TS caller as an Interrupt[], with
// no file created. (The reject-what-surfaces default lives in the CLI endpoint,
// resolveCliInterrupts — not here.)
process.env.AGENCY_RUN_POLICY = "{}";
const dir2 = mkdtempSync(join(tmpdir(), "runpol-"));
const writeRes2 = await writeIt({ dir: dir2, filename: "out.txt" });
const unlistedSurfaced =
  Array.isArray(writeRes2.data) &&
  writeRes2.data[0].effect === "std::write" &&
  !existsSync(join(dir2, "out.txt"));

// Scenario 3: input-style interrupt (assignment position) under empty policy →
// surfaces too, and carries expectsValue so the caller knows an approval value
// is expected.
const inputRes = await inputIt();
const inputSurfacedExpectsValue =
  Array.isArray(inputRes.data) && inputRes.data[0].expectsValue === true;

writeFileSync(
  "__result.json",
  JSON.stringify(
    { readApproved, writeRejected, unlistedSurfaced, inputSurfacedExpectsValue },
    null,
    2,
  ),
);
