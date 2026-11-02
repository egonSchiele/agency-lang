import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function runScenario(name) {
  // The agent caches startup instructions in module statics. Each process
  // represents a separate launch, with its own in-memory filesystem.
  return JSON.parse(execFileSync(process.execPath, ["./scenario.mjs", name], { encoding: "utf8" }));
}

const first = runScenario("default");
const second = runScenario("other-directory");
const override = runScenario("override");
const absent = runScenario("absent");
const empty = runScenario("empty");
const singular = runScenario("singular");
const unreadable = runScenario("unreadable");

mkdirSync("test-output", { recursive: true });
const started = runScenario("start");
const resumed = runScenario("resume");

writeFileSync(
  "__result.json",
  JSON.stringify(
    {
      defaultHome: first.global.includes("GLOBAL_PREF_V1"),
      independentOfWorkingDirectory: second.global === first.global,
      projectAgentsPreferred:
        first.project.includes("PROJECT_PREF") && !first.project.includes("CLAUDE_FALLBACK"),
      projectClaudeFallback: second.project.includes("CLAUDE_FALLBACK"),
      globalAndProjectSeparate: !first.project.includes("GLOBAL_PREF_V1"),
      alternateHome:
        override.global.includes("OVERRIDE_PREF") && !override.global.includes("GLOBAL_PREF_V1"),
      absentOptional: absent.global === "",
      blankOptional: empty.global === "",
      singularIgnored: singular.global === "",
      unreadableOptional: unreadable.content === "",
      unreadableWarned: unreadable.warned,
      checkpointHasNoStaleInstructions: started.checkpointHasNoStaleInstructions,
      resumed,
    },
    null,
    2,
  ),
);
