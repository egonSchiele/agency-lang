# Spec: per-invocation config overrides (and injectable trace id)

**Date:** 2026-08-07
**Status:** revised after review round 1 (see the sibling `-review.md`)
**Repo:** `/Users/adityabhargava/agency-lang/packages/agency-lang` (statelog consumes it)

### Revision notes (round 1)

Changes made in response to the review, all verified against the code:

- **Injected trace id becomes the one effective run id, chosen early** (not just
  the telemetry client's trace id). §3, §4.4.2, §8 step 2. (Review 1.)
- **`RouteResult.traceId` is optional, present only on post-execution results**
  (mirrors `usage`), and **`/resume` inherits its run id and ignores a supplied
  trace id.** §4.3, §4.4.3–4. (Review 2.)
- **`traceFile`/`traceDir` and `client.providerModules` excluded from the
  per-invocation channel** — the first resolves too early to override in
  `createExecutionContext`, the second is process-global and persistent, not
  invocation-local. §5, §6. (Review 3, 4.)
- **`client.defaultModel` deferred** to a follow-up (must ship with
  `defaultProvider`). §5, §10. (Review 6.)
- **Node interface extends the wrapper's existing `{ messages, callbacks }`
  options object** rather than appending an argument; TS interop clarified as
  nodes-only. §4.2. (Review 5.)
- **New §6.1: trace-id uniqueness is the host's responsibility** — documents what
  a duplicate trace id does (verified in statelog: append-only, never overwrites;
  same-project reuse commingles, cross-project reuse is rejected).

---

## 1. Background: what this is about, in plain terms

Agency is a language for building AI agents. You write an agent in a `.agency`
file, and the compiler turns it into a JavaScript module. There are two ways to
actually *run* one of the nodes or functions in that compiled module:

1. **TypeScript interop.** You import the compiled module into your own
   TypeScript and call a node like a normal function:
   `import { main } from "./main.js"; await main("Adit");`
   (See `docs/site/guide/ts-interop.md`.)

2. **Serving.** You hand the compiled module to `createServeHandler`
   (`lib/serve/createServeHandler.ts`), which gives you back a single function
   `handler(method, path, body)`. That function is an HTTP-style *route
   dispatcher*, much like the routes in an Express server: it knows how to
   answer `GET /list`, `POST /function/:name`, `POST /node/:name`, and
   `POST /resume`. The statelog web app runs hosted agents this way — it calls
   `handler(...)` once per incoming request, all inside its own Node process.

Both of these paths, underneath, build the same thing: a `RuntimeContext` (the
object that holds everything a run needs — where to send telemetry, the spend
limit, the LLM client, and so on). Every compiled module builds **one**
`RuntimeContext` the moment it is imported (called `__globalCtx` in the
generated code), and **every later call reuses it**.

### The problem this creates

Because the `RuntimeContext` is built once at import and then frozen, all of its
configuration is decided at import time and shared by every later call. Today
that configuration is fed in through a **process-global variable**
(`activeRuntimeConfigOverrides` in `lib/runtime/configOverrides.ts`). A host that
serves many agents from one process has to set that global, import the agent, and
never let two imports overlap — otherwise they would read each other's config.

This is fine when the configuration truly never changes per call. But there are
real needs it cannot meet:

- **statelog wants to run a hosted agent on a schedule, in the background, and
  have that one run send its telemetry under a freshly-minted, short-lived
  credential** (not the credential that happened to be frozen in when the agent
  was first imported).
- **statelog wants to choose the run's root trace id ahead of time**, store it on
  the schedule record, then run the agent and have the run adopt exactly that id
  — so it can later link "this scheduled run" to "this trace" with certainty.
  Today every run just mints its own random id internally and there is no way to
  inject one.
- **Two overlapping runs must be able to use different config** (different
  credential, different trace id) without contaminating each other. A single
  process-global cannot express that.

The word "telemetry" above means the stream of events a run emits describing what
it did (LLM calls, tool calls, interrupts, and so on). Agency's telemetry system
is called **statelog**; see `docs/dev/statelog.md`. A run's telemetry is stamped
with three things that matter here: a **host** (which server to send events to),
an **apiKey** (the credential that server checks), and a **trace id** (the id that
ties all events from one run together).

### The insight that makes the fix small

The trace id and the per-run telemetry client are **already built fresh on every
call**, inside `RuntimeContext.createExecutionContext` (`lib/runtime/state/
context.ts`). Only the *configuration values* are copied from the frozen parent.
So we do not need to rebuild anything per call — we only need a way to let a
single call override some configuration values at the point where its execution
context is already being created.

---

## 2. What we are building

A way to pass a **config override object** and an optional **trace id** to a
single invocation, on **both** call surfaces:

```ts
// TypeScript interop — a node call gains a trailing options argument:
await main("Adit", { config: { /* Partial<AgencyConfig> */ }, traceId: "abc" });

// Serving — the handler gains a 4th argument:
await handler("POST", "/node/main", body, {
  config: { /* Partial<AgencyConfig> */ },
  traceId: "abc",
});
```

The override applies to **that call only**. When omitted, behavior is exactly as
it is today.

This is a **clean breaking change** to the public call signatures. The language
has no external users yet, so we are not deprecating or preserving the old
signatures — we change them directly.

### The design principle: agency is a mechanism, the host owns policy

The most important decision in this spec is what agency does **not** do.

Agency applies the override with the simplest possible rule: **override-wins.**
Whatever fields the caller supplies replace the corresponding frozen values, for
that one call. Agency does no clamping, no bounds-checking, no trust filtering,
and no per-field special-casing. It treats the config override as **trusted
input** and honors it.

All *policy* lives in the host that calls agency. In practice that host is the
statelog web app. For example:

- **Budget is a request, not a command.** A hosted agent might be given a spend
  cap by its platform (say, "this project may spend at most $5"). If a caller
  passes `budget: { maxCost: 100 }`, statelog does **not** forward that to agency
  as-is. statelog computes `min(platformCap, requested)` **itself** and passes
  the resulting, already-safe number down. Agency just applies that number
  override-wins. Agency never learns what a "cap" or a "tenant" is.
- **Dangerous fields are never forwarded from untrusted input.** Some config
  fields are dangerous if an untrusted caller could set them (see §6). statelog's
  backend *constructs* the config object it passes to `handler(...)`; it never
  splices a raw HTTP request body into it. So those fields cannot arrive from an
  untrusted caller. Enforcing that is the host's job, not agency's.

Why put it this way? Because clamping and trust are inherently about tenants,
credentials, and untrusted callers — concepts the statelog app understands and
the language runtime should not. Keeping agency dumb makes it simple and keeps
the safety logic in the one layer that has the context to get it right.

---

## 3. Current state (verified against the code)

- **One RuntimeContext per module, built at import.** Compiled modules build a
  module-level `__globalCtx` (`lib/backends/typescriptBuilder.ts`, emitted via
  `lib/templates/backends/typescriptGenerator/imports.mustache`). Both call
  surfaces close over it.

- **The config merge is a single, already-curated allow-list.**
  `applyRuntimeConfigOverridesToContextArgs`
  (`lib/runtime/configOverrides.ts:91`) is the one and only place that maps
  `AgencyConfig` fields onto the args used to build a `RuntimeContext`. It is
  called only inside the `RuntimeContext` constructor (`lib/runtime/state/
  context.ts:280-281`), and it reads from two transports:
  - `readConfigOverrides()` — the `AGENCY_CONFIG_OVERRIDES` env var.
  - `getRuntimeConfigOverrides()` — the process-global set by
    `withRuntimeConfigOverrides`.

  Its own doc comment lists the honored fields and states that all others are
  ignored ("the runtime has its own pathways"). The honored set today is:
  `log.*` + `observability`, `traceFile` / `traceDir`, `client.providerModules`,
  `maxCallDepth`, `failurePropagation`, and `budget`. Note (from review): not all
  of these are safe to override *per-invocation* even though the import-time merge
  honors them — `traceFile`/`traceDir` and `client.providerModules` are excluded
  from the per-call channel for concrete reasons (§5).

- **`runId` is chosen before the execution context and drives more than the trace
  id.** In `runNodeCore` (`lib/runtime/node.ts`) the run id is picked first
  (`getSubprocessRunInfo().runId ?? nanoid()`, `node.ts:355`), then used to
  resolve and truncate the trace-file path (`resolveTraceFilePath(ctx.traceConfig,
  runId)`, `node.ts:362`) **before** `createExecutionContext(runId)` is called
  (`node.ts:368`). The same run id also flows to the `TraceWriter`, the
  checkpoints, and each interrupt (`intr.runId = execCtx.runId`, `node.ts:461`),
  and subprocesses/resumes inherit it. So an injected trace id must become the one
  effective **run id**, chosen early — not merely the telemetry client's trace id.

- **The per-run pieces are already built per call.**
  `createExecutionContext(runId)` (`lib/runtime/state/context.ts:379`) builds a
  fresh `StatelogClient` (the telemetry client) for each invocation, using
  `runId` as the trace id. `StatelogClient` already honors an injected id:
  `this.traceId = traceId || nanoid()` (`lib/statelogClient.ts`).

- **AsyncLocalStorage is an established pattern.** `agencyStore`
  (`lib/runtime/asyncContext.ts`) and `spanStorage` (in `statelogClient.ts`)
  already use Node's `AsyncLocalStorage` to carry per-execution values without a
  global. Every serve invocation already runs inside an `agencyStore.run(...)`
  frame — a natural seam for a per-invocation value.

- **The serve handler is a route dispatcher.** `createServeHandler` imports the
  compiled module and returns `handler(method, path, body)`; `createHttpHandler`
  (`lib/serve/http/adapter.ts:228`) matches the method+path to a route and calls
  the matching `__invoke*ForServe` export. `RouteResult` is `{ status, body,
  usage?, usageComplete? }` today.

- **statelog currently bakes budget and recompiles when it changes.** The host
  (`statelog/src/backend/lib/serveHost.ts`) bakes a project's budget into the
  compiled code and folds a `budgetFingerprint` into its handler-cache key, so a
  changed budget forces a full recompile + reimport. This spec makes that
  workaround unnecessary (see §7).

---

## 4. The contract

### 4.1 The invocation-options shape

```ts
export type InvocationOptions = {
  /**
   * Config values to apply to THIS invocation only, as the highest-precedence
   * override. Applied override-wins through the existing runtime config merge.
   * Only runtime-meaningful fields have any effect (see §5); other fields are
   * accepted and ignored, exactly as the existing merge already ignores them.
   * Treated as trusted input — agency does not clamp, bound, or filter it.
   */
  config?: Partial<AgencyConfig>;

  /**
   * The root trace id for this run. When set, it becomes the run's trace id
   * (every event from the run shares it). When omitted, a nanoid() is generated
   * as today.
   */
  traceId?: string;
};
```

### 4.2 TypeScript interop (nodes only)

Only **nodes** are importable into TypeScript; Agency functions are not (see
`docs/site/guide/ts-interop.md`: "Only nodes can be imported into TypeScript").
So this surface concerns node calls only.

The generated node wrapper **already ends in a trailing options object** — the
compiled signature is `async function main(name = <default>, { messages,
callbacks } = {})` (built by `lib/backends/typescriptBuilder/nodeWrapperParams.ts`).
We **extend that existing object**, we do not append a new argument:

```ts
// before: await main("Adit", { messages, callbacks })
// after:  await main("Adit", { messages, callbacks, config, traceId })
```

The positional node arguments are unchanged; `config` and `traceId` join the
options object that is already last. `runNode` (which the wrapper calls) threads
`config`/`traceId` down to the run-id choice and `createExecutionContext` (§8).

### 4.3 Serving (nodes and functions)

`ServeHandler` gains an optional 4th argument, and `RouteResult` gains the
effective trace id:

```ts
export type ServeHandler = (
  method: string,
  path: string,
  body: unknown,
  invocation?: InvocationOptions,   // NEW, optional
) => Promise<RouteResult>;

export type RouteResult = {
  status: number;
  body: unknown;
  usage?: /* unchanged */;
  usageComplete?: boolean;
  traceId?: string;                 // NEW: the effective trace id, PRESENT only
                                    // on post-execution results (see below)
};
```

**`traceId` is optional, and guaranteed present exactly when a run actually
executed** (review point 2). `GET /list`, `404`s, and request-validation `400`s
run nothing, so there is no "trace id actually used" — `traceId` is absent on
those, exactly as `usage`/`usageComplete` already are (`lib/serve/http/
adapter.ts` omits them on pre-execution results). On every post-execution outcome
(success, interrupt, `402` budget, generic failure, cancellation) `traceId` is
the id actually used (supplied or generated), so a caller that did not pre-supply
one can still learn it and correlate. This deliberately mirrors the existing
`usage` presence rule rather than introducing a discriminated result type.

### 4.4 Behavioral requirements

1. **Override-wins.** When `config` is supplied, its runtime-meaningful fields
   replace the frozen values for this call. When omitted, behavior is unchanged.
2. **Injectable trace id becomes the run id.** When `traceId` is supplied on a
   *fresh* invocation (`/node`, `/function`, or a directly-called node), it
   becomes the one effective run id — driving telemetry, trace files, checkpoints,
   and interrupt tagging (§3, §8). When omitted, a `nanoid()` is generated as
   today.
3. **Resume keeps its original run id.** A `/resume` inherits its run id from the
   interrupt payload (`interrupt.runId`); it must not mint a new one. A `traceId`
   supplied on a `/resume` call is **ignored** (the resume continues the original
   trace) — never silently splitting the trace. (A future revision may instead
   *reject* a conflicting supplied id; ignoring is the v1 rule.)
4. **Echo (serve).** `RouteResult.traceId` is the effective trace id on every
   post-execution result, and absent on pre-execution results.
5. **Concurrency-safe.** Two overlapping invocations with different options must
   not cross-attribute. No shared mutable global may carry the per-call values.
   Overlapping calls with different credentials/trace ids each use their own.
6. **Backward-behavior on omission.** Omitting the options preserves today's
   behavior exactly (import-bound config; generated trace id).
7. **Agency enforces no policy.** Agency does not clamp, bound, or trust-filter
   the override. It honors what it can and ignores the rest. Trace-id *uniqueness*
   is likewise the host's responsibility (§6.1).

---

## 5. Which fields are runtime-meaningful

Only fields the runtime actually reads per-run can do anything when overridden
per call. The per-invocation channel is a **deliberately narrower slice** of the
existing honored set of `applyRuntimeConfigOverridesToContextArgs` — narrower
because two of the import-time-honored fields are not actually invocation-local
(see the excluded list below).

**Supported per-invocation (the v1 allow-list):**

- `observability` + `log.{host, apiKey, projectId, requestTimeoutMs, metadata}`
  — where and how telemetry is sent. This is the driving need.
- `budget.{maxCost, maxTime}` — the run's spend/time ceiling. Applied
  override-wins; any clamping is the host's job (§2, §7).
- `maxCallDepth` — the runaway-recursion ceiling.
- `failurePropagation` — failure-propagation mode.

**Excluded from the per-invocation channel (even though the import-time merge
honors them) — resolves review points 3 and 4:**

- `traceFile` / `traceDir` — **excluded.** The trace-file path is resolved and
  truncated from the frozen parent context *before* `createExecutionContext`
  runs (`resolveTraceFilePath(ctx.traceConfig, runId)` at `node.ts:362`, ahead of
  `createExecutionContext` at `node.ts:368`). A `createExecutionContext`-time
  override would arrive too late, and plumbing the override earlier is not worth
  it: these are also an arbitrary-filesystem-write surface (§6), and hosted runs
  ingest telemetry remotely rather than writing local trace files. Left out.
- `client.providerModules` — **excluded.** Provider registration is
  **process-global and persistent**: a module loaded for one invocation stays
  registered for every later invocation. That directly contradicts the
  invocation-isolation promise (§4.4.5), so it cannot honestly be "per-call."
  (It is also an arbitrary-code-execution surface, §6.) Left out; a host that
  needs a custom provider still binds it at import via the existing global path.

**Deferred (not in v1) — resolves review point 6:**

- `client.defaultModel` (and `client.defaultProvider`) — per-call model
  selection. Not needed for the motivating credential/trace/budget use cases, and
  not as isolated as it looks: overriding only `defaultModel` can leave a baked
  `defaultProvider` attached, producing an unintended model/provider pair. If
  added later, `defaultModel` and `defaultProvider` must be supported and
  documented **together**, with a check that the model is read from the per-run
  execution context rather than captured once at import. Left for a follow-up.

**Not meaningful per-call (compile-time only — the module is already compiled):**
`typechecker`, `outDir`, `distDir`, `pack`, `doc`, `coverage`, `test`, `eval`,
`instrument`, `debugger`, `allowNonAgencyGenerators`, `remote`, `viewer`,
`client.{maxToolResultChars, maxToolSchemaChars}` (baked at compile), and
`maxToolCallRounds` (baked into codegen). These are accepted and ignored.

Agency does **not** reject unknown or compile-time fields — it silently ignores
them, exactly as the existing merge already does. This keeps the caller's type
simply `Partial<AgencyConfig>` without a bespoke sub-type.

---

## 6. Security note: agency trusts its caller; the host must curate

Because agency applies the override without filtering, the config object is
**trusted input**. The safety of the whole feature rests on each host building
that object deliberately and never forwarding untrusted request fields into it.
For statelog this is correct by construction: its backend constructs the config
object server-side and never splices a raw HTTP body into it.

Note that the two most dangerous fields — `client.providerModules` (arbitrary
code execution) and `traceFile`/`traceDir` (arbitrary filesystem write) — are
**excluded from the per-invocation channel entirely** (§5), so they cannot ride
in through it at all. The remaining supported fields are still trusted input a
host must curate:

- **`observability.{host, apiKey}` — telemetry redirection.** Telemetry can
  include prompt/tool-argument previews; pointing it at an attacker-controlled
  host is a data-leak vector. Safe only when the host mints and sets these.
- **`budget`, `maxCallDepth` — resource limits.** Safe to *tighten*, unsafe to
  *loosen*, from an untrusted caller. This is exactly why statelog clamps them
  host-side (§2) before passing them down.

Agency's docs (`docs/dev/`) will state this contract: *the config-override object
is trusted input; a host must not forward untrusted request fields into it.*

### 6.1 Trace-id uniqueness is the host's responsibility (and what a collision does)

Agency stamps the supplied `traceId` **verbatim** and never inspects it for
collisions — it has no view of what trace ids already exist. So, exactly like
budget clamping, **supplying a unique id per logical run is the host's job.**

What actually happens on a collision was verified against statelog's ingest
(`statelog/src/backend/routes/api/logs.ts` → `resolveLogTrace` in
`projectAuthorization.ts`). The reassuring headline: **a duplicate trace id never
overwrites or destroys existing data.** Each event is an append-only INSERT into
the `logs` table with its own id (`db/log.ts`); ingest does a find-or-create by
`(trace_id, project)` and never an upsert of event rows. The two collision
outcomes are:

- **Same project, reused id → the runs commingle.** The second run's events are
  appended under the existing trace. No data is lost, but the trace and its span
  tree are now two interleaved runs — misleading, and it corrupts the
  parent/child span reconstruction. This is the realistic failure mode of, say,
  retrying a scheduled run while reusing its stored trace id.
- **Different project, reused id → the events are rejected.** `resolveLogTrace`
  returns "This trace does not belong to the authorized project" and the event is
  dropped, so nothing is written cross-tenant (and nothing in the original trace
  is touched).

The consequences for the contract:

- **Agency:** no change — it stamps the id and does nothing else. This subsection
  is documenting a host obligation, not new agency behavior.
- **Host (statelog):** must supply a collision-resistant id per run (a `nanoid`
  is fine; its stored `schedule_runs.trace_id` should be minted once per run, not
  reused). A **retry that should be a fresh trace must mint a fresh id**; reusing
  the id appends to the old trace rather than replacing it. There is no
  "replace a trace" path — ingest is append-only — so "re-run under the same id"
  is not a supported way to overwrite an earlier run.

---

## 7. What this lets statelog delete

Today statelog bakes each project's budget into the compiled agent and keys its
handler cache on a `budgetFingerprint`, so a changed budget forces a full
recompile + reimport (`statelog/src/backend/lib/serveHost.ts`). With a per-call
budget override, the compiled module becomes budget-agnostic: statelog computes
`min(platformCap, requested)` and passes it on each call. The recompile-per-budget
workaround and the fingerprint cache-key component both go away. (That change
lands in the statelog repo, after this ships; it is noted here as motivation, not
as work in this spec.)

---

## 8. Implementation sketch (non-prescriptive)

The mechanism is shared across both surfaces because both reach
`createExecutionContext`. Suggested seam:

1. **Carry the options in an AsyncLocalStorage frame.** Add an
   `invocationOptionsStore` (an `AsyncLocalStorage<InvocationOptions>`). Set it
   just outside the existing `agencyStore.run(...)` frame in the invokers, so a
   concurrent call cannot see another call's options. This reuses the established
   ALS pattern and avoids threading a new argument through many layers. (Threading
   an explicit argument through `runNode` is an equally valid alternative; the ALS
   frame is suggested only because it avoids codegen churn.)

2. **Resolve one effective run id, early (resolves review point 1).** An injected
   trace id must become the *run id*, not just the telemetry client's trace id,
   because the run id is chosen before `createExecutionContext` and drives the
   trace path, checkpoints, and interrupt tagging (§3). In `runNodeCore`, choose:

   ```ts
   const runId = getSubprocessRunInfo().runId  // resume / subprocess inherits
              ?? invocation?.traceId            // fresh call: injected id
              ?? nanoid();                       // fresh call: generated
   ```

   Then pass that single `runId` everywhere it already flows — `resolveTraceFilePath`,
   `createExecutionContext`, the `TraceWriter`, and `intr.runId`. On the `/resume`
   path the inherited `interrupt.runId` wins and any supplied `traceId` is ignored
   (§4.4.3).

3. **Apply the config override as the highest-precedence layer.** In
   `createExecutionContext`, read the store and run its `config` through
   `applyRuntimeConfigOverridesToContextArgs` **on top of** the frozen config (so
   per-call wins over the import binding), applying it to the fields the context
   copies (`statelogConfig`, `budget`, `maxCallDepth`, `failurePropagation`). Build
   the per-run `StatelogClient` with `traceId: runId` (the effective id from step
   2). Do **not** route `traceFile`/`traceDir` or `client.providerModules` through
   this path — they are excluded (§5).

4. **Grow the public signatures.** Extend the node wrapper's existing trailing
   options object from `{ messages, callbacks }` to `{ messages, callbacks, config,
   traceId }` in `nodeWrapperParams.ts` / the `runNode` call site, and add the 4th
   arg + `traceId` echo to `ServeHandler` / `RouteResult`. (No `client.defaultModel`
   work in v1 — deferred, §5.)

5. **Confirm per-run read points.** For each supported field, verify it is read
   off the per-run execution context and not frozen once on the parent context at
   import. `statelogConfig` already is; `budget`, `maxCallDepth`, and
   `failurePropagation` are each copied from the parent in `createExecutionContext`
   today (the `execCtx.<field> = this.<field>` block around `context.ts:393-402`),
   but `budget`/`maxCallDepth` are consumed by
   guards installed early in the run — verify the override is in place before those
   guards read it.

### Precedence, stated once

From lowest to highest: **compile-time baked < `AGENCY_CONFIG_OVERRIDES` env <
process-global (import binding) < per-invocation options**. Per-invocation is
applied last and wins, override-style, for every honored field. There is no
clamp anywhere in agency; a caller that wants clamping does it before it calls.

---

## 9. Tests to add

- **Concurrency (the key one).** Fire two overlapping invocations with different
  `observability.apiKey` and different `traceId`; assert each run's telemetry
  posts under its own key and its own trace id — no cross-attribution. (Mock the
  telemetry `fetch`; assert per-call headers/body.) Cover both surfaces.
- **Injection.** Supply `traceId: "abc"`; assert the ingested trace id is `"abc"`
  and (serve) `RouteResult.traceId === "abc"`.
- **Echo without injection (serve).** Omit `traceId`; assert `RouteResult.traceId`
  equals the generated id that was ingested.
- **Override-wins.** Supply `config.budget`; assert the run uses the supplied
  value over the frozen one.
- **Injected id becomes the run id, not just the client trace id.** Supply
  `traceId` and enable trace-file output; assert the trace file / checkpoints /
  interrupt `runId` all use the supplied id — guarding against the "only the
  StatelogClient got it" regression (review point 1).
- **Resume ignores a supplied traceId.** Start a run that interrupts, then
  `/resume` with a *different* `traceId`; assert the resumed leg keeps the
  original `interrupt.runId` and does not split the trace (review point 1/§4.4.3).
- **Excluded fields are inert per-call.** Supply `config.traceFile` and
  `config.client.providerModules`; assert neither takes effect for that
  invocation (no file written to the supplied path; no new provider registered) —
  locking in the §5 exclusions (review points 3, 4).
- **Omission is unchanged.** A call with no options behaves exactly as before
  (import-bound config; generated trace id).
- **Compile-time field ignored.** Supply a compile-time field (e.g. `outDir`);
  assert it is silently ignored and nothing breaks.

---

## 10. Out of scope

- **Host-side clamping and trust filtering.** These live in statelog and are not
  part of this change (§2, §7).
- **Per-invocation model selection** (`client.defaultModel` + `defaultProvider`).
  Deferred to a follow-up; must ship as a pair (§5).
- **`traceFile`/`traceDir` and `client.providerModules` per-invocation.** Excluded
  by design (§5); a host still binds these at import via the existing global path.
- **Bring-your-own provider API keys** (`client.apiKey.*` per call). A real
  feature, but a separate one with its own credential-handling review.
- **`agency call` / remote-CLI ergonomics.** Unaffected.
