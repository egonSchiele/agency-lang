import { main } from "./agent.js";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Real symlinks on disk: a healthy final link must resolve to its target
// in the PLAN (payload truth) and receive the write; dangling links and
// loops cannot be narrowed and fall back to the broad bash plan.
const base = mkdtempSync(join(tmpdir(), "sb-redirect-"));
try {
  const realTargetDir = join(base, "real");
  mkdirSync(realTargetDir);
  writeFileSync(join(realTargetDir, "target.txt"), "old");
  const linkPath = join(base, "final-link");
  symlinkSync(join(realTargetDir, "target.txt"), linkPath);
  const danglePath = join(base, "dangle");
  symlinkSync(join(base, "missing"), danglePath);
  const loopA = join(base, "loopA");
  const loopB = join(base, "loopB");
  symlinkSync(loopB, loopA);
  symlinkSync(loopA, loopB);

  const result = await main({
    base,
    realTargetDir: realpathSync(realTargetDir),
    linkPath,
    danglePath,
    loopPath: loopA,
  });
  const out = result.data;
  writeFileSync("__result.json", JSON.stringify({
    planReportsRealParent: out.linkFields.dir === realpathSync(realTargetDir),
    planReportsRealName: out.linkFields.filename === "target.txt",
    planMode: out.linkFields.mode,
    writeResult: out.writeResult,
    realTargetReceivedWrite: readFileSync(join(realTargetDir, "target.txt"), "utf8").trim() === "via-link",
    dangleFallsBackToBash: out.dangleKind === "bash",
    loopFallsBackToBash: out.loopKind === "bash",
  }, null, 2));
} finally {
  rmSync(base, { recursive: true, force: true });
}
