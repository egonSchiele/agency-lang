# Per-invocation config override — Implementation Plan

> **For the executor:** Execute this plan inline in the main session. Steps use
> checkbox (`- [ ]`) syntax. Each task ends with an independently testable
> deliverable and a commit. Work on branch `adit/per-invocation-config` in
> `/Users/adityabhargava/agency-lang/worktree-per-invocation-config`.

**Spec:** `2026-08-07-per-invocation-config-override-spec.md`

**Goal:** Let one node, served function, or serve-resume invocation carry a
trusted config override and optional root trace id without affecting concurrent
invocations.

**Architecture:** Public callers provide the declarative `InvocationOptions`
request. Transport layers only forward it. The runtime's single
`resolveInvocation()` boundary turns a fresh-or-resume request into a
`ResolvedInvocation`: one effective run id plus a positively allow-listed
context override. Execution-context construction consumes that resolved value;
serve outcomes derive their trace id from the execution context itself. No
caller performs sanitization, chooses resume policy, or separately carries an
already-resolved trace id.

**Why explicit arguments rather than AsyncLocalStorage:** `InvocationOptions` is
immutable call data, and every entry point already has a typed route to the run
core. Forwarding it is concurrency-safe without adding ambient state. The
imperative work—allow-listing config, selecting the run id, and distinguishing a
fresh run from a resume—is encapsulated in `resolveInvocation()` rather than
repeated through the transport layers.

**Tech stack:** TypeScript, Node.js, vitest, TypeScript IR codegen, typestache,
the Agency runtime, and the in-process serve dispatcher.

## Global constraints

- Agency applies override-wins and performs no host policy, budget clamping, or
  trust filtering. The host constructs trusted `InvocationOptions`.
- The v1 config allow-list is exactly `observability`,
  `log.{host,apiKey,projectId,requestTimeoutMs,metadata}`, `budget`,
  `maxCallDepth`, and `failurePropagation`.
- `log.logFile`, `log.debugMode`, `traceFile`, `traceDir`, all `client` fields,
  and every other `AgencyConfig` field are inert in this channel.
- A fresh invocation uses inherited subprocess id, then supplied `traceId`, then
  `nanoid()`, in that precedence order. A supplied empty trace id is rejected.
- A resume always uses `interrupt.runId`; any supplied `traceId`, including an
  empty one, is ignored.
- `RouteResult.traceId` is optional and appears on every post-execution outcome,
  but not on `/list`, 404, or validation results that execute no run.
- Use types, plain objects, and arrays—not interfaces, maps, or sets. Do not add
  dynamic imports, one-line `if` statements, single-character names, or nested
  inline object types.
- Put policy and behavior in `lib/runtime/`; codegen and serve adapters only
  forward typed data.
- Do not make LLM calls in tests. Save every test/build output to a file.
- Do not run the full Agency suite locally. Do not touch `CHANGELOG.md` or
  generated `docs/site/**` pages.

---

## File structure and boundaries

**New files**

- `lib/runtime/invocationOptions.ts` — public request type, internal resolved
  type, positive config projection, and fresh/resume run-id policy.
- `lib/runtime/invocationOptions.test.ts` — pure resolver tests.
- `lib/runtime/state/context.perInvocationOverride.test.ts` — context merge and
  parent-isolation tests.
- `lib/serve/http/perInvocation.integration.test.ts` — serve injection,
  resume, telemetry credentials, and deterministic concurrency tests.
- `docs/dev/per-invocation-config.md` — maintainer contract.

**Modified files**

- `lib/runtime/state/context.ts` — consumes `ResolvedInvocation` and applies its
  already-narrow context override through the existing runtime merge.
- `lib/runtime/node.ts`, `lib/runtime/interrupts.ts` — declare fresh/resume
  requests and call `resolveInvocation()`; they do not inspect config fields.
- `lib/runtime/servedInvocationLifecycle.ts`,
  `lib/runtime/invocationUsage.ts` — outcomes include the execution context's
  effective run id.
