// Agent harness entry: sessions, checkpoint save/resume between turns,
// and the approval flow. Coupled to the runtime's checkpoint format, so
// it versions with the compiler.
import { saveCheckpoint, resumeCheckpoint, type Checkpoint } from "waypoint-lang/runtime";

import { brains } from "../brains/registry.js";
import { runTurn } from "./turnLoop.js";

export async function main(args: string[]): Promise<void> {
  const brainName = args.includes("--brain") ? args[args.indexOf("--brain") + 1] : "planner";
  const brain = brains[brainName];
  if (brain === undefined) {
    throw new Error(`no brain named ${brainName}`);
  }
  let checkpoint: Checkpoint | null = null;
  for (;;) {
    if (checkpoint !== null) {
      resumeCheckpoint(checkpoint);
    }
    const done = await runTurn(brain);
    checkpoint = saveCheckpoint([], {});
    if (done) {
      return;
    }
  }
}
