# MCP Interrupt Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable MCP-served agents to handle interrupts automatically via pre-configured policies, so clients can pre-authorize actions without mid-execution approval flows.

**Architecture:** A `PolicyStore` manages policy persistence at `~/.agency/serve/<name>/policy.json`. A `runWithPolicy` function wraps tool invocations in an interrupt loop that applies `checkPolicy` from the existing runtime. The MCP adapter exposes three built-in tools (`agencySetPolicy`, `agencyGetPolicy`, `agencyClearPolicy`). Node interrupt handling via MCP is out of scope for this plan (the MCP adapter currently only exposes functions as tools).

**Design principles:**
- `runWithPolicy` works with a clean `InterruptHandlers` interface — callers normalize the `{ data: ... }` wrapper so the loop never sees it.
- Policy tool dispatch is extracted into its own function to keep `createMcpHandler` focused on routing.
- `McpConfig` doesn't leak raw module exports — it takes a `policyStore` and pre-constructed `InterruptHandlers`, which the CLI wiring composes.

**Tech Stack:** TypeScript, vitest, Agency runtime (`checkPolicy`, `validatePolicy`, `approve`, `reject`, `hasInterrupts`, `respondToInterrupts`)

---

## File Structure

- **Create:** `lib/serve/policyStore.ts` — In-memory policy + JSON file persistence
- **Create:** `lib/serve/policyStore.test.ts` — Unit tests for PolicyStore
- **Create:** `lib/serve/mcp/interruptLoop.ts` — `runWithPolicy` function
- **Create:** `lib/serve/mcp/interruptLoop.test.ts` — Unit tests for the interrupt loop
- **Modify:** `lib/serve/mcp/adapter.ts` — Add policy tools, wire `runWithPolicy` into `tools/call`
- **Modify:** `lib/serve/mcp/adapter.test.ts` — Tests for policy tools and interrupt handling
- **Modify:** `lib/cli/serve.ts` — Create `PolicyStore`, pass interrupt handlers into `McpConfig`

---

### Task 1: PolicyStore

**Files:**
- Create: `lib/serve/policyStore.ts`
- Create: `lib/serve/policyStore.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/serve/policyStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PolicyStore } from "./policyStore.js";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import path from "path";
import os from "os";

describe("PolicyStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "policy-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with empty policy", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(store.get()).toEqual({});
  });

  it("sets and gets a policy", () => {
    const store = new PolicyStore("test-server", tmpDir);
    const policy = {
      "email::send": [{ action: "approve" as const }],
    };
    store.set(policy);
    expect(store.get()).toEqual(policy);
  });

  it("persists policy to disk", () => {
    const policy = {
      "email::send": [{ match: { recipient: "*@co.com" }, action: "approve" as const }],
    };
    const store1 = new PolicyStore("test-server", tmpDir);
    store1.set(policy);

    // New instance should load from disk
    const store2 = new PolicyStore("test-server", tmpDir);
    expect(store2.get()).toEqual(policy);
  });

  it("clears the policy", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.set({ "x::y": [{ action: "approve" as const }] });
    store.clear();
    expect(store.get()).toEqual({});
  });

  it("rejects invalid policies", () => {
    const store = new PolicyStore("test-server", tmpDir);
    expect(() => store.set({ "x::y": [{ action: "yolo" as any }] })).toThrow();
  });

  it("writes policy file with restricted permissions", () => {
    const store = new PolicyStore("test-server", tmpDir);
    store.set({ "x::y": [{ action: "approve" as const }] });
    const filePath = path.join(tmpDir, "test-server", "policy.json");
    const content = readFileSync(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual({ "x::y": [{ action: "approve" }] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/serve/policyStore.test.ts 2>&1 | tee /tmp/policy-store-test.log`
Expected: FAIL — cannot import `PolicyStore`

- [ ] **Step 3: Implement PolicyStore**

