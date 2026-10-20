// Every program a unit test runs on the Node host registers for attach,
// which writes a record under the sessions directory. That directory must
// never be the real `~/.agency` during a test run, nor a developer's own
// AGENCY_HOME, so the whole run gets one temporary Agency home, made here
// before the workers are forked (they inherit the environment) and removed
// when the run ends. Records are named by pid, so the workers never collide
// in it. A setup file per worker cannot do this: vitest ends a forked
// worker without an `exit` event, so a per-worker directory was never
// removed.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export default function setup(): () => void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agency-home-test-"));
  process.env.AGENCY_HOME = home;
  return () => {
    fs.rmSync(home, { recursive: true, force: true });
  };
}