- `lib/runtime/index.ts`, `lib/serve/public.ts` — export `InvocationOptions`.
- `lib/serve/createServeHandler.ts`, `lib/serve/http/adapter.ts`,
  `lib/serve/types.ts`, `lib/serve/discovery.ts` — forward options without
  interpreting them.
- `lib/serve/testOutcome.ts` and affected serve tests — construct complete
  usage/trace outcomes.
- `lib/templates/backends/typescriptGenerator/imports.mustache` — typed generated
  forwarding exports; regenerate `imports.ts`.
- `lib/backends/typescriptBuilder/nodeWrapperParams.ts`,
  `lib/backends/typescriptBuilder.ts` — extend the existing node options object
  with collision-safe local aliases.
- `CLAUDE.md` — link the maintainer note.

---

## Task 1: Define and test the declarative invocation resolver

**Files:**

- Create: `lib/runtime/invocationOptions.ts`
- Create: `lib/runtime/invocationOptions.test.ts`
- Modify: `lib/runtime/index.ts`
- Modify: `lib/serve/public.ts`

**Interfaces:**

```ts
export type InvocationOptions = {
  config?: Partial<AgencyConfig>;
  traceId?: string;
};

export type InvocationRequest =
  | { kind: "fresh"; options?: InvocationOptions; inheritedRunId?: string }
  | { kind: "resume"; options?: InvocationOptions; runId: string };

export type ResolvedInvocation = {
  runId: string;
  contextOverride?: PerInvocationContextOverride;
};

export function resolveInvocation(request: InvocationRequest): ResolvedInvocation;
```

`InvocationOptions` is public. `InvocationRequest`, `ResolvedInvocation`, and
`PerInvocationContextOverride` are runtime-internal contracts and are not
re-exported from `agency-lang/serve`.

- [ ] **Step 1: Write failing resolver tests**

Cover these exact cases in `invocationOptions.test.ts`:

```ts
expect(resolveInvocation({
  kind: "fresh",
  inheritedRunId: "parent-run",
  options: { traceId: "requested-run" },
}).runId).toBe("parent-run");

expect(resolveInvocation({
  kind: "fresh",
  options: { traceId: "requested-run" },
}).runId).toBe("requested-run");

expect(resolveInvocation({ kind: "fresh" }).runId.length).toBeGreaterThan(0);

expect(() => resolveInvocation({
  kind: "fresh",
  options: { traceId: "" },
})).toThrow("traceId must not be empty");

expect(resolveInvocation({
  kind: "resume",
  runId: "original-run",
  options: { traceId: "ignored-run" },
}).runId).toBe("original-run");
```

Add one projection test supplying every supported field plus `log.logFile`,
`log.debugMode`, `traceFile`, `traceDir`, `client.defaultModel`,
`client.providerModules`, and `outDir`. Assert `contextOverride` contains only:

```ts
{
  observability: true,
  log: {
    host: "https://logs.example",
    apiKey: "secret",
    projectId: "project",
    requestTimeoutMs: 500,
    metadata: { environment: "test" },
  },
  budget: { maxCost: 1, maxTime: "30s" },
  maxCallDepth: 12,
  failurePropagation: "off",
}
```

- [ ] **Step 2: Run the test and save the expected failure**

```bash
pnpm test:run lib/runtime/invocationOptions.test.ts 2>&1 | tee /tmp/per-invocation-t1.log
```

Expected: failure because `invocationOptions.js` does not exist.

- [ ] **Step 3: Implement the resolver**

Define named `PerInvocationLogConfig` and `PerInvocationContextOverride` types.
Implement a private `selectContextOverride(config)` that constructs a new object
and copies only the v1 fields. Copy the five allowed nested `log` keys
individually; never spread `config.log`. Return `undefined` when no supported
field was supplied.

Implement `resolveInvocation()` as the only owner of run-id policy:

```ts
export function resolveInvocation(
  request: InvocationRequest,
): ResolvedInvocation {
  const contextOverride = selectContextOverride(request.options?.config);
  if (request.kind === "resume") {
    return { runId: request.runId, contextOverride };
  }

  const runId =
    request.inheritedRunId ?? request.options?.traceId ?? nanoid();
  if (runId.length === 0) {
    throw new Error("traceId must not be empty");
  }
  return { runId, contextOverride };
}
```

Use block-form `if` statements and descriptive names. The imperative projection
belongs here; consumers see only the declarative request/result contract.

- [ ] **Step 4: Export the public type**

Add `InvocationOptions` as a type export from `lib/runtime/index.ts` and
`lib/serve/public.ts`. Do not export the resolver or resolved types from the
serve package.

- [ ] **Step 5: Run the resolver tests**

Run the Task 1 command again. Expected: all resolver tests pass.

- [ ] **Step 6: Commit**

Write `feat(runtime): resolve per-invocation options declaratively` to
`/tmp/per-invocation-t1-message.txt`, then run:

```bash
git add lib/runtime/invocationOptions.ts lib/runtime/invocationOptions.test.ts lib/runtime/index.ts lib/serve/public.ts
git commit -F /tmp/per-invocation-t1-message.txt
```

---

## Task 2: Make execution-context creation consume resolved invocations

**Files:**

- Modify: `lib/runtime/state/context.ts`
- Create: `lib/runtime/state/context.perInvocationOverride.test.ts`
- Modify direct `createExecutionContext` call sites returned by:
  `grep -RIl 'createExecutionContext(' lib --include='*.ts'`

**Interface:**

```ts
async createExecutionContext(
  invocation: ResolvedInvocation,
): Promise<RuntimeContext<T>>;
```

There is no overload accepting raw `Partial<AgencyConfig>`. Fixed-id internal
callers pass `{ runId: "…" }`; only run entry points use `resolveInvocation()`.

- [ ] **Step 1: Write failing context tests**

Create a parent context with budget `{ maxCost: 5, maxTimeMs: 60_000 }`, call:

```ts
const overridden = await parent.createExecutionContext({
  runId: "overridden-run",
  contextOverride: {
    budget: { maxCost: 1 },
    maxCallDepth: 10,
    failurePropagation: "off",
  },
});
```

Assert the child has run id `overridden-run`, budget
`{ maxCost: 1, maxTimeMs: 60_000 }`, depth `10`, and propagation `off`. Create a
second child with `{ runId: "base-run" }` and assert it retains all parent
values. Assert the parent itself remains unchanged.

- [ ] **Step 2: Run the test and save the failure**

```bash
pnpm test:run lib/runtime/state/context.perInvocationOverride.test.ts 2>&1 | tee /tmp/per-invocation-t2.log
```

Expected: type/runtime failure because `createExecutionContext` still accepts a
string.

- [ ] **Step 3: Apply the resolved override in `context.ts`**

Destructure `{ runId, contextOverride }`. Build one
`RuntimeContextConstructorArgs` value from the frozen parent fields, apply
`applyRuntimeConfigOverridesToContextArgs(base, contextOverride)`, and copy the
effective `statelogConfig`, `budget`, `maxCallDepth`, and `failurePropagation`
onto the child. Construct the child `StatelogClient` with `traceId: runId`.

Do not repeat allow-list logic in this method. Its input type guarantees that
the resolver has already projected the config.

- [ ] **Step 4: Migrate fixed-id call sites**

Mechanically change `ctx.createExecutionContext("run-1")` to
`ctx.createExecutionContext({ runId: "run-1" })`. Do not change run-id selection
behavior in `node.ts`, `interrupts.ts`, or `rewind.ts` yet; wrap their existing
selected id in `{ runId }` so this commit only changes the context interface.

- [ ] **Step 5: Run context tests and the repository type check**

```bash
pnpm test:run lib/runtime/state/context lib/runtime/invocationOutcome.test.ts 2>&1 | tee /tmp/per-invocation-t2.log
```