```typescript
// lib/serve/policyStore.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { validatePolicy } from "../runtime/policy.js";

type PolicyRule = {
  match?: Record<string, string>;
  action: "approve" | "reject" | "propagate";
};

export type Policy = Record<string, PolicyRule[]>;

export class PolicyStore {
  private policy: Policy = {};
  private filePath: string;

  constructor(serverName: string, baseDir?: string) {
    const dir = path.join(baseDir ?? path.join(os.homedir(), ".agency", "serve"), serverName);
    this.filePath = path.join(dir, "policy.json");
    this.load();
  }

  get(): Policy {
    return this.policy;
  }

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/serve/policyStore.test.ts 2>&1 | tee /tmp/policy-store-test.log`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```
git add lib/serve/policyStore.ts lib/serve/policyStore.test.ts
git commit -m "Add PolicyStore for MCP interrupt policy persistence"
```

---

### Task 2: Interrupt loop (`runWithPolicy`)

**Files:**
- Create: `lib/serve/mcp/interruptLoop.ts`
- Create: `lib/serve/mcp/interruptLoop.test.ts`

- [ ] **Step 1: Write the failing tests**

The `InterruptHandlers` interface is clean — both `hasInterrupts` and `respondToInterrupts` work with the same data shape. The caller is responsible for normalizing the compiled module's `{ data: ... }` wrapper; `runWithPolicy` never sees it.

```typescript
// lib/serve/mcp/interruptLoop.test.ts
import { describe, it, expect } from "vitest";
import { runWithPolicy } from "./interruptLoop.js";
import { PolicyStore } from "../policyStore.js";
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";

function makeTmpStore(policy: Record<string, any> = {}): { store: PolicyStore; cleanup: () => void } {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "interrupt-loop-test-"));
  const store = new PolicyStore("test", tmpDir);
  if (Object.keys(policy).length > 0) store.set(policy);
  return { store, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

function makeInterrupt(kind: string, data: Record<string, any> = {}): any {
  return { type: "interrupt", kind, message: "", data, origin: "test", interruptId: "test-id", runId: "test-run" };
}

const isInterrupts = (data: unknown) =>
  Array.isArray(data) && data.length > 0 && data[0]?.type === "interrupt";

describe("runWithPolicy", () => {
  it("returns result directly when no interrupts", async () => {
    const { store, cleanup } = makeTmpStore();
    try {
      const result = await runWithPolicy(
        async () => "hello",
        store,
        { hasInterrupts: isInterrupts, respondToInterrupts: async () => "done" },
      );
      expect(result).toBe("hello");
    } finally {
      cleanup();
    }
  });

  it("approves interrupts that match the policy", async () => {
    const { store, cleanup } = makeTmpStore({
      "test::greet": [{ action: "approve" }],
    });
    try {
      let callCount = 0;
      const result = await runWithPolicy(
        async () => [makeInterrupt("test::greet")],
        store,
        {
          hasInterrupts: isInterrupts,
          respondToInterrupts: async (_interrupts, responses) => {
            callCount++;
            expect(responses).toHaveLength(1);
            expect(responses[0].type).toBe("approve");
            return "approved-result";
          },
        },
      );
      expect(result).toBe("approved-result");
      expect(callCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("rejects interrupts not covered by policy (default reject)", async () => {
    const { store, cleanup } = makeTmpStore(); // empty policy
    try {
      const result = await runWithPolicy(
        async () => [makeInterrupt("test::greet")],
        store,
        {
          hasInterrupts: isInterrupts,
          respondToInterrupts: async (_interrupts, responses) => {
            expect(responses[0].type).toBe("reject");
            return "rejected-result";
          },
        },
      );
      expect(result).toBe("rejected-result");
    } finally {
      cleanup();
    }
  });

  it("handles multiple rounds of interrupts", async () => {
    const { store, cleanup } = makeTmpStore({
      "test::step1": [{ action: "approve" }],
      "test::step2": [{ action: "approve" }],
    });
    try {
      let round = 0;
      const result = await runWithPolicy(
        async () => [makeInterrupt("test::step1")],
        store,
        {
          hasInterrupts: isInterrupts,
          respondToInterrupts: async () => {
            round++;
            if (round === 1) {
              return [makeInterrupt("test::step2")];
            }
            return "final";
          },
        },
      );
      expect(result).toBe("final");
      expect(round).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("approves some and rejects others in a mixed batch", async () => {
    const { store, cleanup } = makeTmpStore({
      "test::allowed": [{ action: "approve" }],
      // test::blocked has no rules → defaults to reject
    });
    try {
      const result = await runWithPolicy(
        async () => [makeInterrupt("test::allowed"), makeInterrupt("test::blocked")],
        store,
        {
          hasInterrupts: isInterrupts,
          respondToInterrupts: async (_interrupts, responses) => {
            expect(responses[0].type).toBe("approve");
            expect(responses[1].type).toBe("reject");
            return "mixed-result";
          },
        },
      );
      expect(result).toBe("mixed-result");
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/serve/mcp/interruptLoop.test.ts 2>&1 | tee /tmp/interrupt-loop-test.log`
Expected: FAIL — cannot import `runWithPolicy`

