import { describe, expect, it } from "vitest";
import * as driver from "./index.js";

// Front-ends reach the driver only through this file
// (`agency-lang/stdlib-lib/agentDriver/index.js`).
describe("the driver's entry point", () => {
  it("exports what a front-end calls", () => {
    const names = [
      "SESSION_INPUT_EFFECT",
      "messageAnswer",
      "pauseData",
      "withPauseLeftAlone",
      "startRun",
      "resumeRun",
      "toStep",
      "withCancelNote",
      "startQueue",
      "respondWith",
      "currentApproval",
      "declineUndecided",
      "initialPhase",
      "reduceDriver",
      "savedRun",
      "restoredPhase",
      "saveRun",
      "takeHold",
      "stillHeld",
    ];
    expect(names.filter((name) => !(name in driver))).toEqual([]);
  });
});