Also run the TypeScript check used by `make` and save its output. Expected: all
checks pass and no string-form context calls remain.

- [ ] **Step 6: Commit**

Commit message:
`refactor(runtime): make execution contexts consume resolved invocations`

---

## Task 3: Resolve fresh and resumed runs in the runtime cores

**Files:**

- Modify: `lib/runtime/node.ts`
- Modify: `lib/runtime/interrupts.ts`
- Modify: `lib/runtime/invocationUsage.ts`
- Modify: `lib/runtime/servedInvocationLifecycle.ts`
- Modify: `lib/serve/testOutcome.ts`
- Modify affected tests under `lib/runtime/` and `lib/serve/` that construct
  `ServedInvocationOutcome` literals.

**Interfaces:**

- `RunNodeArgs` and `RunExportedFunctionArgs` gain
  `invocation?: InvocationOptions`.
- `RespondToInterruptsArgs` gains `invocation?: InvocationOptions` without
  changing its existing checkpoint `overrides` or `metadata` fields.
- `ServedInvocationOutcome<T>` gains required `traceId: string`.

- [ ] **Step 1: Add failing lifecycle tests**

Extend `invocationOutcome.test.ts` to assert that
`finishServedInvocation(execCtx, outcome, cleanup)` returns
`traceId === execCtx.getRunId()` for returned, thrown, and cleanup-failure
outcomes. Do not add a separate trace-id parameter to the helper.

- [ ] **Step 2: Run and save the failure**

```bash
pnpm test:run lib/runtime/invocationOutcome.test.ts 2>&1 | tee /tmp/per-invocation-t3.log
```

Expected: `traceId` is absent.

- [ ] **Step 3: Derive outcome identity from the context**

Add required `traceId` to `ServedInvocationOutcome`. In
`finishServedInvocation`, return:

```ts
return {
  ...finalOutcome,
  ...execCtx.invocationUsage.snapshot(),
  traceId: execCtx.getRunId(),
};
```

Extend the existing `overrides` parameter of `returnedOutcome` and
`threwOutcome` in `lib/serve/testOutcome.ts` to accept `traceId`. Have both
builders include `traceId: "test-trace"` before spreading overrides, so ordinary
tests receive a complete outcome and identity-specific tests can pass
`{ traceId: "expected-trace" }`. Update raw outcome literals in
`createServeHandler.test.ts`, discovery tests, adapter tests, MCP tests, and
invocation-usage tests so Task 3 type-checks independently.

- [ ] **Step 4: Resolve fresh node and function invocations**

In `runNodeCore`:

```ts
const resolvedInvocation = resolveInvocation({
  kind: "fresh",
  options: invocation,
  inheritedRunId: getSubprocessRunInfo().runId,
});
const tracePath = resolveTraceFilePath(
  ctx.traceConfig,
  resolvedInvocation.runId,
);
const execCtx = await ctx.createExecutionContext(resolvedInvocation);
```

In `runExportedFunctionCore`, resolve `{ kind: "fresh", options: invocation }`
and pass the result to context creation. Neither core reads `invocation.config`
or implements trace precedence itself.

- [ ] **Step 5: Resolve resumes**

In `respondToInterruptsCore`, after reading the interrupt, call:

```ts
const resolvedInvocation = resolveInvocation({
  kind: "resume",
  options: args.invocation,
  runId: interrupt.runId,
});
const execCtx = await ctx.createExecutionContext(resolvedInvocation);
```

The core does not inspect or drop `args.invocation.traceId`; the resolver owns
that policy. Preserve existing checkpoint `overrides` and `metadata` behavior.

- [ ] **Step 6: Run runtime and outcome tests**

