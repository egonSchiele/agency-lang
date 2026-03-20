# Audit Logs Design

## Context

Agency compiles `.agency` files to TypeScript, which means the compiler can auto-generate structured logging statements for every operation — assignments, function calls, returns, LLM calls, tool calls — without the agent author writing any logging code.

The audit log helps users figure out exactly what an agent did: what variables were set, what functions were called, what the LLM said, what tools were invoked. It serves both debugging/observability and security audit trail purposes.

## Design Decisions

- **Callback-only, no storage.** Audit entries are emitted via an `onAudit` callback. There is no internal array accumulation, no field on `RunNodeResult`, and no serialization concerns with interrupts. If a user wants to collect entries, they do it in their callback.
- **Always-on generation.** The builder always injects audit calls. There is no config gate. When no `onAudit` callback is registered, `callHook` short-circuits as a no-op. This keeps integration test fixtures self-contained.
- **Runtime values captured.** Audit entries include actual variable values, function arguments/results, LLM prompts/responses — not just structural labels.
- **Discriminated union types.** Each audit entry type carries exactly the fields it needs. No optional field soup.
- **Sensitive data is the user's responsibility.** Audit logs may contain sensitive data. The `onAudit` callback is where users redact if needed.
- **Flat list, no parent/child IDs.** Entries are emitted in execution order. No correlation IDs for v1.
- **External TS functions cannot emit audit logs in v1.** They can use existing lifecycle hooks (`onFunctionStart`/`onFunctionEnd`).

## AuditEntry Type

Defined in `lib/runtime/audit.ts`:

```ts
type AuditBase = { timestamp: number };

type AssignmentAudit = AuditBase & {
  type: "assignment";
  variable: string;
  value: unknown;
};

type FunctionCallAudit = AuditBase & {
  type: "functionCall";
  functionName: string;
  args: unknown;
  result: unknown;
};

type ReturnAudit = AuditBase & {
  type: "return";
  value: unknown;
};

type LLMCallAudit = AuditBase & {
  type: "llmCall";
  model: string;
  prompt: string;
  response: unknown;
  tokens: TokenUsage | undefined; // re-exported from smoltalk
  duration: number;
};

type ToolCallAudit = AuditBase & {
  type: "toolCall";
  functionName: string;
  args: unknown;
  result: unknown;
  duration: number;
};

type NodeEntryAudit = AuditBase & {
  type: "nodeEntry";
  nodeName: string;
};

type NodeExitAudit = AuditBase & {
  type: "nodeExit";
  nodeName: string;
};

type InterruptAudit = AuditBase & {
  type: "interrupt";
  nodeName: string;
  args: unknown;
};

export type AuditEntry =
  | AssignmentAudit
  | FunctionCallAudit
  | ReturnAudit
  | LLMCallAudit
  | ToolCallAudit
  | NodeEntryAudit
  | NodeExitAudit
  | InterruptAudit;
```

## `ctx.audit()` Method

Added to `RuntimeContext` in `lib/runtime/state/context.ts`. Requires importing `callHook` from `../hooks.js` (RuntimeContext currently only imports `AgencyCallbacks` as a type):

```ts
async audit(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
  const fullEntry: AuditEntry = { ...entry, timestamp: Date.now() };
  await callHook({ callbacks: this.callbacks, name: "onAudit", data: fullEntry });
}
```

## Callback Integration

`onAudit: AuditEntry` is added to `CallbackMap` in `lib/runtime/hooks.ts`. No changes to `callHook` itself — it is already generic over `CallbackMap` keys. `CallbackReturn` already returns `void` for any key that isn't `onLLMCallStart`/`onLLMCallEnd`, so no changes needed there either.

Re-exported from `lib/runtime/index.ts`.

## Runtime Instrumentation

Six manual `ctx.audit()` calls in existing runtime code. These always run.

### `lib/runtime/node.ts` — node entry/exit

- After `onAgentStart` callHook: `await execCtx.audit({ type: "nodeEntry", nodeName })`
- Before `createReturnObject`: `await execCtx.audit({ type: "nodeExit", nodeName })`

### `lib/runtime/prompt.ts` — LLM calls

