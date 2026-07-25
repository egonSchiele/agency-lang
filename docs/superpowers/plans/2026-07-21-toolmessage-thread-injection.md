# `toolMessage` Thread Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `toolMessage(name, args, result, label)`, a `userMessage`-style function that seeds a synthetic tool-call plus tool-result message pair into the active thread, so a scaffold can make the model see a tool exchange it did not actually make.

**Architecture:** A runtime function `_toolMessage` in `lib/stdlib/thread.ts` mints a synthetic id, pushes an assistant message carrying one `toolCall`, then pushes a matching tool-result message, both onto the active thread read from the async-local context — the exact pattern `_userMessage` already uses. A thin Agency wrapper `toolMessage` in `stdlib/thread.agency` forwards to it. Nothing executes; it only shapes the conversation.

**Tech Stack:** TypeScript (runtime), Agency (stdlib wrapper), `smoltalk` (message builders), `nanoid` (synthetic ids), vitest (unit + integration tests), the Agency test harness (`pnpm run a test`).

## Global Constraints

- `result` is a plain `string` in v1. Image/file results are out of scope (see the spec's "Attachments are deferred").
- Never use dynamic imports. Use objects, not maps. Use arrays, not sets. Use `type`, not `interface`.
- The Agency `toolMessage` is a thin forward to `_toolMessage`; all behavior lives in the runtime function.
- `label` rides on the pushed messages via `push(message, label || null)`, exactly like `_userMessage`. No separate statelog emit. `_toolMessage` does not fire `onToolCallStart`/`onToolCallEnd`.
- The tool-call arguments are stored as a JSON **object** (`Record<string, any>`), not a pre-stringified string — `smoltalk`'s `ToolCallJSON.arguments` is a record. Validation still happens up front by round-tripping through JSON so a non-serializable value throws at the call site. A single `try`/`catch` around the round-trip gives one friendly error for every non-serializable case (a circular object makes `JSON.stringify` throw a `TypeError`; a bare function makes it return `undefined`, which then fails in `JSON.parse`). Both land on the same clear message, thrown before anything is pushed.
- Reference spec: `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-21-toolmessage-thread-injection-design.md`.

---

### Task 1: `_toolMessage` runtime function

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/thread.ts` (add a `nanoid` import and the `_toolMessage` function, next to `_userMessage` around line 66-72)
- Test: `packages/agency-lang/lib/stdlib/toolMessage.test.ts` (create)

**Interfaces:**
- Consumes: `getRuntimeContext()` from `../runtime/asyncContext.js` (returns `{ threads }`); `smoltalk.assistantMessage`, `smoltalk.toolMessage`; `nanoid` from `nanoid`.
- Produces: `export async function _toolMessage(name: string, args: any, result: string, label?: string): Promise<void>` — pushes an assistant tool-call message then a matching tool-result message onto the active thread. Later tasks (the Agency wrapper and the integration test) call this.

- [ ] **Step 1: Write the failing test**

Create `packages/agency-lang/lib/stdlib/toolMessage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { _toolMessage } from "./thread.js";
import { agency } from "../runtime/agency.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";

function makeCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
  });
}

