// A background job's runner process: `node runnerMain.js <job folder>`.
// `launchJob` starts it detached (detachedJobs.ts). It loads only the Node
// host and the runner, not the `agency` command line, so it starts quickly
// on a busy machine. Everything it prints goes to the job's runner.log.
import { nodeHost } from "../../host/node/nodeHost.js";
import { exitProcessNow } from "../exitProcess.js";
import { runJob } from "./jobRunner.js";

/** The exit code for a runner started without its job folder. */
const USAGE_ERROR = 2;

const dir = process.argv[2];
// The runner sends no logs, so there is nothing for an exit to wait on.
if (dir === undefined || dir === "") {
  console.error("Usage: runnerMain.js <job folder>");
  exitProcessNow(USAGE_ERROR);
}
await runJob(nodeHost(), dir);
exitProcessNow(0);
