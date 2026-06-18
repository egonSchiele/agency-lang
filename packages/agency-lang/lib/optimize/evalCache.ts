import type { AgentRun } from "./grading/types.js";

/**
 * Memoizes one AgentRun per (workspaceKey, inputId). A nested store avoids any
 * separator-collision between the two components (a flat `${ws} ${id}` or
 * `${ws}-${id}` key can collide, e.g. workspace keys are themselves `ws-N`).
 * Null-prototype maps since both keys can derive from user input.
 */
export class EvalCache {
  private readonly runs: Record<string, Record<string, Promise<AgentRun>>> = Object.create(null);

  get(workspaceKey: string, inputId: string, produce: () => Promise<AgentRun>): Promise<AgentRun> {
    const byInput = (this.runs[workspaceKey] ??= Object.create(null));
    if (!Object.hasOwn(byInput, inputId)) {
      byInput[inputId] = produce();
    }
    return byInput[inputId];
  }
}