describe("_toolMessage", () => {
  it("seeds exactly a matched assistant tool-call + tool-result pair", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.", "budget");
      },
    );

    const msgs = threads
      .getOrCreateActive()
      .getMessages()
      .map((m: any) => m.toJSON());

    // Exactly two messages, nothing stray, in order.
    expect(msgs).toHaveLength(2);
    const [asst, tool] = msgs;

    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("");
    expect(asst.toolCalls).toHaveLength(1);
    expect(asst.toolCalls[0].name).toBe("saveDraft");
    expect(asst.toolCalls[0].arguments).toEqual({ value: "hi" });

    expect(tool.role).toBe("tool");
    expect(tool.name).toBe("saveDraft");
    expect(tool.content).toBe("Draft saved.");
    expect(tool.tool_call_id).toBe(asst.toolCalls[0].id);
  });

  it("labels both pushed messages", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.", "budget");
      },
    );
    const thread = threads.getOrCreateActive();
    expect(thread.labelAt(0)).toBe("budget");
    expect(thread.labelAt(1)).toBe("budget");
  });

  it("leaves both messages unlabeled when no label is given", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.");
      },
    );
    const thread = threads.getOrCreateActive();
    expect(thread.labelAt(0)).toBe(null);
    expect(thread.labelAt(1)).toBe(null);
  });

  it("defaults null/undefined args to an empty record", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("noArgs", null, "ok");
      },
    );
    const asst: any = threads.getOrCreateActive().getMessages()[0].toJSON();
    expect(asst.toolCalls[0].arguments).toEqual({});
  });

  it("creates the active thread when there is none", async () => {
    const ctx = makeCtx();
    const threads = new ThreadStore(); // bare: no default active thread
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.");
      },
    );
    expect(threads.getOrCreateActive().getMessages()).toHaveLength(2);
  });

  it("throws a clear error on non-serializable args and pushes nothing", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const circular: any = {};
    circular.self = circular;

    await expect(
      agency.withTestContext(
        { ctx, stack: ctx.stateStack, threads },
        async () => {
          await _toolMessage("x", circular, "r");
        },
      ),
    ).rejects.toThrow(/could not be serialized/);

    expect(threads.getOrCreateActive().getMessages()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run lib/stdlib/toolMessage.test.ts`
Expected: FAIL — `_toolMessage` is not exported from `./thread.js`.

- [ ] **Step 3: Add the `nanoid` import**

At the top of `packages/agency-lang/lib/stdlib/thread.ts`, add to the imports (nanoid is already a runtime dependency, imported the same way in `lib/runtime/agency.ts:29`):

```ts
import { nanoid } from "nanoid";
```

- [ ] **Step 4: Write the implementation**

In `packages/agency-lang/lib/stdlib/thread.ts`, immediately after `_userMessage` (around line 72), add:

```ts
/** Seed a synthetic tool call and its result onto the active thread, as if
 *  the model had made the call. Nothing executes: this only shapes the
 *  conversation. `args` is validated by a JSON round-trip up front, so a
 *  non-serializable value throws here rather than being rejected by the
 *  provider on the next `llm()`. Both messages carry `label`, an
 *  observability-only tag (see `_userMessage`). The id is synthetic — real
 *  tool-call ids come from the provider, this one is minted with nanoid. */
export async function _toolMessage(
  name: string,
  args: any,
  result: string,
  label: string = "",
): Promise<void> {
  // Round-trip up front so a non-serializable value throws HERE, not far away
  // when the provider rejects the thread on the next llm(). One catch covers
  // both failure shapes: JSON.stringify throws on a circular object, and
  // returns undefined for a bare function (which then fails in JSON.parse).
  let argsRecord: Record<string, any>;
  try {
    argsRecord = JSON.parse(JSON.stringify(args ?? {}));
  } catch {
    throw new Error(
      `toolMessage: args for "${name}" could not be serialized to JSON`,
    );
  }

  const id = nanoid();
  const { threads } = getRuntimeContext();
  const thread = threads.getOrCreateActive();

  thread.push(
    smoltalk.assistantMessage("", {
      toolCalls: [{ id, name, arguments: argsRecord }],
    }),
    label || null,
  );
  thread.push(
    smoltalk.toolMessage(result, { tool_call_id: id, name }),
    label || null,
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run lib/stdlib/toolMessage.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/lib/stdlib/thread.ts packages/agency-lang/lib/stdlib/toolMessage.test.ts
git commit -m "feat(thread): add _toolMessage runtime to seed a synthetic tool exchange"
```

---

### Task 2: Agency `toolMessage` wrapper

**Files:**
- Modify: `packages/agency-lang/stdlib/thread.agency` (import `_toolMessage`; add the `toolMessage` wrapper next to `userMessage`, around line 75-85)
- Test: `packages/agency-lang/tests/agency/thread/toolmessage-roundtrip.agency` and `.test.json` (create)

**Interfaces:**
- Consumes: `_toolMessage` from Task 1 (`_toolMessage(name, args, result, label)`), imported from `agency-lang/stdlib-lib/thread.js`; `listThreads`, `getThread` (already in `stdlib/thread.agency`).
- Produces: Agency `toolMessage(name: string, args: any, result: string, label: string = "")`, importable via `import { toolMessage } from "std::thread"`.

- [ ] **Step 1: Write the failing Agency test**

Create `packages/agency-lang/tests/agency/thread/toolmessage-roundtrip.agency`:

```
import { toolMessage, listThreads, getThread } from "std::thread"

node main(): string {
  toolMessage("saveDraft", { value: "hello" }, "Draft saved.")

  const info = listThreads(false)
  if (info is failure(_e)) {
    return "listThreads failed"
  }
  const threads = info.value
  if (threads.length == 0) {
    return "no threads"
  }

  const read = getThread(threads[0].id, 0, 50)
  if (read is failure(_e)) {
    return "getThread failed"
  }
  const msgs = read.value
  if (msgs.length < 2) {
    return "too few messages"
  }
  // Encode the last TWO roles so a dropped assistant tool-call message (which
  // would leave an invalid, unmatched tool result) is caught here. getThread
  // cannot expose tool_call_id, so true pairing is left to the unit test.
  const prev = msgs[msgs.length - 2]
  const last = msgs[msgs.length - 1]
  return "${prev.role}|${last.role}:${last.content}"
}
```

Create `packages/agency-lang/tests/agency/thread/toolmessage-roundtrip.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "toolMessage seeds an assistant tool-call followed by its tool result, readable from the thread",
      "input": "",
      "expectedOutput": "\"assistant|tool:Draft saved.\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [],
      "llmMocks": []
    }
  ]
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run a test tests/agency/thread/toolmessage-roundtrip.agency`
Expected: FAIL — `toolMessage` is not exported from `std::thread` (unresolved import / unknown function).

- [ ] **Step 3: Add the import**

In `packages/agency-lang/stdlib/thread.agency`, add `_toolMessage` to the import block that already pulls `_userMessage` from `"agency-lang/stdlib-lib/thread.js"` (around line 29):

```ts
  _toolMessage,
```

- [ ] **Step 4: Add the wrapper**

In `packages/agency-lang/stdlib/thread.agency`, immediately after `userMessage` (around line 85), add:

```ts
export def toolMessage(
  name: string,
  args: any,
  result: string,
  label: string = "",
) {
  """
  Add a synthetic tool call and its result to the current thread, as if the
  model had made the call. Nothing runs; this only shapes the conversation the
  model reads on its next llm() call. Use it to make the model see work a
  scaffold did on its behalf. Call it at a clean point in the thread, not in
  the middle of a tool exchange still waiting for its result.

  @param name - The tool name the model will see it "called"
  @param args - The call arguments, as an object (serialized to JSON)
  @param result - The tool response content
  @param label - Optional debug tag shown in statelog. Never sent to the model.
  """
  _toolMessage(name, args, result, label)
}
```

- [ ] **Step 5: Rebuild the stdlib**

Run: `make`
Expected: build succeeds with no `error` lines for `stdlib/thread.agency` (it compiles the new wrapper and regenerates `stdlib/thread.js`).

- [ ] **Step 6: Run the Agency test to verify it passes**

Run: `pnpm run a test tests/agency/thread/toolmessage-roundtrip.agency`
Expected: PASS — `expectedOutput` `"tool:Draft saved."` matches.

- [ ] **Step 7: Regenerate stdlib docs**

Run: `make doc`
Expected: `docs/site/stdlib/thread.md` now documents `toolMessage` (generated from the docstring).

- [ ] **Step 8: Commit**

```bash
git add packages/agency-lang/stdlib/thread.agency packages/agency-lang/stdlib/thread.js packages/agency-lang/tests/agency/thread/toolmessage-roundtrip.agency packages/agency-lang/tests/agency/thread/toolmessage-roundtrip.test.json packages/agency-lang/docs/site/stdlib/thread.md
git commit -m "feat(thread): expose toolMessage in std::thread"
```

---

### Task 3: Forwarding + wire-shape integration test

This proves that a seeded exchange is **forwarded** into the outgoing request, well-formed and id-matched: `runPrompt` puts the thread's messages (including the synthetic pair) into the `PromptConfig` handed to the client, and the assistant tool-call and tool-result carry a matching id. It seeds the thread with `_toolMessage` (the same function the Agency wrapper calls), then runs a prompt against a `RecordingClient` that captures the config.

Scope note, stated honestly: `RecordingClient` is a mock — it records and returns a canned success, so it cannot prove a *real* provider accepts an un-redeclared historical tool call. That claim rests on the general provider contract the spec documents ("It does not require the tool to be declared"). Verifying it against a live provider is a worthwhile manual or CI-gated follow-up (CLAUDE.md permits a single real LLM call where a test genuinely needs one); it is out of scope for this unit-level plan.

**Files:**
- Test: `packages/agency-lang/lib/runtime/toolMessageProvider.test.ts` (create)

**Interfaces:**
- Consumes: `_toolMessage` (Task 1); `runPrompt` from `./prompt.js`; `RecordingClient` pattern from `promptLabels.test.ts`; `MessageThread`, `ThreadStore`, `RuntimeContext`, `agency.withTestContext`.

- [ ] **Step 1: Write the failing test**

Create `packages/agency-lang/lib/runtime/toolMessageProvider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Result, PromptResult, StreamChunk } from "smoltalk";
import { agency } from "./agency.js";
import type {
  EmbedConfig,
  EmbedResult,
  LLMClient,
  PromptConfig,
} from "./llmClient.js";
import { runPrompt } from "./prompt.js";
import { RuntimeContext } from "./state/context.js";
import { ThreadStore } from "./state/threadStore.js";
import { _toolMessage } from "../stdlib/thread.js";

function makeCtx(): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: { model: "default-model" },
    dirname: "/tmp",
  });
}

