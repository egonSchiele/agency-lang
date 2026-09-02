// The simple brain: one LLM call per turn, no tools.
import type { AgentBrain } from "./brain.js";

export const simpleBrain: AgentBrain = {
  name: "simple",
  runTurn: async (userMessage) => callModel(userMessage),
};

async function callModel(prompt: string): Promise<string> {
  void prompt;
  return "";
}
