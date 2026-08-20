import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// A real directory plus a symlink to it: every wrapper is called through
// the LINK with an un-normalized filename, and the recording handler in
// agent.agency approves only payloads carrying the REAL dir and the
// normalized filename.
const base = mkdtempSync(join(tmpdir(), "cf-wrappers-"));
try {
  const real = join(base, "real");
  mkdirSync(real);
  const linkDir = join(base, "dir-link");
  symlinkSync(real, linkDir);
  const result = await main({ realDir: realpathSync(real), linkDir });
  writeFileSync("__result.json", JSON.stringify(result.data, null, 2));
} finally {
  rmSync(base, { recursive: true, force: true });
}
