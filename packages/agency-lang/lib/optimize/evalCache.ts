import type { AgentRun } from "./grading/types.js";

/** Memoizes one AgentRun per (workspaceKey, inputId). Null-prototype: keys derive from user inputs. */
export class EvalCache {
  private readonly runs: Record<string, Promise<AgentRun>> = Object.create(null);

  get(workspaceKey: string, inputId: string, produce: () => Promise<AgentRun>): Promise<AgentRun> {
    const key = `${workspaceKey} ${inputId}`;
    if (!Object.hasOwn(this.runs, key)) {
      this.runs[key] = produce();
    }
    return this.runs[key];
  }
}
