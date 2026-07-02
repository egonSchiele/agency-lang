import { main, hasInterrupts } from "./agent.js";
import { writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";

const first = await main();
if (!hasInterrupts(first.data)) {
  writeFileSync("__result.json", JSON.stringify({
    error: "expected surfaced interrupt, got: " + JSON.stringify(first.data),
  }));
  process.exit(0);
}

// Persist exactly what a user would persist: the surfaced Interrupt[] as
// JSON. Then destroy every compiled artifact and this process's memory by
// resuming in a FRESH Node process — the spec's durability claim.
writeFileSync("persisted-interrupts.json", JSON.stringify(first.data));
rmSync(".agency-tmp", { recursive: true, force: true });

execFileSync(process.execPath, ["./resume-stage.js"], { stdio: "inherit" });
