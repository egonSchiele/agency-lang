import { main, hasInterrupts } from "./agent.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { safeDeleteDirectoryWithin } from "../../../dist/lib/utils.js";

const fixtureRoot = process.cwd();
safeDeleteDirectoryWithin(fixtureRoot, resolve("test-output"));
mkdirSync("test-output/source", { recursive: true });
writeFileSync("test-output/source/tools.agency", `
import { remember } from "./helper.agency"
export def lookupSeries(seriesId: string, dir: string): string {
  return remember(seriesId, dir)
}
`);
writeFileSync("test-output/source/helper.agency", `
export def remember(seriesId: string, dir: string): string {
  handle {
    write("effects.log", "once\\n", dir, mode: "append")
    const pause = interrupt("pause learned call")
    const parent = interrupt("parent after resume")
    const child = interrupt("child after resume")
    return "remembered:" + seriesId
  } with (intr) {
    if (intr.message == "child after resume") {
      return approve()
    }
  }
}
`);
const paused = await main();
if (!hasInterrupts(paused.data)) {
  throw new Error(`Expected a learned-call interrupt: ${JSON.stringify(paused.data)}`);
}
writeFileSync("test-output/interrupts.json", JSON.stringify(paused.data));
writeFileSync("test-output/before.json", JSON.stringify({
  message: paused.data[0].message,
  effects: readFileSync("test-output/effects.log", "utf8"),
}));
// The runner already removes each materialized child program when it
// pauses. Remove only this fixture's source files before a new process
// resumes from the checkpoint's saved code and saved handler frames.
safeDeleteDirectoryWithin(fixtureRoot, resolve("test-output/source"));
execFileSync(process.execPath, ["./resume-stage.js"], { stdio: "inherit" });