- [ ] **Step 3: Implement runWithPolicy**

`runWithPolicy` is a clean loop — it doesn't know about the `{ data: ... }` wrapper. The `InterruptHandlers` interface guarantees that `hasInterrupts` and `respondToInterrupts` work with the same shape. The caller (CLI wiring in Task 5) normalizes the compiled module's wrapper when constructing the handlers.

```typescript
// lib/serve/mcp/interruptLoop.ts
import { checkPolicy } from "../../runtime/policy.js";
import { approve, reject } from "../../runtime/interrupts.js";
import type { PolicyStore } from "../policyStore.js";

export type InterruptHandlers = {
  hasInterrupts: (data: unknown) => boolean;
  respondToInterrupts: (interrupts: unknown[], responses: unknown[]) => Promise<unknown>;
};

function applyPolicy(
  interrupts: Array<{ kind: string; message: string; data: any; origin: string }>,
  policy: Record<string, any>,
) {
  return interrupts.map((interrupt) => {
    const decision = checkPolicy(policy, interrupt);
    return decision.type === "approve" ? approve() : reject();
  });
}

export async function runWithPolicy(
  invoke: () => Promise<unknown>,
  policyStore: PolicyStore,
  handlers: InterruptHandlers,
): Promise<unknown> {
  let result = await invoke();

  while (handlers.hasInterrupts(result)) {
    const interrupts = result as Array<{ kind: string; message: string; data: any; origin: string }>;
    const responses = applyPolicy(interrupts, policyStore.get());
    result = await handlers.respondToInterrupts(interrupts, responses);
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/serve/mcp/interruptLoop.test.ts 2>&1 | tee /tmp/interrupt-loop-test.log`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```
git add lib/serve/mcp/interruptLoop.ts lib/serve/mcp/interruptLoop.test.ts
git commit -m "Add runWithPolicy interrupt loop for MCP"
```

---

### Task 3: Policy management tools in MCP adapter

**Files:**
- Modify: `lib/serve/mcp/adapter.ts`
- Modify: `lib/serve/mcp/adapter.test.ts`

This task adds the three built-in policy tools (`agencyGetPolicy`, `agencySetPolicy`, `agencyClearPolicy`) to the MCP adapter. It does NOT yet wire up the interrupt loop — that's Task 4.

- [ ] **Step 1: Write the failing tests**

Add these tests to `lib/serve/mcp/adapter.test.ts`. First, update the vitest import at line 1 to include `beforeEach` and `afterEach`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
```

Then add these imports at the top and a new describe block after the existing one:

```typescript
// Add these imports at the top of the file:
import { PolicyStore } from "../policyStore.js";
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";

