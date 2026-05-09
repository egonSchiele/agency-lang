# MCP Interrupt Policies

## Problem

When an Agency agent is served over MCP, there's no interactive user to approve or reject interrupts. MCP is a tool-call protocol — the client calls a tool and expects a result back. There's no built-in mechanism for mid-execution approval flows.

Without a solution, any agent that uses interrupts (safety checks, confirmations, capability gates) cannot be served over MCP.

## Design

The MCP server uses Agency's existing policy system to pre-authorize interrupts. The MCP client (typically an LLM agent) sets up policies before calling tools, and the server automatically handles interrupts using those policies during execution. The agent author doesn't need to do anything special — the MCP server wraps every invocation in a handler that applies the policy.

### User experience

1. Client calls `tools/list` — each tool's description includes its interrupt kinds (e.g. `Interrupt kinds: email::send, shell::exec`), surfaced from static analysis
2. Client calls the `setPolicy` tool to pre-authorize actions:
   ```json
   {
     "email::send": [
       { "match": { "recipient": "*@company.com" }, "action": "approve" },
       { "action": "reject" }
     ]
   }
   ```
3. Client calls the agent's tool — it runs to completion. Interrupts that match the policy are automatically approved; unmatched interrupts are rejected.
4. If a rejection causes the tool call to fail, the MCP client gets an error result. If the agent handles the rejection gracefully (via catch, fallback logic, etc.), the client gets a normal result.

The client never sees raw interrupts. Actions are either pre-authorized or they don't happen.

### Default behavior

When no policy is set, or when an interrupt's kind isn't covered by any policy rule, the interrupt is **rejected**. This is safe by default — nothing happens without explicit authorization.

Note: `checkPolicy` returns `propagate` for unmatched interrupts. In the MCP context, `propagate` is treated as `reject`, since there is no one to propagate to.

### Policy management tools

The MCP server exposes three built-in tools alongside the agent's own tools:

**`agencyGetPolicy`** — Returns the current policy as JSON. Takes no arguments.

**`agencySetPolicy`** — Replaces the current policy. The tool description explains the policy format so the MCP client can construct it:

Input schema:
```json
{
  "type": "object",
  "properties": {
    "policy": {
      "type": "object",
      "description": "Policy object keyed by interrupt kind. Each kind maps to an ordered array of rules. Each rule has an 'action' field ('approve' or 'reject') and an optional 'match' field — an object whose keys are interrupt data field names and whose values are glob patterns (e.g. '*@company.com'). Rules are evaluated in order; the first match wins. A rule with no 'match' field is a catch-all. Check each tool's interrupt kinds to see what kinds to write rules for."
    }
  },
  "required": ["policy"]
}
```

Tool description:
> Set the interrupt policy for this agent. The policy controls which actions the agent is allowed to take autonomously. Each tool lists its interrupt kinds — use those as keys in the policy object. Example: `{"email::send": [{"match": {"recipient": "*@company.com"}, "action": "approve"}, {"action": "reject"}]}` approves sending emails to company.com addresses and rejects all others.

The policy is validated with `validatePolicy` before being applied. Invalid policies return an error. The policy is persisted to disk so it survives server restarts.

**`agencyClearPolicy`** — Resets the policy to empty (reject-all). Takes no arguments.

The `agency` prefix prevents name collisions with the agent's own tools.

### Interrupt handling loop

When the MCP server calls a tool or node, it wraps the invocation in an automatic interrupt-handling loop:

1. Call the function/node
2. Check `hasInterrupts(result.data)`
3. If no interrupts: return the result to the MCP client
4. If interrupted: for each interrupt, call `checkPolicy(policy, interrupt)` and map the result to `approve()` or `reject()` (treating `propagate` as `reject`)
5. Call `respondToInterrupts` with the interrupt array and the response array
6. Go to step 2

This loop continues until execution completes (no more interrupts) or until a rejection causes the execution to fail. The MCP client receives whatever the agent ultimately returns.

### How the handler wrapping works

The handler is not applied at the Agency language level. The MCP adapter wraps invocations at the JavaScript level, using the compiled module's exported `hasInterrupts` and `respondToInterrupts` functions.

