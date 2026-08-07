# Review: per-invocation config override spec

The core approach is sound, but the following points should be resolved before implementation.

## 1. Injected `traceId` must become the run ID

The implementation sketch only uses `options.traceId ?? runId` when constructing the per-run `StatelogClient`. That is not enough. Today `runId` is chosen before `createExecutionContext` and also drives trace-file paths, checkpoints, interrupts, subprocess inheritance, and resumes.

A fresh invocation should choose one effective run ID, approximately:

```ts
const runId = inheritedRunId ?? invocation.traceId ?? nanoid();
```

That ID should then be passed everywhere, including `createExecutionContext`. A resume must retain `interrupt.runId`; the contract should say whether a conflicting supplied trace ID is rejected or ignored.

## 2. `RouteResult.traceId` cannot truthfully be required for every route

`GET /list`, 404 responses, and request-validation failures execute no run, so there is no “trace id actually used.” The existing usage fields already distinguish pre-execution results from post-execution outcomes.

Either make `traceId` optional and guarantee it on every post-execution result, or introduce a discriminated route-result type. The spec should also define `/resume` separately because a resume inherits its original run ID rather than minting a new one.

## 3. `traceFile` and `traceDir` cannot be overridden only in `createExecutionContext`

`runNodeCore` resolves and truncates the trace path from the frozen parent context before it calls `createExecutionContext`. Applying the override inside `createExecutionContext` is therefore too late.

Either compute the effective invocation configuration before trace-path resolution or exclude these fields from the per-invocation contract.

## 4. `client.providerModules` is not invocation-local

Provider registration is process-global and retained after a module is loaded. A provider module loaded for one invocation remains registered for later invocations. That behavior conflicts with the spec's broad invocation-isolation promise.

Exclude `client.providerModules` from per-invocation overrides unless persistent, additive behavior is explicitly part of the contract.

## 5. TypeScript node exports already have a trailing options object

Generated node wrappers already end with `{ messages, callbacks }`. The implementation should extend that object to include `config` and `traceId`, rather than append another argument.

The wording about “node/function invokers” should also be clarified: nodes are the public TypeScript-interop surface, while Agency functions are exposed through the serving machinery.

## 6. Defer `client.defaultModel`

Per-invocation model selection is not needed for the motivating credential, trace, and budget use cases. It is also not quite as isolated as the spec suggests: changing only `defaultModel` can leave a baked `defaultProvider` attached, producing an unintended model/provider pair.

Either support and document `defaultModel` and `defaultProvider` together, or leave model selection for a follow-up change.

## Recommendation

Approve the design after resolving items 1–4. The AsyncLocalStorage-based isolation and host-owned policy decisions are otherwise reasonable.
