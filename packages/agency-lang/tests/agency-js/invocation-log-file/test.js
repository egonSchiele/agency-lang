import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The folder does not exist under the temp folder until the run makes it.
const dir = mkdtempSync(join(tmpdir(), "invocation-log-file-"));
const logFile = join(dir, "app-home", "log.jsonl");
const otherFile = join(dir, "other.jsonl");

const events = (file) =>
  existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").length : 0;

// Observability is off in this test's config, so it is turned on for each
// call, which `config` may do. The file is named beside it, not inside it.
const options = { config: { observability: true }, logFile };

let result;
try {
  const paused = await main(options);
  const afterStart = events(logFile);

  // A path inside `config` is not a log file: it may come from a request.
  const ignored = await main({
    config: { observability: true, log: { logFile: otherFile } },
  });

  const finished = await respondToInterrupts(paused.data, [approve("hello")], {
    invocation: options,
  });
  const afterResume = events(logFile);

  // A resume does not remember the file. With none named, nothing more is
  // written to it.
  await respondToInterrupts(ignored.data, [approve("again")], {
    invocation: { config: { observability: true } },
  });

  result = {
    theRunPaused: hasInterrupts(paused.data),
    theStartWroteToTheNamedFile: afterStart > 0,
    theResumeWroteMoreToIt: afterResume > afterStart,
    theResumeFinished: finished.data,
    aPathInConfigIsNotOpened: !existsSync(otherFile),
    aResumeThatNamesNoFileWritesNothingToIt: events(logFile) === afterResume,
  };
} finally {
  rmSync(dir, { recursive: true, force: true });
}

writeFileSync("__result.json", JSON.stringify(result, null, 2));