For functions, the adapter calls `agencyFunction.invoke(...)`, checks the result, and loops with `respondToInterrupts` if needed.

For nodes, the adapter calls `node.invoke(...)`, checks `result.data`, and loops similarly.

The key insight: `respondToInterrupts` already knows how to resume from an interrupt checkpoint with approve/reject responses. The MCP adapter just automates the same flow that an interactive user would perform manually.

### Policy persistence

Policies are persisted to `~/.agency/serve/<server-name>/policy.json`, following the same pattern as schedule persistence (`~/.agency/schedules/`).

- The directory is created on first write with mode `0o700`
- The policy file is written with mode `0o600` (user-readable only)
- On server startup, the persisted policy is loaded if it exists
- `setPolicy` and `clearPolicy` write through to disk immediately
- The `server-name` is the `--name` flag value, or the filename without `.agency`

### Implementation

The implementation touches three areas:

**1. Policy store (`lib/serve/policyStore.ts`)**

A small class that manages the in-memory policy and its disk persistence:

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { validatePolicy } from "../runtime/policy.js";

type Policy = Record<string, Array<{ match?: Record<string, string>; action: "approve" | "reject" | "propagate" }>>;

export class PolicyStore {
  private policy: Policy = {};
  private filePath: string;

  constructor(serverName: string) {
    const dir = path.join(os.homedir(), ".agency", "serve", serverName);
    this.filePath = path.join(dir, "policy.json");
    this.load();
  }

  get(): Policy { return this.policy; }

  set(policy: Policy): void {
    const result = validatePolicy(policy);
    if (!result.success) throw new Error(result.error);
    this.policy = policy;
    this.save();
  }

  clear(): void {
    this.policy = {};
    this.save();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    this.policy = JSON.parse(readFileSync(this.filePath, "utf-8"));
  }

  private save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, JSON.stringify(this.policy, null, 2), { mode: 0o600 });
  }
}
```

**2. Interrupt loop (`lib/serve/mcp/interruptLoop.ts`)**

A function that runs a tool/node invocation with automatic policy-based interrupt handling:

```typescript
import { checkPolicy } from "../../runtime/policy.js";
import { approve, reject, hasInterrupts } from "../../runtime/interrupts.js";
import type { PolicyStore } from "../policyStore.js";

type InterruptHandlers = {
  hasInterrupts: (data: unknown) => boolean;
  respondToInterrupts: (interrupts: unknown[], responses: unknown[]) => Promise<unknown>;
};

export async function runWithPolicy(
  invoke: () => Promise<unknown>,
  policyStore: PolicyStore,
  handlers: InterruptHandlers,
): Promise<unknown> {
  let result = await invoke();

  while (handlers.hasInterrupts(result)) {
    const interrupts = result as Array<{ kind: string; message: string; data: any; origin: string }>;
    const policy = policyStore.get();
    const responses = interrupts.map((interrupt) => {
      const decision = checkPolicy(policy, interrupt);
      return decision.type === "approve" ? approve() : reject();
    });
    result = await handlers.respondToInterrupts(interrupts, responses);
  }

  return result;
}
```

Note: `result` from a node invocation is `{ data: ... }`, and `hasInterrupts` checks `result.data`. The exact shape will need to match what the compiled module's `hasInterrupts` and `respondToInterrupts` exports expect.

**3. MCP adapter changes (`lib/serve/mcp/adapter.ts`)**

- `McpConfig` gains a `policyStore` field and interrupt handler functions (`hasInterrupts`, `respondToInterrupts`)
- The `tools/call` handler wraps function/node invocations with `runWithPolicy`
- Three new tool entries are added to `toolsListPayload`: `agencyGetPolicy`, `agencySetPolicy`, `agencyClearPolicy`
- The `tools/call` switch handles these three tools before checking agent tools

**4. CLI wiring (`lib/cli/serve.ts`)**

- `serveMcp` creates a `PolicyStore` with the server name and passes it into `McpConfig`
- `hasInterrupts` and `respondToInterrupts` are passed from the module exports, same as the HTTP adapter already does