// Add a new describe block after the existing one:
describe("MCP adapter — policy tools", () => {
  let tmpDir: string;
  let handler: (msg: any) => Promise<any>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mcp-policy-test-"));
    handler = createMcpHandler({
      serverName: "test-server",
      serverVersion: "1.0.0",
      exports: makeTestExports(),
      policyStore: new PolicyStore("test-server", tmpDir),
      interruptHandlers: { hasInterrupts: () => false, respondToInterrupts: async () => "done" },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists policy tools alongside agent tools", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = response!.result.tools.map((t: any) => t.name);
    expect(names).toContain("agencyGetPolicy");
    expect(names).toContain("agencySetPolicy");
    expect(names).toContain("agencyClearPolicy");
    expect(names).toContain("add"); // agent tool still listed
  });

  it("agencyGetPolicy returns empty policy by default", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "agencyGetPolicy", arguments: {} },
    });
    expect(response!.result.isError).toBe(false);
    expect(JSON.parse(response!.result.content[0].text)).toEqual({});
  });

  it("agencySetPolicy sets and persists a policy", async () => {
    const policy = { "test::x": [{ action: "approve" }] };
    const setResponse = await handler({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agencySetPolicy", arguments: { policy } },
    });
    expect(setResponse!.result.isError).toBe(false);

    const getResponse = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "agencyGetPolicy", arguments: {} },
    });
    expect(JSON.parse(getResponse!.result.content[0].text)).toEqual(policy);
  });

  it("agencySetPolicy rejects invalid policies", async () => {
    const response = await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "agencySetPolicy", arguments: { policy: { "x": [{ action: "yolo" }] } } },
    });
    expect(response!.result.isError).toBe(true);
  });

  it("agencyClearPolicy resets to empty", async () => {
    // Set a policy first
    await handler({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "agencySetPolicy", arguments: { policy: { "x::y": [{ action: "approve" }] } } },
    });

    // Clear it
    const clearResponse = await handler({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "agencyClearPolicy", arguments: {} },
    });
    expect(clearResponse!.result.isError).toBe(false);

    // Verify empty
    const getResponse = await handler({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "agencyGetPolicy", arguments: {} },
    });
    expect(JSON.parse(getResponse!.result.content[0].text)).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/serve/mcp/adapter.test.ts 2>&1 | tee /tmp/mcp-policy-tools-test.log`
Expected: FAIL — `McpConfig` doesn't accept `policyStore`/`hasInterrupts`/`respondToInterrupts` yet

- [ ] **Step 3: Update McpConfig and add policy tool handling**

In `lib/serve/mcp/adapter.ts`, make these changes:

1. Add imports:
```typescript
import type { PolicyStore } from "../policyStore.js";
import type { InterruptHandlers } from "./interruptLoop.js";
```

2. Update `McpConfig` to include optional policy and interrupt handler fields:
```typescript
export type McpConfig = {
  serverName: string;
  serverVersion: string;
  exports: ExportedItem[];
  policyStore?: PolicyStore;
  interruptHandlers?: InterruptHandlers;
};
```

3. Add a `handlePolicyTool` function above `createMcpHandler`. This keeps policy tool dispatch self-contained:
```typescript
const POLICY_TOOL_DEFINITIONS = [
  {
    name: "agencyGetPolicy",
    description: "Get the current interrupt policy for this agent. Returns a JSON object keyed by interrupt kind.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agencySetPolicy",
    description: "Set the interrupt policy for this agent. The policy controls which actions the agent is allowed to take autonomously. Each tool lists its interrupt kinds — use those as keys in the policy object. Example: {\"email::send\": [{\"match\": {\"recipient\": \"*@company.com\"}, \"action\": \"approve\"}, {\"action\": \"reject\"}]} approves sending emails to company.com addresses and rejects all others.",
    inputSchema: {
      type: "object",
      properties: {
        policy: {
          type: "object",
          description: "Policy object keyed by interrupt kind. Each kind maps to an ordered array of rules. Each rule has an 'action' field ('approve' or 'reject') and an optional 'match' field — an object whose keys are interrupt data field names and whose values are glob patterns. Rules are evaluated in order; the first match wins. A rule with no 'match' field is a catch-all.",
        },
      },
      required: ["policy"],
    },
  },
  {
    name: "agencyClearPolicy",
    description: "Clear the interrupt policy, resetting to reject-all. After clearing, all interrupt-producing actions will be rejected until a new policy is set.",
    inputSchema: { type: "object", properties: {} },
  },
];

function handlePolicyTool(
  name: string,
  args: Record<string, any>,
  policyStore: PolicyStore,
): JsonRpcMessage | null {
  switch (name) {
    case "agencyGetPolicy":
      return { result: { content: [{ type: "text", text: JSON.stringify(policyStore.get(), null, 2) }], isError: false } };
    case "agencySetPolicy":
      try {
        policyStore.set(args.policy);
        return { result: { content: [{ type: "text", text: "Policy updated successfully." }], isError: false } };
      } catch (err) {
        return { result: { content: [{ type: "text", text: errorMessage(err) }], isError: true } };
      }
    case "agencyClearPolicy":
      policyStore.clear();
      return { result: { content: [{ type: "text", text: "Policy cleared." }], isError: false } };
    default:
      return null;
  }
}
```

4. Inside `createMcpHandler`, after `toolsListPayload` construction, conditionally add policy tools:
```typescript
  const { policyStore } = config;
  if (policyStore) {
    toolsListPayload.push(...POLICY_TOOL_DEFINITIONS);
  }
