# The agent: harness and brains

`waypoint agent` splits into a harness and pluggable brains.

The harness (`src/agent/harness/`) owns sessions, checkpoint save and
resume, and the approval flow. It depends on the runtime's checkpoint
format, so it has to version with the compiler: a harness built against
one checkpoint format cannot resume sessions written by another.

A brain (`src/agent/brains/`) is everything that changes week to week:
prompts, tool selection, turn strategy. A brain implements the
`AgentBrain` type in `src/agent/brains/brain.ts` and touches nothing in
the harness beyond that interface. `simple` makes one LLM call per turn.
`planner` is the sophisticated multi-step brain, and nearly every agent
release exists to update it — usually its prompts.

The CLI launches the agent as a separate child process
(`src/cli/runBundledAgent.ts`); the agent reaches the rest of the
package only through its public `exports`.
