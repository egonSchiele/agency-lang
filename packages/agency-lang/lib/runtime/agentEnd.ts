// The `onAgentEnd` hook at the end of a run, fired from the leg that
// produced the final value while its execution context is alive, so every
// source fires: global hooks, the program's own `callback("onAgentEnd")`,
// the caller's callback, and the relay to a `std::agency` parent, with
// `callHook`'s error guard. `runNodeCore` fires it when its own leg ends;
// a leg an attached debugger resumed fires it when the run began in
// `runNode`, which `ATTACHED_AGENT_END` on the resume's metadata says.
import { freshState, logOf, withRun, type Lineage } from "./asyncContext.js";
import { callHook } from "./hooks.js";
import type { RuntimeContext } from "./state/context.js";
import type { ThreadStore } from "./state/threadStore.js";
import type { GraphState, RunNodeCoreResult } from "./types.js";

/** The metadata key an attached debugger sets on its resumes and rewinds
 *  when the run began in `runNode`, whose first leg would have fired
 *  `onAgentEnd` had it not stopped. A resume the caller issued itself
 *  fires nothing, with or without a debugger. */
export const ATTACHED_AGENT_END = "attachedAgentEnd";

export function firesAgentEnd(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[ATTACHED_AGENT_END] === true;
}

/** `lineage` is the run's, read by the caller on its first line, before
 *  any await, since the current run is only current until then. */
export async function fireAgentEnd(
  execCtx: RuntimeContext<GraphState>,
  nodeName: string,
  returnObject: RunNodeCoreResult<any>,
  threads: ThreadStore,
  lineage: Lineage,
): Promise<void> {
  // The hook fires after the run finished, so the frame is seeded with
  // the run's real thread store: a callback that inspects the final
  // conversation through a stdlib helper sees the actual messages.
  await withRun(
    {
      ctx: execCtx,
      stack: execCtx.stateStack,
      threads,
      globals: execCtx.globals,
      log: logOf(execCtx, execCtx.globals),
      state: freshState(),
      ...lineage,
    },
    (run) =>
      callHook(run, {
        name: "onAgentEnd",
        data: {
          nodeName,
          result: {
            ...returnObject,
            usage: execCtx.invocationUsage.snapshot(),
            traceId: execCtx.getRunId(),
          },
        },
      }),
  );
}
