import { makeStatelogTailer } from "@/statelog/tail.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

/**
 * Running total of a live run's LLM spend: the cost each promptCompletion
 * event records, summed as the statelog grows. Feeds the spawn runner's
 * cost cap and the parallel status board's cost column.
 */
export function makeStatelogCostTailer(statelogPath: string): { poll(): number } {
  const tailer = makeStatelogTailer(statelogPath);
  let total = 0;
  return {
    poll(): number {
      for (const event of tailer.poll()) {
        total += promptCompletionCost(event);
      }
      return total;
    },
  };
}

function promptCompletionCost(event: EventEnvelope): number {
  if (event.data.type !== "promptCompletion") {
    return 0;
  }
  const cost = event.data.cost?.totalCost;
  const isPayable = typeof cost === "number" && Number.isFinite(cost) && cost > 0;
  return isPayable ? cost : 0;
}
