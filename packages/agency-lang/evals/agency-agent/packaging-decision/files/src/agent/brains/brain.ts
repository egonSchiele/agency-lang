// The seam between the harness and a brain. A brain is everything that
// changes week to week — prompts, tool choices, turn strategy — and it
// touches nothing in the harness beyond this type.
export type AgentBrain = {
  name: string;
  runTurn: (userMessage: string) => Promise<string>;
};
