// `agency agent -p` through the session core: it prints the reply, the
// model is told a write no rule covers was declined because no one is
// there to ask, nothing is saved, and the run offers no job tools.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "agent-oneshot-home-"));
const project = mkdtempSync(path.join(os.tmpdir(), "agent-oneshot-project-"));
// A saved policy with no rules, so the write is covered by none, and a
// saved search choice, so no note about picking one is printed.
writeFileSync(path.join(home, "policy.json"), "{}");
writeFileSync(path.join(home, "settings.json"), JSON.stringify({ search: { backend: "hosted" } }));

const ran = spawnSync(process.execPath, ["./stage.js"], {
  input: "",
  encoding: "utf8",
  env: {
    ...process.env,
    AGENCY_AGENT_HOME: home,
    ANTHROPIC_API_KEY: "test-key",
    ONE_SHOT_PROJECT: project,
    NO_COLOR: "1",
  },
  timeout: 60_000,
});

const stdout = ran.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const lines = stdout.split("\n").filter((line) => line.trim() !== "");
const offered = /TOOLS_OFFERED=(.*)/.exec(ran.stderr)?.[1] ?? "[]";
writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      firstLineIsTheReply: lines[0]?.startsWith("REPLY: ") ?? false,
      modelReadTheReason: stdout.includes("this is a non-interactive run"),
      otherLines: lines.slice(1).map((line) => line.replace(/\$[0-9.]+/, "$N")),
      noteWritten: existsSync(path.join(project, "note.txt")),
      sessionSaved: existsSync(path.join(home, "sessions")),
      offersStartJob: JSON.parse(offered).includes("startJob"),
    },
    null,
    2,
  ),
);