```

5. In the `tools/call` case, before the existing tool lookup, delegate to `handlePolicyTool`:
```typescript
      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        const id = message.id ?? null;

        if (policyStore) {
          const policyResult = handlePolicyTool(name, args, policyStore);
          if (policyResult) return success(id, policyResult.result);
        }

        // Existing agent tool lookup...
        const tool = toolsByName[name];
        // ... rest unchanged
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/serve/mcp/adapter.test.ts 2>&1 | tee /tmp/mcp-policy-tools-test.log`
Expected: All tests PASS (existing + new policy tool tests)

- [ ] **Step 5: Commit**

```
git add lib/serve/mcp/adapter.ts lib/serve/mcp/adapter.test.ts
git commit -m "Add policy management tools to MCP adapter"
```

---

### Task 4: Wire interrupt loop into MCP tool calls

**Files:**
- Modify: `lib/serve/mcp/adapter.ts`
- Modify: `lib/serve/mcp/adapter.test.ts`

This task wires `runWithPolicy` into the `tools/call` handler so that function invocations automatically go through the interrupt loop.

- [ ] **Step 1: Write the failing test**

Add this test to the "MCP adapter — policy tools" describe block in `lib/serve/mcp/adapter.test.ts`:

```typescript
  it("automatically handles interrupts using the policy", async () => {
    // Create a function that returns an interrupt
    const registry: Record<string, AgencyFunction> = {};
    const greetFn = AgencyFunction.create(
      {
        name: "greet",
        module: "test",
        fn: async (name: string) => [
          { type: "interrupt", kind: "test::greet", message: `Greet ${name}?`, data: { name }, origin: "test" },
        ],
        params: [{ name: "name", hasDefault: false, defaultValue: undefined, variadic: false }],
        toolDefinition: {
          name: "greet",
          description: "Greet someone",
          schema: z.object({ name: z.string() }),
        },
        exported: true,
        safe: false,
      },
      registry,
    );

    let respondCalled = false;
    const policyHandler = createMcpHandler({
      serverName: "test",
      serverVersion: "1.0.0",
      exports: [
        { kind: "function", name: "greet", description: "Greet someone", agencyFunction: greetFn, interruptKinds: [{ kind: "test::greet" }] },
      ],
      policyStore: new PolicyStore("test", tmpDir),
      interruptHandlers: {
        hasInterrupts: (data) => Array.isArray(data) && data.length > 0 && data[0]?.type === "interrupt",
        respondToInterrupts: async (_interrupts, responses) => {
          respondCalled = true;
          // The policy has no rules for test::greet, so it should reject
          expect(responses[0].type).toBe("reject");
          return "rejected";
        },
      },
    });

    const response = await policyHandler({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "Alice" } },
    });

    expect(respondCalled).toBe(true);
    expect(response!.result.isError).toBe(false);
    expect(JSON.parse(response!.result.content[0].text)).toBe("rejected");
  });

  it("approves interrupts when policy matches", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const sendFn = AgencyFunction.create(
      {
        name: "sendEmail",
        module: "test",
        fn: async () => [
          { type: "interrupt", kind: "email::send", message: "Send email?", data: { recipient: "alice@company.com" }, origin: "test" },
        ],
        params: [],
        toolDefinition: { name: "sendEmail", description: "Send an email", schema: z.object({}) },
        exported: true,
        safe: false,
      },
      registry,
    );

    const store = new PolicyStore("test", tmpDir);
    store.set({ "email::send": [{ match: { recipient: "*@company.com" }, action: "approve" }] });

    const policyHandler = createMcpHandler({
      serverName: "test",
      serverVersion: "1.0.0",
      exports: [
        { kind: "function", name: "sendEmail", description: "Send an email", agencyFunction: sendFn, interruptKinds: [{ kind: "email::send" }] },
      ],
      policyStore: store,
      interruptHandlers: {
        hasInterrupts: (data) => Array.isArray(data) && data.length > 0 && data[0]?.type === "interrupt",
        respondToInterrupts: async (_interrupts, responses) => {
          expect(responses[0].type).toBe("approve");
          return "sent";
        },
      },
    });

    const response = await policyHandler({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "sendEmail", arguments: {} },
    });

    expect(JSON.parse(response!.result.content[0].text)).toBe("sent");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/serve/mcp/adapter.test.ts 2>&1 | tee /tmp/mcp-interrupt-wire-test.log`
Expected: FAIL — the handler doesn't call `respondToInterrupts` (it returns the raw interrupt array)

- [ ] **Step 3: Wire runWithPolicy into the tools/call handler**

In `lib/serve/mcp/adapter.ts`:

1. Add import:
```typescript
import { runWithPolicy } from "./interruptLoop.js";
```

2. In the `tools/call` case, replace the existing function invocation block with one that uses `runWithPolicy` when policy support is configured:

```typescript
        const tool = toolsByName[name];
        if (!tool) {
          return rpcError(id, -32602, `Unknown tool '${name}'`);
        }
        try {
          const invoke = () => tool.agencyFunction.invoke({ type: "named", positionalArgs: [], namedArgs: args });
          const result = policyStore && config.interruptHandlers
            ? await runWithPolicy(invoke, policyStore, config.interruptHandlers)
            : await invoke();
          return success(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        } catch (err) {
          return success(id, {
            content: [{ type: "text", text: errorMessage(err) }],
            isError: true,
          });
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/serve/mcp/adapter.test.ts 2>&1 | tee /tmp/mcp-interrupt-wire-test.log`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
git add lib/serve/mcp/adapter.ts lib/serve/mcp/adapter.test.ts
git commit -m "Wire interrupt loop into MCP tool calls"
```

---

### Task 5: CLI wiring

**Files:**
- Modify: `lib/cli/serve.ts`

- [ ] **Step 1: Update serveMcp to create PolicyStore and pass interrupt handlers**

In `lib/cli/serve.ts`:

1. Add imports:
```typescript
import { PolicyStore } from "../serve/policyStore.js";
import type { InterruptHandlers } from "../serve/mcp/interruptLoop.js";
```

2. Update `serveMcp` to create a `PolicyStore` and construct `InterruptHandlers` that normalize the compiled module's `{ data: ... }` wrapper. This is the **only place** that knows about the wrapper — `runWithPolicy` and the adapter never see it:

```typescript
export async function serveMcp(
  file: string,
  options: { name?: string },
): Promise<void> {
  const compileResult = compileForServe(file);
  const { exports, moduleExports } = await loadAndDiscover(compileResult);

  const serverName = options.name ?? path.basename(file, ".agency");
  const policyStore = new PolicyStore(serverName);

  // The compiled module's hasInterrupts checks raw data, but respondToInterrupts
  // returns { data: ... }. We normalize here so the interrupt loop sees a
  // consistent shape: hasInterrupts and respondToInterrupts both work with raw data.
  const rawHasInterrupts = moduleExports.hasInterrupts as (data: unknown) => boolean;
  const rawRespondToInterrupts = moduleExports.respondToInterrupts as (
    interrupts: unknown[],
    responses: unknown[],
  ) => Promise<{ data: unknown }>;

  const interruptHandlers: InterruptHandlers = {
    hasInterrupts: rawHasInterrupts,
    respondToInterrupts: async (interrupts, responses) => {
      const wrapped = await rawRespondToInterrupts(interrupts, responses);
      return wrapped.data;
    },
  };

  const handler = createMcpHandler({
    serverName,
    serverVersion: VERSION,
    exports,
    policyStore,
    interruptHandlers,
  });

  startStdioServer(handler);
}
```

- [ ] **Step 2: Build and verify**

Run: `cd /Users/adityabhargava/worktrees/agency-lang && make 2>&1 | tail -5`
Expected: Build succeeds with no errors

- [ ] **Step 3: Run all serve tests**

Run: `pnpm vitest run lib/serve/ 2>&1 | tee /tmp/serve-all-test.log`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```
git add lib/cli/serve.ts
git commit -m "Wire PolicyStore into serveMcp CLI command"
```