After `updateTokenStats` (near line 130), before the `onLLMCallEnd` hook:

```ts
await ctx.audit({
  type: "llmCall",
  model: String(modelName),
  prompt,
  response: completion.output,
  tokens: completion.usage,
  duration: endTime - startTime,
});
```

Note: `endTime` is captured before stream handling (line 74), so for streaming responses the duration reflects time-to-first-chunk, not total stream time. This matches the existing `onLLMCallEnd` hook behavior. We can improve this later if needed.

### `lib/runtime/prompt.ts` — tool calls

After `onToolCallEnd` callHook:

```ts
await ctx.audit({
  type: "toolCall",
  functionName: handler.name,
  args: params,
  result: toolResult,
  duration: toolEndTime - toolStartTime,
});
```

### `lib/runtime/interrupts.ts` — interrupt events

After setting up the execution context in `respondToInterrupt`:

```ts
await execCtx.audit({ type: "interrupt", nodeName, args: interruptResponse });
```

## Builder Injection

### `lib/ir/audit.ts` — `auditNode(node: TsNode): TsNode | null`

Inspects a processed `TsNode` and returns an `await __ctx.audit(...)` IR node, or `null` for nodes that should not be audited. Captures runtime values by referencing variables in the generated code.

Cases handled:

- **`assign`** — `{ type: "assignment", variable: "<name>", value: <lhs ref> }`. The `lhs` is a `TsNode` that could be a `TsScopedVar`, `TsIdentifier`, `TsPropertyAccess`, etc. Use `printTs(node.lhs)` to extract a human-readable name string at compile time, and emit `node.lhs` as the runtime value reference.
- **`varDecl`** — same as assign, using `node.name`
- **`call`** — `{ type: "functionCall", functionName: "<name>", args: [...] }`. Result is not captured for bare calls; when inside an `assign`, the assignment audit covers the value.
- **`return` / `functionReturn`** — `{ type: "return", value: <expr> }`
- **`await`** — unwraps and inspects the inner expression
- **`statements`** — iterates children, audits the first meaningful one
- **Everything else** (control flow, comments, type declarations) — returns `null`

Uses the existing `$` fluent builder, `ts.*` factories, and `printTs` for extracting human-readable names at compile time.

### `lib/backends/typescriptBuilder.ts` — injection site

In `processBodyAsParts`, after `parts[parts.length - 1].push(this.processStatement(stmt))`:

```ts
const audit = auditNode(processed);
if (audit) {
  parts[parts.length - 1].push(audit);
}
```

This covers all function and node bodies since `processBodyAsParts` is called by both `processFunctionDefinition` and `processGraphNode`.

### Complementary audit entries

For `x = llm("do something")`, both the builder-generated assignment audit (variable name + value) and the runtime LLM audit (prompt, response, tokens, duration) fire. These are complementary: the LLM audit has the detailed call data, the assignment audit shows where the result landed.

### Interaction with step blocks and interrupt resumption

Audit calls are injected inside step blocks (`if (__step <= N) { ... }`). When resuming from an interrupt, steps that were already completed are skipped, so their audit entries will not fire again. This is correct behavior — it prevents duplicate audit entries on resume.

### Known limitations

- **Inner block bodies are not audited.** `processBodyAsParts` processes top-level function/node bodies. Statements inside `if`, `for`, and `while` blocks are processed via `processStatement` directly, so they do not get audit calls injected. For example, `x = 5` inside an `if` block will not be audited, while `x = 5` at the top level of a function body will be. This is acceptable for v1 — the runtime audit calls (LLM, tool, node entry/exit) fire regardless of nesting depth.
- **`onAudit` callback must be passed via `callbacks` for interrupt resumption.** The interrupt resume path in `respondToInterrupt` copies callbacks from `metadata.callbacks`. If a user registers `onAudit`, it must be passed via the same `callbacks` object used for other hooks.

## Files Changed

### New files

| File | Purpose |
|------|---------|
| `lib/runtime/audit.ts` | `AuditEntry` discriminated union type |
| `lib/ir/audit.ts` | `auditNode(node: TsNode): TsNode \| null` |
| `lib/ir/audit.test.ts` | Unit tests for `auditNode` |

