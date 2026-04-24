# LLM Client Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LLM client pluggable so users can swap smoltalk for alternative implementations via `setLLMClient()`.

**Architecture:** Define an `LLMClient` interface with `text` and `textStream` methods using smoltalk's existing types. Refactor `prompt.ts` to call through `ctx.llmClient` instead of `smoltalk` directly. Add a simple fetch-based OpenAI reference client. Wire up `setLLMClient` as a builtin function.

**Tech Stack:** TypeScript, smoltalk (types), Vitest

**Spec:** `docs/superpowers/specs/2026-04-24-llm-client-abstraction-design.md`

---

## Phase 1: Define interface and refactor prompt.ts

### Task 1: Define LLMClient type and default smoltalk client

**Files:**
- Create: `lib/runtime/llmClient.ts`
- Modify: `lib/runtime/index.ts`

- [ ] **Step 1: Create the LLMClient type and default client**

Create `lib/runtime/llmClient.ts`:

```typescript
import * as smoltalk from "smoltalk";
import type { SmolPromptConfig, PromptResult, StreamChunk, Result } from "smoltalk";

export type LLMClient = {
  text(config: SmolPromptConfig): Promise<Result<PromptResult>>;
  textStream(config: SmolPromptConfig): AsyncGenerator<StreamChunk>;
};

export function createDefaultClient(): LLMClient {
  return {
    text: (config) => smoltalk.text(config),
    textStream: (config) => smoltalk.textStream(config),
  };
}
```

- [ ] **Step 2: Export from runtime index**

In `lib/runtime/index.ts`, add:

```typescript
export { createDefaultClient } from "./llmClient.js";
export type { LLMClient } from "./llmClient.js";
```

- [ ] **Step 3: Run tests**

Run: `pnpm test:run`

Expected: All tests pass (no behavioral change).

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/llmClient.ts lib/runtime/index.ts
git commit -m "feat: define LLMClient type and default smoltalk client"
```

---

### Task 2: Add llmClient to RuntimeContext

**Files:**
- Modify: `lib/runtime/state/context.ts`

- [ ] **Step 1: Add llmClient field and import**

In `lib/runtime/state/context.ts`, add import:

```typescript
import { LLMClient, createDefaultClient } from "../llmClient.js";
```

Add the field to the class (near the `smoltalkDefaults` field):

```typescript
llmClient: LLMClient;
```

- [ ] **Step 2: Set default in constructor**

In the constructor body, after `this.smoltalkDefaults = args.smoltalkDefaults;`, add:

```typescript
this.llmClient = createDefaultClient();
```

- [ ] **Step 3: Copy in createExecutionContext**

In `createExecutionContext`, after `execCtx.smoltalkDefaults = this.smoltalkDefaults;`, add:

```typescript
execCtx.llmClient = this.llmClient;
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/state/context.ts
git commit -m "feat: add llmClient field to RuntimeContext"
```

---

### Task 3: Refactor prompt.ts to use ctx.llmClient

**Files:**
- Modify: `lib/runtime/prompt.ts`

- [ ] **Step 1: Replace smoltalk.text calls with ctx.llmClient**

In `lib/runtime/prompt.ts`, find the call at ~line 74-82:

```typescript
let _completion: AsyncGenerator<StreamChunk> | Promise<Result<PromptResult>> =
  await (smoltalk.text as Function)({
    messages: messages.getMessages(),
    tools,
    responseFormat,
    stream,
    abortSignal: ctx.abortController.signal,
    ...clientConfig,
  });
```

Replace with:

```typescript
const llmConfig = {
  messages: messages.getMessages(),
  tools,
  responseFormat,
  abortSignal: ctx.abortController.signal,
  ...clientConfig,
};

