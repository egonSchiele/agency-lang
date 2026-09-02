// The planner brain: the sophisticated multi-step brain. Nearly every
// agent release exists to update this directory, usually prompts.ts.
import type { AgentBrain } from "../brain.js";
import { PLANNER_SYSTEM_PROMPT, REFLECT_PROMPT } from "./prompts.js";

export const plannerBrain: AgentBrain = {
  name: "planner",
  runTurn: async (userMessage) => {
    const plan = await callModel(PLANNER_SYSTEM_PROMPT, userMessage);
    return callModel(REFLECT_PROMPT, plan);
  },
};

async function callModel(system: string, prompt: string): Promise<string> {
  void system;
  void prompt;
  return "";
}
