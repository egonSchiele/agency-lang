# Per-invocation config overrides and injectable trace id

A single invocation — a node called from TypeScript, a served function or node,
or a serve resume — can carry a **config override** and an optional **root trace
id** that apply to that call only. This is how a host (statelog) runs one hosted
agent under a caller-supplied credential and a pre-chosen trace id, without the
import-time config being frozen for every call. The design spec is
`2026-08-07-per-invocation-config-override-spec.md`.

## The one rule: agency is a mechanism, the host owns policy

Agency applies the override with **override-wins** semantics and enforces no
policy — no budget clamping, no bounds-checking, no trust filtering. The config
object is **trusted input** that the host constructs. Clamping (e.g. treating a
requested budget as a request bounded by a platform cap) and credential minting
live in the host, never here. See the spec §2.

## The shape of the flow

```
InvocationOptions   (public request: { config?, traceId? })
   → transport layers forward it unchanged (serve adapter, discovery, codegen)
      → resolveInvocation(request)            ← the ONE policy owner
         → ResolvedInvocation { runId, contextOverride }
            → createExecutionContext(resolved) applies the override
               → finishServedInvocation derives outcome.traceId from execCtx.getRunId()
```

- **`InvocationOptions`** (`lib/runtime/invocationOptions.ts`) is the only public
  type; it is re-exported from `agency-lang/runtime` and `agency-lang/serve`.
  `InvocationRequest`, `ResolvedInvocation`, and `PerInvocationContextOverride`
  are runtime-internal and are **not** exported from the serve package.

- **`resolveInvocation()`** is the single owner of run-id policy and the config
  allow-list. Nothing else re-implements either. It:
  - projects the caller's raw `config` down to the positive v1 allow-list (see
    below), building fresh objects — it never spreads `config.log`, so a future
    dangerous sub-field cannot leak through;
  - picks the run id. Fresh: inherited subprocess id → supplied `traceId` →
    `nanoid()`. A supplied empty trace id on a fresh run throws. Resume: always
    `interrupt.runId`; any supplied `traceId` (empty or not) is ignored.

- **`createExecutionContext(resolved)`** (`lib/runtime/state/context.ts`) takes a
  `ResolvedInvocation` (no string overload) and applies `contextOverride` over the
  frozen parent through the existing `applyRuntimeConfigOverridesToContextArgs`
  merge. It never re-derives the allow-list — its input type guarantees the
  projection already happened.

- **`finishServedInvocation`** (`lib/runtime/servedInvocationLifecycle.ts`) stamps
  the outcome's `traceId` from `execCtx.getRunId()`, so the serve adapter echoes
  identity without re-deriving it. `RouteResult.traceId` is present on every
  post-execution result and absent on `/list`, 404, and validation 400 (it rides
  the same presence rule as `usage`).

## The v1 config allow-list

Applied per-invocation: `observability`; `log.{host, apiKey, projectId,
requestTimeoutMs, metadata}`; `budget`; `maxCallDepth`; `failurePropagation`.

Deliberately **inert** in this channel (never copied by the projection):
`log.logFile`, `log.debugMode`, `traceFile`, `traceDir`, every `client.*` field
(including `defaultModel`/`providerModules`), and all other `AgencyConfig` fields.
`traceFile`/`traceDir` resolve before the execution context exists and are an
arbitrary-write surface; `client.providerModules` registers process-globally and
persists across calls, so it is not invocation-local; per-call model selection is
deferred (it must ship with `defaultProvider`). See spec §5.

## Host responsibilities (not enforced here)

- **Budget is a request.** A host clamps a caller's budget to its platform cap
  before passing it down; agency applies whatever number it receives.
- **Trusted construction.** A host builds the `config` object server-side and
  never forwards untrusted request fields into it (the excluded fields above are
  inert regardless, but the honored ones still carry credentials/limits).
- **Trace-id uniqueness.** Agency stamps the supplied id verbatim. statelog ingest
  is append-only and never overwrites: reusing an id within a project commingles
  events under one trace (corrupting its span tree); reusing one across projects
  is rejected. A retry that should be a fresh trace must mint a fresh id. See
  spec §6.1.

## Tests that guard the contract

- `lib/runtime/invocationOptions.test.ts` — the resolver: run-id precedence,
  empty-id rejection, resume-keeps-id, and the positive projection.
- `lib/runtime/state/context.perInvocationOverride.test.ts` — the override is
  applied per child and does not mutate the parent.
- `lib/runtime/invocationOutcome.test.ts` — outcome `traceId` derives from the
  execution context.
- `lib/backends/typescriptBuilder/nodeWrapperParams.test.ts` — the generated node
  wrapper uses collision-safe aliases and forwards the invocation.
- `lib/serve/http/adapter.perInvocation.test.ts` — the adapter forwards the exact
  options by identity and echoes `traceId` only on post-execution results.
- `lib/serve/http/perInvocation.integration.test.ts` — real cores + StatelogClient
  with a mocked fetch: injection, per-call credential, and concurrent
  no-cross-attribution.
