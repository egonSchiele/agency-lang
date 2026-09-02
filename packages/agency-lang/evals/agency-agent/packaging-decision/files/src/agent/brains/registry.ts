// Every brain the harness can launch, by name.
import type { AgentBrain } from "./brain.js";
import { simpleBrain } from "./simple.js";
import { plannerBrain } from "./planner/planner.js";

export const brains: Record<string, AgentBrain> = {
  simple: simpleBrain,
  planner: plannerBrain,
};