```bash
pnpm test:run lib/runtime/invocationOptions.test.ts lib/runtime/invocationOutcome.test.ts lib/runtime/interrupts.test.ts lib/runtime/node.test.ts 2>&1 | tee /tmp/per-invocation-t3.log
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

Commit message: `feat(runtime): resolve invocation policy at run boundaries`

---

## Task 4: Make serve a transparent InvocationOptions transport

**Files:**

- Modify: `lib/serve/createServeHandler.ts`
- Modify: `lib/serve/http/adapter.ts`
- Modify: `lib/serve/types.ts`
- Modify: `lib/serve/discovery.ts`
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache`
- Regenerate: `lib/templates/backends/typescriptGenerator/imports.ts`
- Modify: `lib/serve/http/adapter.test.ts`
- Modify: `lib/serve/createServeHandler.test.ts`

**Interfaces:**

```ts
export type ServeHandler = (
  method: string,
  path: string,
  body: unknown,
  invocation?: InvocationOptions,
) => Promise<RouteResult>;
```

`ServedExportedFunction.invokeServed` and
`ServedExportedNode.invokeServed` gain the same optional final value. The
adapter forwards it unchanged.

- [ ] **Step 1: Add failing adapter tests**

Add tests proving:

1. node and function `invokeServed` receive the exact options object by identity;
2. `RouteResult.traceId` comes from the served outcome;
3. `/list`, unknown routes, and invalid resume bodies omit `traceId`;
4. a resume callback receives the exact options object by identity.

Use `returnedOutcome(value, { traceId: "trace-from-outcome" })` rather than
hand-building usage snapshots.

- [ ] **Step 2: Run and save the failure**

```bash
pnpm test:run lib/serve/http/adapter.test.ts 2>&1 | tee /tmp/per-invocation-t4.log
```

Expected: handler signatures do not accept or forward the fourth argument.

- [ ] **Step 3: Forward options through the adapter and discovery**

Add `invocation?: InvocationOptions` to the dispatcher, `callFunction`,
`callNode`, and `resumeInterrupts`. Pass it unchanged to the corresponding
served invoker. Do not sanitize it or inspect `traceId` in any serve file.

Have `withUsage()` attach `outcome.traceId` alongside usage. Keep
`RouteResult.traceId` optional because pre-execution results bypass
`withUsage()`.

- [ ] **Step 4: Preserve the generated resume options contract**

Define a named generated type rather than an inline nested type:

```ts
type ServeResumeOptions = {
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
  invocation?: InvocationOptions;
};
```

Keep the generated export's existing third argument:

```ts
export const __respondToInterruptsForServe = (
  interrupts: Interrupt[],
  responses: InterruptResponse[],
  opts?: ServeResumeOptions,
) => _respondToInterruptsForServe({
  ctx: __globalCtx,
  interrupts,
  responses,
  overrides: opts?.overrides,
  metadata: opts?.metadata,
  invocation: opts?.invocation,
});
```

In `createServeHandler`, wrap the module export so the adapter's callback is
`(interrupts, responses, invocation) => moduleResume(interrupts, responses,
{ invocation })`. This keeps the HTTP adapter unaware of checkpoint overrides
and preserves direct generated-module callers.

- [ ] **Step 5: Update node and function generated serve exports**

Accept `invocation?: InvocationOptions` and pass it unchanged in the argument
object sent to `_runNodeForServe` or `_runExportedFunctionForServe`. Run:

```bash
pnpm run templates 2>&1 | tee /tmp/per-invocation-t4-templates.log
```

- [ ] **Step 6: Run serve tests**

```bash
pnpm test:run lib/serve 2>&1 | tee /tmp/per-invocation-t4.log
```

Expected: all serve tests pass.

- [ ] **Step 7: Commit**

Commit message:
`feat(serve): forward per-invocation options and trace identity`

---

## Task 5: Extend the existing TypeScript node options object

**Files:**

- Modify: `lib/backends/typescriptBuilder/nodeWrapperParams.ts`
- Modify: `lib/backends/typescriptBuilder.ts`
- Modify the closest existing TypeScript-generator test for node wrappers.
- Create: `tests/agency-js/per-invocation-options/agent.agency`
- Create: `tests/agency-js/per-invocation-options/test.js`
- Create: `tests/agency-js/per-invocation-options/fixture.json`