let _completion: AsyncGenerator<StreamChunk> | Promise<Result<PromptResult>>;
if (stream) {
  _completion = ctx.llmClient.textStream(llmConfig);
} else {
  _completion = ctx.llmClient.text(llmConfig);
}
```

Note: `stream` is intentionally omitted from `llmConfig` — the caller branches on it and calls the appropriate method. Passing `stream` in the config would confuse custom clients.

This removes the `(smoltalk.text as Function)` type cast and uses the explicit two-method interface.

- [ ] **Step 2: Verify smoltalk is still imported for message construction**

`smoltalk` is still needed for `smoltalk.userMessage()`, `smoltalk.assistantMessage()`, `smoltalk.toolMessage()`, etc. Do NOT remove the `import * as smoltalk from "smoltalk"` line.

- [ ] **Step 3: Run tests**

Run: `pnpm test:run`

Expected: All tests pass — behavior is identical since the default client wraps smoltalk.

- [ ] **Step 4: Run agency tests to verify end-to-end**

Run: `pnpm run agency test tests/agency/imports/typeImport.test.json`

Expected: PASS — LLM calls still work through the default client.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "refactor: prompt.ts uses ctx.llmClient instead of smoltalk directly"
```

---

## Phase 2: Simple reference client

### Task 4: Implement simple OpenAI client

**Files:**
- Create: `lib/runtime/simpleOpenAIClient.ts`
- Create: `lib/runtime/simpleOpenAIClient.test.ts`
- Modify: `lib/runtime/index.ts`

- [ ] **Step 1: Create the simple client**

Create `lib/runtime/simpleOpenAIClient.ts`:

```typescript
import type { SmolPromptConfig, PromptResult, StreamChunk, ToolCallJSON, Result, TokenUsage, CostEstimate } from "smoltalk";
import type { LLMClient } from "./llmClient.js";

export class SimpleOpenAIClient implements LLMClient {
  private apiKey: string;
  private defaultModel: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY not found. Pass apiKey option or set OPENAI_API_KEY environment variable.");
    }
    this.apiKey = apiKey;
    this.defaultModel = opts?.model ?? "gpt-4o-mini";
  }

  async text(config: SmolPromptConfig): Promise<Result<PromptResult>> {
    const model = (config as any).model || this.defaultModel;
    const body = this.buildRequestBody(config, model);

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: config.abortSignal as AbortSignal | undefined,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `OpenAI API error (${response.status}): ${errorText}` };
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      const output = choice?.message?.content || "";

      return {
        success: true,
        value: {
          output,
          toolCalls: this.extractToolCalls(choice),
          usage: this.extractUsage(data),
          cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" } as CostEstimate,
          model,
        } as PromptResult,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  async *textStream(config: SmolPromptConfig): AsyncGenerator<StreamChunk> {
    const result = await this.text(config);
    if (result.success) {
      yield { type: "done", result: result.value } as StreamChunk;
    } else {
      yield { type: "error", error: result.error } as StreamChunk;
    }
  }

  private buildRequestBody(config: SmolPromptConfig, model: string): any {
    const messages = (config.messages || []).map((m: any) => {
      const json = typeof m.toJSON === "function" ? m.toJSON() : m;
      return {
        role: json.role,
        content: json.content,
        ...(json.tool_calls ? { tool_calls: json.tool_calls } : {}),
        ...(json.tool_call_id ? { tool_call_id: json.tool_call_id } : {}),
      };
    });

    const body: any = { model, messages };

    if (config.tools && config.tools.length > 0) {
      body.tools = config.tools.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.inputSchema || t.schema,
        },
      }));
    }

    if (config.responseFormat) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: typeof config.responseFormat.jsonSchema === "function"
            ? config.responseFormat.jsonSchema()
            : config.responseFormat,
          strict: true,
        },
      };
    }

    return body;
  }

  private extractToolCalls(choice: any): ToolCallJSON[] {
    return (choice?.message?.tool_calls || []).map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));
  }

  private extractUsage(data: any): TokenUsage {
    if (data.usage) {
      return {
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
        cachedInputTokens: 0,
        totalTokens: data.usage.total_tokens || 0,
      };
    }
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
  }
}
```

- [ ] **Step 2: Export from runtime index**

In `lib/runtime/index.ts`, add:

```typescript
export { SimpleOpenAIClient } from "./simpleOpenAIClient.js";
```

- [ ] **Step 3: Write a unit test**

