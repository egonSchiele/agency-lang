// The agent's session program (lib/agents/agency-agent/program.agency),
// compiled. It has no declarations of its own, since it is Agency code, so
// the part the terminal's driver calls is declared here. What the program
// takes and reports is typed in lib/stdlib/agentDriver/interface.ts.
declare module "agency-lang/agent-session" {
  import type { Interrupt, InterruptResponse } from "../runtime/interrupts.js";
  import type { RunNodeResult } from "../runtime/types.js";

  export function main(start: unknown, opts: unknown): Promise<RunNodeResult<unknown>>;
  export function respondToInterrupts(
    interrupts: Interrupt[],
    responses: InterruptResponse[],
    opts: unknown,
  ): Promise<RunNodeResult<unknown>>;
}
