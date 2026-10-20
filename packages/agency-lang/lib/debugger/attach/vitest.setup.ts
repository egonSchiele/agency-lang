// Every program a unit test runs on the Node host registers for attach,
// which writes a record under the sessions directory. That directory must
// never be the real `~/.agency` during a test run, so each worker gets a
// temporary Agency home, shared by every test file the worker runs: the
// registration is once per process, and a file that comes later must find
// the record where the first one wrote it.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

if (process.env.AGENCY_HOME === undefined || process.env.AGENCY_HOME === "") {
  process.env.AGENCY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-test-"));
}
