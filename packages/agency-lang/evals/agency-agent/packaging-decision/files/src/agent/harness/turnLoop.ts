// One turn: read the user's message, hand it to the brain, print the
// reply. Approval prompts for risky tool calls live here, not in brains.
import type { AgentBrain } from "../brains/brain.js";

export async function runTurn(brain: AgentBrain): Promise<boolean> {
  const message = await readUserMessage();
  if (message === null) {
    return true;
  }
  console.log(await brain.runTurn(message));
  return false;
}

async function readUserMessage(): Promise<string | null> {
  return null;
}
