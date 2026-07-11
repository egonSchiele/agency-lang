import { main } from "./driver.js";
import { existsSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Root policy: allow running generated code (std::run) and reading, reject
// writing. The generated code's own interrupts forward up to this handler.
process.env.AGENCY_RUN_POLICY = JSON.stringify({
  "std::run": [{ action: "approve" }],
  "std::read": [{ action: "approve" }],
  "std::write": [{ action: "reject" }],
});

const dir = mkdtempSync(join(tmpdir(), "runpol-nested-"));
writeFileSync(join(dir, "in.txt"), "NESTED_READABLE");

const res = await main({ readDir: dir, readName: "in.txt" });
const out = JSON.stringify(res.data);

// Selective enforcement (NOT blanket reject): read APPROVED inside the child
// (its content came back) AND write REJECTED inside the child (no file on disk,
// rejection visible).
const readApproved = out.includes("NESTED_READABLE");
const writeRejected = !existsSync(join(dir, "gen-out.txt")) && /reject/i.test(out);

// Emit the observed shape too, so a mismatch is diagnosable from CI output.
console.log("OBSERVED res.data:", out);

writeFileSync(
  "__result.json",
  JSON.stringify({ readApproved, writeRejected }, null, 2),
);
