// The run's temporary Agency home is made in vitest.globalSetup.ts and
// reaches every worker through the environment. A worker started some
// other way, with no global setup, still must not write under the real
// `~/.agency`, so it gets a throwaway directory of its own here.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

if (process.env.AGENCY_HOME === undefined || process.env.AGENCY_HOME === "") {
  process.env.AGENCY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-test-"));
}
