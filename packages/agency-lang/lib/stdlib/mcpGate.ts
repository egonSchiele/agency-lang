import { agency } from "../runtime/agency.js";
import { isApproved } from "../runtime/interrupts.js";

export type CallToolFn = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>;

const EFFECT = "mcp::call";

/** Wrap a real callTool so each invocation raises `mcp::call` and calls the
 *  underlying tool ONLY on an explicit approve. Runs inside a fresh resumable
 *  scope so agency.interrupt always has a Runner-seeded frame. FAIL-CLOSED:
 *  reject, propagate (no handler), or any non-approve outcome blocks the call.
 *  In the agent cliPolicyHandler is always installed and resolves approve or
 *  reject; the fail-closed default guards reuse outside that wiring and the
 *  --print path. */
export function gate(realCallTool: CallToolFn): CallToolFn {
  return async (server, tool, args) => {
    const response = await agency.withResumableScope(
      { name: `mcp:${server}:${tool}` },
      async (s) =>
        s.step(() =>
          agency.interrupt({
            effect: EFFECT,
            message: `MCP tool call: ${server} → ${tool}`,
            data: { server, tool, args },
          }),
        ),
    );
    if (isApproved(response)) {
      return realCallTool(server, tool, args);
    }
    return `The MCP call to ${server}/${tool} was not approved by the policy.`;
  };
}