**Generated interface:**

```ts
async function main(
  name: string,
  {
    messages: __invocationMessages,
    callbacks: __invocationCallbacks,
    config: __invocationConfig,
    traceId: __invocationTraceId,
  }: ({ messages?: any; callbacks?: any } & InvocationOptions) = {},
)
```

Property aliases prevent collisions with node parameters named `config`,
`traceId`, `messages`, or `callbacks`.

- [ ] **Step 1: Add a failing generator test**

Compile this exact source:

```agency
node main(config: string, traceId: string) {
  return config + traceId
}
```

Assert the generated wrapper contains the four `__invocation…` aliases, uses
`InvocationOptions` in the options type, and passes:

```ts
invocation: {
  config: __invocationConfig,
  traceId: __invocationTraceId,
}
```

This source also proves the hidden options do not duplicate user parameter
bindings.

- [ ] **Step 2: Run and save the failure**

```bash
pnpm test:run lib/backends/typescriptGenerator 2>&1 | tee /tmp/per-invocation-t5.log
```

- [ ] **Step 3: Generate the typed aliases**

Update `nodeWrapperParams()` to emit the aliased destructuring pattern and the
intersection type shown above. Update the `runNode` object in
`typescriptBuilder.ts` to use the hidden aliases. Keep all behavior in runtime;
the builder only packages arguments.

- [ ] **Step 4: Add the Agency-JS fixture**

The agent contains a pure node returning its input. `test.js` imports the
compiled module, calls the node with `{ traceId: "interop-trace" }`, and uses the
fixture harness's fetch mock to assert emitted remote telemetry carries
`interop-trace`. Do not use `log.logFile`, because it is intentionally outside
the v1 allow-list.

- [ ] **Step 5: Run generator and fixture tests**

```bash
pnpm test:run lib/backends/typescriptGenerator 2>&1 | tee /tmp/per-invocation-t5.log
pnpm run agency test js tests/agency-js/per-invocation-options 2>&1 | tee /tmp/per-invocation-t5-agency-js.log
```

Expected: both pass without LLM calls.

- [ ] **Step 6: Commit**

Commit message: `feat(codegen): expose typed per-invocation node options`

---

## Task 6: Prove telemetry isolation, resume identity, and deterministic overlap

**Files:**

- Create: `lib/serve/http/perInvocation.integration.test.ts`

- [ ] **Step 1: Build a reusable mock remote sink**

Use an array of `{ authorization, traceId }` records. The mock fetch parses each
`/api/logs` body and records its `Authorization` header. For the concurrency
case, return a promise that does not resolve until the array contains at least
one record for both `trace-A` and `trace-B`. Because end-of-run cleanup flushes
in-flight telemetry, the first handler remains active until the second reaches
the sink; this makes overlap deterministic.

Do not use `Set`, single-character variables, or fall through to real network
access. Throw on any unexpected URL.

- [ ] **Step 2: Add fresh invocation tests**

Using a compiled pure node and `createServeHandler`, assert:

- supplied `traceId: "injected-trace"` is returned and appears on every event;
- omitted `traceId` produces one non-empty returned id matching every event;
- supplied empty `traceId` returns the existing generic execution failure path
  and performs no telemetry post;
- per-invocation host/api key/project id override the frozen parent only for that
  call; the next call without options uses the frozen values.

- [ ] **Step 3: Add resume identity test**

Run a pure interrupting node, capture `interrupt.runId`, then resume through the
handler with a different supplied trace id and a fresh telemetry credential.
Assert the resumed result and events retain `interrupt.runId`, while requests use
the fresh credential. This proves trace identity and config policy are resolved
independently.

- [ ] **Step 4: Add deterministic concurrency test**

Start two handler promises with distinct ids and credentials. Await both. Assert
every `trace-A` record has `Bearer key-A`, every `trace-B` record has
`Bearer key-B`, and both traces posted at least once. The sink barrier from Step
1 must observe both traces before releasing either handler.