Create `lib/runtime/simpleOpenAIClient.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SimpleOpenAIClient } from "./simpleOpenAIClient.js";

describe("SimpleOpenAIClient", () => {
  it("should throw if no API key is available", () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new SimpleOpenAIClient()).toThrow("OPENAI_API_KEY not found");
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }
  });

  it("should create a client with a provided API key", () => {
    const client = new SimpleOpenAIClient({ apiKey: "test-key" });
    expect(client).toHaveProperty("text");
    expect(client).toHaveProperty("textStream");
    expect(typeof client.text).toBe("function");
    expect(typeof client.textStream).toBe("function");
  });

  it("should satisfy the LLMClient type", () => {
    const client = new SimpleOpenAIClient({ apiKey: "test-key" });
    expect(client.text).toBeDefined();
    expect(client.textStream).toBeDefined();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run -- lib/runtime/simpleOpenAIClient.test.ts`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/simpleOpenAIClient.ts lib/runtime/simpleOpenAIClient.test.ts lib/runtime/index.ts
git commit -m "feat: add simple OpenAI reference client"
```

---

## Phase 3: setLLMClient builtin

### Task 5: Add setLLMClient builtin function

**Files:**
- Create: `lib/templates/backends/typescriptGenerator/builtinFunctions/setLLMClient.mustache`
- Modify: `lib/backends/typescriptGenerator/builtins.ts`
- Modify: `lib/backends/typescriptBuilder.ts`

- [ ] **Step 1: Create the mustache template**

Create `lib/templates/backends/typescriptGenerator/builtinFunctions/setLLMClient.mustache`:

```
function setLLMClient(client) {
  __globalCtx.llmClient = client;
}
```

- [ ] **Step 2: Run templates to generate the .ts file**

Run: `pnpm run templates`

This generates `lib/templates/backends/typescriptGenerator/builtinFunctions/setLLMClient.ts` from the mustache file.

- [ ] **Step 3: Wire into builtins.ts**

In `lib/backends/typescriptGenerator/builtins.ts`, add the import:

```typescript
import * as builtinFunctionsSetLLMClient from "../../templates/backends/typescriptGenerator/builtinFunctions/setLLMClient.js";
```

In `generateBuiltinHelpers`, add after the `mcpFunc` line:

```typescript
const setLLMClientFunc = builtinFunctionsSetLLMClient.default({});
helpers.push(setLLMClientFunc);
```

- [ ] **Step 4: Add to DIRECT_CALL_FUNCTIONS**

In `lib/backends/typescriptBuilder.ts`, add `"setLLMClient"` to the `DIRECT_CALL_FUNCTIONS` set (~line 342):

```typescript
private static DIRECT_CALL_FUNCTIONS = new Set([
    "approve", "reject", "propagate",
    "success", "failure",
    "isInterrupt", "isDebugger", "isRejected", "isApproved",
    "isSuccess", "isFailure", "mcp", "setLLMClient"
]);
```

- [ ] **Step 5: Build and run tests**

Run: `make all && pnpm test:run`

Expected: All tests pass. Generator fixtures may need regeneration since the generated imports template changed.

- [ ] **Step 6: Regenerate fixtures if needed**

Run: `make fixtures`

Then: `pnpm test:run`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/templates/backends/typescriptGenerator/builtinFunctions/setLLMClient.mustache lib/templates/backends/typescriptGenerator/builtinFunctions/setLLMClient.ts lib/backends/typescriptGenerator/builtins.ts lib/backends/typescriptBuilder.ts
git commit -m "feat: add setLLMClient builtin function"
```

---

### Task 6: Add end-to-end test for setLLMClient

**Files:**
- Create: `tests/agency/setLLMClient.agency`
- Create: `tests/agency/setLLMClient.test.json`

- [ ] **Step 1: Create a generator fixture that verifies setLLMClient compiles**

Create `tests/typescriptGenerator/setLLMClient.agency`:

```
import { SimpleOpenAIClient } from "agency-lang/runtime"

const client = SimpleOpenAIClient()
setLLMClient(client)

node main() {
  const result = llm("Hello")
  print(result)
}
```

- [ ] **Step 2: Generate the expected output**

Run: `make fixtures`

- [ ] **Step 3: Verify the output**

Check that the generated `.mjs` contains `setLLMClient(client)` as a direct function call (no AgencyFunction wrapping, no interrupt handling).

- [ ] **Step 4: Run tests**

Run: `pnpm test:run`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/typescriptGenerator/setLLMClient.agency tests/typescriptGenerator/setLLMClient.mjs
git commit -m "test: add generator fixture for setLLMClient"
```