### Modified files

| File | Change |
|------|--------|
| `lib/runtime/hooks.ts` | Add `onAudit: AuditEntry` to `CallbackMap` |
| `lib/runtime/state/context.ts` | Add `audit()` method to `RuntimeContext` |
| `lib/runtime/index.ts` | Re-export `AuditEntry` |
| `lib/runtime/node.ts` | 2 audit calls (nodeEntry, nodeExit) |
| `lib/runtime/prompt.ts` | 2 audit calls (llmCall, toolCall) |
| `lib/runtime/interrupts.ts` | 1 audit call (interrupt) |
| `lib/backends/typescriptBuilder.ts` | Import `auditNode`, 3 lines in `processBodyAsParts`, audit log file setup in `generateImports`, default `onAudit` in exported node function |
| `lib/config.ts` | Add `audit.logFile` to `AgencyConfig` |
| `scripts/agency.ts` | Add `-l, --log <file>` option to `run` command |

### Not changed (vs original plan)

- `GlobalStore` — no storage
- `RunNodeResult` — no audit field
- `createReturnObject` — no audit inclusion
- No serialization changes

## Testing

- **Unit tests** (`lib/ir/audit.test.ts`): test `auditNode()` with various `TsNode` inputs (assign, varDecl, call, return, await wrapping, statements, null cases). Verify correct IR output.
- **Integration fixtures** (`tests/typescriptGenerator/`): `.agency` + `.mts` pairs with assignments, function calls, and returns. Audit calls are always present in generated output.
- **End-to-end test** (`tests/agency/`): run a program with an `onAudit` callback, collect entries, assert on the sequence (nodeEntry, assignment, functionCall, nodeExit, etc.).
- **Existing tests**: `pnpm test:run` to verify nothing breaks.

## CLI Audit Log File

### Config

Add `audit.logFile` to `AgencyConfig` in `lib/config.ts`:

```ts
audit?: {
  logFile?: string;
};
```

This can be set in `agency.json`:

```json
{
  "audit": {
    "logFile": "audit-log.jsonl"
  }
}
```

### CLI flag

Add `-l, --log <file>` to the `run` command in `scripts/agency.ts`. When specified, it overrides `audit.logFile` from config:

```ts
.option("-l, --log <file>", "Write audit log entries to a JSONL file")
```

The CLI passes this into the config before compiling:

```ts
if (options.log) {
  config.audit = { ...config.audit, logFile: options.log };
}
```

### Code generation

In the builder's `generateImports` (or the generated setup section), when `this.agencyConfig.audit?.logFile` is set, emit code that:

1. Imports `appendFileSync` from `fs`
2. Creates a default `onAudit` callback that appends `JSON.stringify(entry) + "\n"` to the log file
3. Wraps the exported node function so that the file-based `onAudit` is used as a default, but a user-provided `onAudit` callback takes precedence

The generated code would look roughly like:

```ts
import { appendFileSync } from "fs";

const __auditLogFile = "audit-log.jsonl";
const __defaultOnAudit = (entry) => {
  appendFileSync(__auditLogFile, JSON.stringify(entry) + "\n");
};
```

And in the exported node function (line ~1954-1982 of the builder), the `callbacks` parameter merging becomes:

```ts
callbacks: { onAudit: __defaultOnAudit, ...callbacks }
```

This way, if the user passes their own `onAudit` callback, it overrides the file logger via spread. If they don't, the file logger is used.

### Priority order

1. User-provided `onAudit` callback (highest — overrides everything)
2. `-l` CLI flag (overrides config)
3. `audit.logFile` in `agency.json` (default)
4. No audit logging to file (if none of the above are set)

## Future Enhancements (not in scope)

- Prompt verbosity config (`audit.promptVerbosity: "none" | "summary" | "full"`)
- `audit.maxEntries` for long-running agents (if storage is added back)
- Parent/child IDs for tracing nested call chains
- Exposing audit context to external TypeScript functions
- `ErrorAudit` entry type for error events
- Audit calls inside nested blocks (`if`/`for`/`while` bodies)
- Integration with effect/handler system