- [ ] **Step 5: Run the integration test**

```bash
pnpm test:run lib/serve/http/perInvocation.integration.test.ts 2>&1 | tee /tmp/per-invocation-t6.log
```

Expected: all tests pass with no external requests.

- [ ] **Step 6: Commit**

Commit message: `test(serve): prove per-invocation telemetry isolation`

---

## Task 7: Document the abstraction and policy boundary

**Files:**

- Create: `docs/dev/per-invocation-config.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the maintainer note**

Document:

- `InvocationOptions` is a declarative trusted request;
- transport layers forward it unchanged;
- `resolveInvocation()` is the only owner of allow-listing and run-id policy;
- `ResolvedInvocation` is the only input accepted by context construction;
- fresh, subprocess, empty-id, and resume rules;
- `finishServedInvocation()` derives identity from `execCtx.getRunId()`;
- exact v1 config fields and excluded filesystem/code-loading fields;
- host-owned budget clamping, credential construction, and trace uniqueness;
- `RouteResult.traceId` presence rules and collision behavior.

Link the spec and name the runtime, serve, and codegen tests that guard the
contract.

- [ ] **Step 2: Add the CLAUDE.md pointer**

Add one line under Deeper docs describing the resolver boundary, run-id rules,
allow-list, and host policy boundary.

- [ ] **Step 3: Commit**

Commit message: `docs(dev): explain per-invocation resolution boundary`

---

## Final verification

- [ ] Run the full build because a typestache template changed:

```bash
make 2>&1 | tee /tmp/per-invocation-build.log
```

- [ ] Run the focused sweep:

```bash
pnpm test:run lib/runtime/invocationOptions.test.ts lib/runtime/state/context.perInvocationOverride.test.ts lib/runtime/invocationOutcome.test.ts lib/runtime/interrupts.test.ts lib/serve lib/backends/typescriptGenerator 2>&1 | tee /tmp/per-invocation-sweep.log
```

- [ ] Run the Agency-JS fixture:

```bash
pnpm run agency test js tests/agency-js/per-invocation-options 2>&1 | tee /tmp/per-invocation-agency-js.log
```

- [ ] Run structural lint and the repository's CI type-check command, saving both
  outputs. Do not suppress failures.
- [ ] Search the diff for `Map`, `Set`, `interface`, one-line `if` statements,
  dynamic imports, single-character local names, duplicated run-id selection,
  and config-field inspection outside `invocationOptions.ts`.
- [ ] Read the complete diff against `docs/dev/anti-patterns.md` and
  `docs/dev/coding-standards.md`.
- [ ] Confirm `InvocationOptions` is publicly importable from both
  `agency-lang/runtime` and `agency-lang/serve`, while resolved internal types are
  not exported from the serve package.
- [ ] Confirm no per-invocation path accepts `log.logFile`, `traceFile`,
  `traceDir`, or `client.providerModules`.
- [ ] Do not run the full Agency suite locally; CI owns it.

## Self-review against the spec and prior reviews

- Public request shape and both call surfaces: Tasks 1, 4, and 5.
- Positive v1 allow-list and dangerous-field exclusion: Task 1.
- One effective run id used before trace path/context construction: Tasks 1–3.
- Resume retains interrupt identity while accepting fresh config: Tasks 1, 3,
  and 6.
- Post-execution-only trace echo: Tasks 3 and 4.
- Concurrent credential/trace isolation: Task 6.
- No model/provider override: enforced by Task 1 projection.
- Declarative boundary: transport forwards `InvocationOptions`; runtime resolves
  it once; context consumes `ResolvedInvocation`; lifecycle reads identity from
  context.
- No sanitizer precondition or duplicated trace-id argument remains.
- Public type exports, generated wrapper collisions, outcome fixture updates,
  empty-id semantics, and deterministic overlap are explicitly covered.
