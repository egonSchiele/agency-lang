import { __ctx } from "../runtime/asyncContext.js";

/**
 * Turn markers for the statelog. The runtime has no notion of a "turn": an
 * interactive agent session is one long agentRun span, so its wall clock
 * counts the minutes a person spent typing the next message. The agent's
 * turn loop calls these around each turn, and the logs viewer sums the
 * turns instead of the envelope when it reports how long the agent worked.
 */

/** Record the start of a user turn; hand the result to `_turnEnd`. */
export function _turnStart(): number {
  void __ctx()?.statelogClient.turnStart();
  return Date.now();
}

/** Record the end of the turn `_turnStart` opened. */
export function _turnEnd(startedAt: number): void {
  void __ctx()?.statelogClient.turnEnd({ timeTaken: Date.now() - startedAt });
}