class RecordingClient implements LLMClient {
  configs: PromptConfig[] = [];
  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    this.configs.push(config);
    return {
      success: true,
      value: {
        output: "ok",
        toolCalls: [],
        model: (config as any).model ?? "unknown",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 },
        cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
      },
    };
  }
  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const r = await this.text(config);
    if (r.success) yield { type: "text", text: r.value.output } as StreamChunk;
  }
  async embed(
    _input: string | string[],
    _config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    throw new Error("not used");
  }
}

describe("toolMessage provider acceptance", () => {
  it("sends the seeded tool exchange in the provider request", async () => {
    const ctx = makeCtx();
    const client = new RecordingClient();
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);

    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { value: "hi" }, "Draft saved.");
        await runPrompt({
          prompt: "continue",
          messages: threads.getOrCreateActive(),
          clientConfig: {} as any,
        });
      },
    );

    expect(client.configs).toHaveLength(1);
    // PromptConfig.messages (llmClient.ts:25), filled from the thread at
    // prompt.ts:642. The messages arrive as smoltalk Message instances.
    const sent = (client.configs[0] as any).messages.map((m: any) =>
      typeof m.toJSON === "function" ? m.toJSON() : m,
    );

    const asst = sent.find(
      (m: any) => m.role === "assistant" && m.toolCalls?.length,
    );
    expect(asst).toBeDefined();
    expect(asst.toolCalls[0].name).toBe("saveDraft");

    const tool = sent.find((m: any) => m.role === "tool");
    expect(tool).toBeDefined();
    expect(tool.tool_call_id).toBe(asst.toolCalls[0].id);
    expect(tool.content).toBe("Draft saved.");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm exec vitest run lib/runtime/toolMessageProvider.test.ts`
Expected: PASS. This is a characterization/integration test, not red-green TDD — it passes as soon as Task 1 is in place, because it exercises the finished `_toolMessage` end-to-end through `runPrompt`. A reviewer should not expect it to fail first.

- [ ] **Step 3: Commit**

```bash
git add packages/agency-lang/lib/runtime/toolMessageProvider.test.ts
git commit -m "test(thread): verify a seeded toolMessage is forwarded well-formed and id-matched"
```

---

## Self-Review

**Spec coverage:**
- Signature `toolMessage(name, args, result, label="")` with `result: string` — Task 2 wrapper, Task 1 runtime. ✓
- Assistant tool-call message + matching tool-result message, shared id — Task 1 implementation + test. ✓
- `label` on both messages via `push(msg, label || null)`, no separate statelog, no `onToolCall*` — Task 1 implementation + "labels both pushed messages" test + the "leaves both messages unlabeled when no label is given" test (pins the `|| null` branch) + Global Constraints. ✓
- Synthetic nanoid id, not a provider id — Task 1 docstring + implementation. ✓
- Non-serializable `args` throws immediately, pushes nothing — Task 1 "throws a clear error" test (asserts the `/could not be serialized/` message and `toHaveLength(0)`). ✓
- No active thread → created via `getOrCreateActive` — Task 1 "creates the active thread when there is none" test, which builds a bare `new ThreadStore()` (no default active) and asserts a two-message thread lands. (The `withDefaultActive` helper used by the other tests already has an active thread, so only this test exercises the create path.) ✓
- Exactly the pair, nothing stray — Task 1 test 1 asserts `msgs.toHaveLength(2)`. ✓
- `args` defaults to `{}` for null/undefined, and the tool-result `name` field is set — Task 1 "defaults null/undefined args" test and the `tool.name` assertion in test 1. ✓
- Attachments deferred, `result` is a string — Global Constraints + spec reference. ✓
- Seeded exchange forwarded into the outgoing request, well-formed and id-matched — Task 3. (Real-provider acceptance is documented as an out-of-scope follow-up, per the honest framing in Task 3.) ✓
- Lives in `stdlib/thread.agency` + `lib/stdlib/thread.ts` beside the other `*Message` functions — Tasks 1 and 2. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows the full code. The one conditional (Task 3 Step 3) is a concrete, bounded fallback for a single field name, not a placeholder for logic.

**Type consistency:** `_toolMessage(name, args, result, label)` is defined identically in Task 1 and consumed with the same signature in Tasks 2 and 3. `toolCalls[0].{id,name,arguments}` and the tool message's `{role, content, tool_call_id}` field names match across the Task 1 and Task 3 assertions and the confirmed `smoltalk` JSON schemas (`AssistantMessageJSON.toolCalls`, `ToolMessageJSON.content`/`tool_call_id`).
