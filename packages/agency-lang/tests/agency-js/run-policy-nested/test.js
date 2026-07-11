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

// Proves the policy REACHES interrupts raised inside the std::agency::run
// subprocess, and does so SELECTIVELY (not a blanket reject): the generated
// code's read is APPROVED (its content came back) while its write is REJECTED
// (no file on disk, rejection visible).
//
// Note: this test does NOT by itself pin the *mechanism* (forward-to-root vs.
// child-installs-its-own). The child inherits the same policy, and a local
// reject is final (gatherChainOutcome), so the outcome is identical either way.
// The `installRunPolicyHandler` IPC-skip unit test in runPolicyHandler.test.ts
// is what guards "the subprocess must not install its own handler".
const readApproved = out.includes("NESTED_READABLE");
const writeRejected = !existsSync(join(dir, "gen-out.txt")) && /reject/i.test(out);

// Emit the observed shape too, so a mismatch is diagnosable from CI output.
console.log("OBSERVED res.data:", out);

writeFileSync(
  "__result.json",
  JSON.stringify({ readApproved, writeRejected }, null, 2),
);
