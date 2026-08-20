import { main } from "./agent.js";
import {
  writeFileSync, readFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync,
  realpathSync, existsSync,
} from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { randomBytes } from "crypto";

// One unique base holding work/, outside/, and every symlink; a policy
// that approves std::write ONLY under the real workdir. Cleaned in
// finally, assertion failures included.
const base = mkdtempSync(join(tmpdir(), "cf-policy-"));
const homeProbeName = `.agency-contained-test-${randomBytes(6).toString("hex")}`;
const homeProbePath = join(homedir(), homeProbeName);
if (existsSync(homeProbePath)) {
  throw new Error(`home probe already exists: ${homeProbePath}`);
}
try {
  const work = join(base, "work");
  const outside = join(base, "outside");
  mkdirSync(work);
  mkdirSync(outside);
  mkdirSync(join(work, "real-sub"));
  symlinkSync(outside, join(work, "out-link"));
  symlinkSync(join(work, "real-sub"), join(work, "in-link"));
  symlinkSync(outside, join(base, "dir-link"));
  const realWork = realpathSync(work);
  const realOutside = realpathSync(outside);

  const policyFile = join(base, "policy.json");
  writeFileSync(policyFile, JSON.stringify({
    "std::write": [
      { match: { dir: `{${realWork},${realWork}/**}` }, action: "approve" },
    ],
  }));

  const result = await main({
    policyFile,
    workDir: work,
    outsideDir: outside,
    homeProbe: `~/${homeProbeName}`,
  });
  const r = result.data;

  writeFileSync("__result.json", JSON.stringify({
    // The migrated destination rule: dir carries the destination, the
    // policy judges it truthfully in both directions.
    outsideRejectedByPolicy: r.outsideDir.outcome === "policy-rejected"
      && r.outsideDir.reached && r.outsideDir.dir === realOutside,
    workApproved: r.workDir.outcome === "ok"
      && readFileSync(join(work, "report.txt"), "utf8") === "cf-e2e",
    noOutsideReport: !existsSync(join(outside, "report.txt")),
    // Escapes die in preparation: the handler never sees them.
    tildePrep: r.tildeEscape.outcome === "prep-rejected" && !r.tildeEscape.reached
      && !existsSync(homeProbePath),
    absolutePrep: r.absoluteEscape.outcome === "prep-rejected" && !r.absoluteEscape.reached
      && !existsSync(join(outside, "abs-escape.txt")),
    upwardPrep: r.upwardEscape.outcome === "prep-rejected" && !r.upwardEscape.reached
      && !existsSync(join(outside, "up-escape.txt")),
    // Stable symlinks: an escaping one dies in preparation, an in-work one
    // is approved and lands on the real target.
    outLinkPrep: r.outLinkEscape.outcome === "prep-rejected" && !r.outLinkEscape.reached
      && !existsSync(join(outside, "link-escape.txt")),
    inLinkApproved: r.inLinkWrite.outcome === "ok"
      && readFileSync(join(work, "real-sub", "linked.txt"), "utf8") === "cf-e2e",
    // A symlink supplied AS dir: the interrupt reports the real outside
    // path, the workdir policy rejects it, and nothing is created.
    dirLinkRejected: r.dirLinkWrite.outcome === "policy-rejected"
      && r.dirLinkWrite.reached && r.dirLinkWrite.dir === realOutside
      && !existsSync(join(outside, "f.txt")),
  }, null, 2));
} finally {
  rmSync(base, { recursive: true, force: true });
  rmSync(homeProbePath, { force: true });
}
