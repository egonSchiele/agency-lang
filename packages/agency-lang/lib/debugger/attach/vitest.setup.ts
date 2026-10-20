// Every program a unit test runs on the Node host registers for attach,
// which writes a record under the sessions directory. That directory must
// never be the real `~/.agency` during a test run, nor a developer's own
// AGENCY_HOME, so each worker gets a temporary Agency home, shared by
// every test file the worker runs: the registration is once per process,
// and a file that comes later must find the record where the first one
// wrote it. The directory is removed when the worker exits.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-test-"));
process.env.AGENCY_HOME = home;
process.on("exit", () => {
  fs.rmSync(home, { recursive: true, force: true });
});
