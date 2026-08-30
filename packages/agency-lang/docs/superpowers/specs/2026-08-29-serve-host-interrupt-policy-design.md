# Host-supplied interrupt policy for served agents

Date: 2026-08-29. Status: design, revised twice
(`-REVIEW.md`, then `-REVIEW-2.md` plus the owner's correction on the resume
leg). The resume-response-binding section was cut — see "The resume leg"
below.

Terminology: **host** is the process serving other people's agents; statelog
is the concrete host this is written for. The two words mean the same thing.

Companion: a statelog spec (to be written against this one) that builds the
per-project policy and scrubs statelog's own environment at boot.

## Why

A serve host runs other people's agents inside its own process. Today it has
no say in which interrupts those agents may raise: an agent's own
`with handler(...)` block can approve anything. The host only ever sees
interrupts nobody downstream settled.

That became a live problem in 0.17.0, where `env()` started raising
`std::env`. A hosted agent calling `env("MY_SECRET")` now surfaces an
unattended interrupt to the host, which cannot answer it (its serve path has
no interrupt-handling seam), so the hosted-secrets feature broke. The same
agent could instead wrap the call in an approving handler and read
`DB_PASSWORD` out of the host's environment — the real gap.

The host needs a **root policy** that:

- decides an interrupt when it is *raised*, ahead of and overriding the
  agent's own handlers (a host `reject` beats any inner `approve`), so a
  refused read is settled before it ever surfaces;
- can vary per invocation (the host's rule for `std::env` is "approve iff
  `name` is one of *this project's* secrets");
- governs interrupts raised on the fresh run and interrupts raised during a
  resume leg alike;
- costs nothing for hosts that don't use it.

The enforcement point is the **raise**, not the caller's answer. That matters
because a served resume is stateless: the caller sends back the checkpoint and
interrupt objects, so everything about the resumed state is caller-controlled
(see "The resume leg"). Deciding on the raise sidesteps that entirely — at the
moment `interrupt std::env(...)` fires, the effect data is the real in-memory
value, not something echoed by the caller.

Almost all of this already exists for CLI runs: `agency run --policy`
installs `makeRunPolicyHandler(policy)` as the outermost handler on both
entry points (`lib/runtime/node.ts` bootstrap and `respondToInterruptsCore`
in `lib/runtime/interrupts.ts`), and chain precedence is
`reject > propagate > approve` regardless of nesting
(`mergeChainOutcomes`). The policy grammar (`lib/runtime/policy.ts`) matches
on interrupt data with globs, first match wins. What's missing is a way for
a host to *supply* that policy other than the `AGENCY_RUN_POLICY`
environment variable.

## Non-goals

- Changing the policy grammar. Statelog's needs (`std::env` by `name`,
  later `std::read` by `dir`/`filename`) are expressible today.
- A per-server static policy on `CreateServeHandlerOptions`. Statelog
  caches one handler per module across projects, so the policy has to be
  per invocation anyway; a host wanting a baseline merges it itself.
- Making `env()` return host-supplied values instead of reading
  `process.env`. Statelog keeps injecting secret values into the
  environment for now; the policy is what stops reads of everything else.
  Hiding the host's own variables is statelog's job (its companion spec).
- Resume-leg integrity (checkpoint tampering and interrupt-id replay). This is
  the real resume-leg risk and it is NOT what a policy fixes — see "The resume
  leg". Closing it needs checkpoint signing (an HMAC the runtime writes on
  creation and verifies on restore) and/or host-side checkpoint storage so the
  caller only holds an interrupt id, plus replay protection on that id. Tracked
  separately on `docs/dev/security/roadmap.md`; out of scope here.
- Process isolation for served agents. Still the long-term answer; this
  spec is the policy layer that isolation would also need.
- Touching the MCP serve path (`lib/serve/mcp/interruptLoop.ts`), which has
  its own post-hoc `runWithPolicy` loop over surfaced interrupts. That loop
  cannot veto an agent's own handlers and re-enters the run once per
  interrupt batch; the mechanism here is strictly stronger, and MCP can
  migrate to it later if wanted.

## Design

### 1. `InvocationOptions.policy`

```ts
// lib/runtime/invocationOptions.ts
export type InvocationOptions = {
  config?: Partial<AgencyConfig>;
  traceId?: string;
  /** Root interrupt policy for this invocation, installed as the outermost
   *  handler on the fresh run and on every resume leg. A `reject` here
   *  beats any approval from the agent's own handlers or from the
   *  resuming caller. Replaces (does not merge with) an AGENCY_RUN_POLICY
   *  environment policy for this run. */
  policy?: Policy;
};
```

`ResolvedInvocation` gains `policy?: Policy`. `resolveInvocation` today does
no validation — it is a pure resolver returning `{ runId, contextOverride }`
— so this adds a `validatePolicy` call and a new `InvalidInvocationPolicyError`
(a plain `Error` subclass carrying the schema message), thrown on failure.
`resolveInvocation` is called on both the fresh path (`node.ts` `runNodeCore`)
and the resume path (`respondToInterruptsCore` in `interrupts.ts`) before
`createExecutionContext`, so the throw lands before any execution context
exists. The HTTP adapter routes it through `errorResult` (`adapter.ts:132`),
which logs the message host-side and returns the generic `TOOL_ERROR_MESSAGE`
to the caller — no server detail leaks. That is the right handling for a host
bug: loud in the host's log, opaque to the caller. There is no distinct
invocation-error response shape.

`ServeHandler`'s fourth argument is already `InvocationOptions`, so a host
passes `policy` alongside `config`/`traceId` on both `/node/*` and
`/resume` with no adapter change.

### 2. Installing the handler

`installRunPolicyHandler` gains an explicit-policy parameter whose default
preserves the CLI behaviour (read the env policy):

```ts
export function installRunPolicyHandler(
  execCtx: { pushHandler: (h: HandlerFn, liveGuardIds: string[]) => void },
  policy: Policy | undefined = loadEnvPolicy() ?? undefined,
): void {
  if (isIpcMode()) return;
  if (!policy) return;
  execCtx.pushHandler(makeRunPolicyHandler(policy), []);
}
```

The parameter is `Policy | undefined` on purpose: passing `resolved.policy`
(which is `undefined` when the host supplied none) triggers the default and
falls back to the env policy. So the call sites just pass `resolved.policy` —
no `?? loadEnvPolicy()` spelled out, and `loadEnvPolicy` stays private. (There
is no need for a `null` "policy present but empty, do not read env" meaning;
if one is ever wanted, add it then.)

The two call sites are not symmetric — the fresh path needs one
thread-through:

- **Resume** (`respondToInterruptsCore`, `interrupts.ts:805`): `resolved` is
  already in scope, so this is a one-argument change:
  `installRunPolicyHandler(execCtx, resolved.policy)`. This governs interrupts
  raised *during* the resume leg (a fresh raise on a resumed run), exactly as
  on a first run. It does not touch the caller's answers to already-surfaced
  interrupts — those were decided on their original raise, and the resume leg
  cannot re-decide them safely anyway (see "The resume leg").
- **Fresh run**: the install runs inside `initFreshExecCtx(execCtx, opts)`
  (`node.ts:202`), the shared bootstrap for served nodes *and* served
  functions. That function takes only `{ initializeGlobals }` today — the
  `ResolvedInvocation` lives one frame up in `runNodeCore` / the served path,
  and `RuntimeContext` carries no policy field. So add `policy?: Policy` to
  `initFreshExecCtx`'s opts and pass `resolved.policy` from each caller
  (`:298`, `:413`). Because `initFreshExecCtx` is the single fresh-run
  bootstrap, this one change covers `/node/*` and `/function` alike.

`liveGuardIds: []` and the IPC gate are unchanged: the policy stays root-only
and is never metered by user guards. Precedence with user handlers is the
existing chain merge, so nothing in `interrupts.ts` dispatch changes.

### 3. The resume leg: why there is nothing to bind, and what the real risk is

An earlier draft of this spec added a step to re-check the policy against the
caller's responses on `/resume`. That was wrong on two counts, both surfaced
in review.

**It checked data the resumed program never reads.** A resume returns a
response by interrupt id — the generated site does
`ctx.getInterruptResponse(id)` and returns it (`agencyInterrupt.ts:158`)
without re-reading the interrupt's `effect` or `data`. The effect that
actually runs uses the *restored execution state*, not the echoed interrupt
object. Concretely, `env` is:

```
def requestEnvRead(name: string): string | null {
  return interrupt std::env("...", { name: name })   // raise: {name} is live
  return _env(name)                                   // on approve: reads process.env[name]
}
```

On resume, `_env(name)` reads `process.env[name]` where `name` comes from the
restored frame. The `interrupt.data.name` the caller echoes back is only the
raise-time display/policy copy; rewriting it changes nothing.

**It was redundant.** The policy already decided this interrupt on its
*raise*, via the §2 root handler, when the effect data was the real in-memory
value. If the policy rejects `std::env` for `DB_PASSWORD`, that rejection
fires on the raise and the interrupt never surfaces. Nothing the policy would
reject on resume survives to the resume leg to be re-rejected.

So §2 is the whole enforcement: install the root handler on the fresh run and
re-install it on the resume exec context so interrupts *raised during* the
resume are governed too. There is no response-rewrite, no reorder of
`respondToInterruptsCore`, and no new `resolvedBy` on the resume path.

**The real resume-leg risk is checkpoint integrity, not response-binding.**
A served resume is stateless: the caller sends back the checkpoint and
interrupt objects, and `respondToInterruptsCore` restores whatever arrives
(`interrupt.checkpoint ?? ctx.checkpoints.get(...)`; the checkpoint's own
budget ceiling is already noted as caller-controllable). The concrete attack:
an agent reads `env("FOO")` — a variable the project owns — the host approves
it on the raise, and the checkpoint serializes the execution state including
the argument `"FOO"`. Before resuming, the caller edits the checkpoint so the
serialized argument reads `"DB_PASSWORD"`. Now they hold a checkpoint carrying
a host approval that replays as a read of a variable the host never approved.
Rewriting the interrupt's display `data` was never needed for this; editing
the *checkpoint* is.

No policy check on the resume leg can stop this, because the trusted copy of
"what was approved" would live in the very checkpoint the caller controls.
Closing it needs one of:

- **Checkpoint signing** — the runtime writes an HMAC over the checkpoint on
  creation and verifies it on restore, so a tampered checkpoint is refused.
- **Host-side checkpoint storage** — the host keeps the checkpoint in its own
  store and hands the caller only an interrupt id, so there is nothing to
  tamper. This still needs replay protection on the id (a caller could resend
  an older, already-approved id).

Both are separate, larger security items on `docs/dev/security/roadmap.md`.
This spec deliberately does not attempt them; it delivers the raise-time
enforcement (§2) that fixes the 0.17.0 break, and names the resume-integrity
gap so the roadmap is not read as closing it.

### 4. What the host sees

Nothing new in the response shape. A policy-rejected interrupt produces the
same failed-run result an agent-handler rejection does today, with the
existing "interrupt rejected" message (the policy does not attach a reason; a
host that wants a per-effect explanation wraps it on its side, where it knows
the project). An interrupt the policy settles on the raise never appears in
the `interrupts` batch; interrupts it `propagate`s or does not mention behave
exactly as before.

Observability note (optional, not required for this spec): the root-policy
handler's decisions currently emit `resolvedBy: "handler"` like any handler.
A host may want them tagged `resolvedBy: "policy"` (the enum already admits
it, `statelogClient.ts:1119`) so a run rejected by the host policy is
distinguishable from one rejected by the agent's own handler. That is a
one-line change at the root handler's decision site and can land here or
later; it is not load-bearing.

### 5. Data flow, end to end

```
host  ── ServeHandler(method, path, body, { policy, config, traceId })
        │
        ├─ /node/*      ┐  both fresh-run routes share initFreshExecCtx
        ├─ /function/*  ┘
        │             → resolveInvocation (validate policy)
        │             → initFreshExecCtx(execCtx, { …, policy }):
        │                 installRunPolicyHandler(execCtx, policy)  [outermost]
        │             → run; agent handlers sit inside; chain merge: reject > propagate > approve
        │             → unsettled interrupts surface to host as today
        │
        └─ /resume  → resolveInvocation (validate policy)
                      → installRunPolicyHandler(execCtx, policy)   [outermost, again]
                      → setInterruptResponses(caller responses, unchanged)
                      → resume loop; interrupts RAISED during resume go through
                        the root handler as on a fresh run; already-surfaced
                        interrupts resolve by their caller response (decided on
                        their original raise — see §3)
```

Note what the resume branch does NOT do: it does not re-evaluate the policy
against the caller's responses. Enforcement happened on the raise (§2/§3).

## Testing

Unit (`lib/runtime`):

- `invocationOptions.test.ts`: `policy` passes through `resolveInvocation`
  for fresh and resume; an invalid policy throws a plain `Error` prefixed
  "invalid invocation policy" naming the schema problem (a class would have
  no consumer — the adapter maps every throw to the same generic message);
  no policy → `undefined`.
- `runPolicyHandler.test.ts`: an explicit policy installs the handler; the
  explicit-vs-env precedence test uses **disagreeing** policies — env set to
  reject an effect, explicit policy set to approve it, and the handler must
  return approve (a test where both agree would pass even if the env leaked
  through); IPC mode still skips.
- resume-leg raise (in the agency-js fixture, not `interrupts.test.ts`, which
  tests leaf functions with stubs): installing the root handler on the resume
  exec context governs an interrupt **raised during** the resume leg (a fresh
  raise on a resumed run) — a policy `reject` there settles the raise, so an
  `env` read comes back `null` instead of surfacing; and the
  no-policy resume path is byte-identical to today (caller responses untouched,
  `resolvedBy: "user"`).

Integration: a new agency-js fixture, `tests/agency-js/serve-policy/`, that
compiles a real module and drives its serve entry points
(`__invokeNodeForServe`, `__invokeFunctionForServe`,
`__respondToInterruptsForServe`) with `InvocationOptions`. (The plan first
pointed at `adapter.perInvocation.test.ts`, but that file is spies only — no
serve test compiles a module; see the plan's Facts.) One behavioural note the
cases below depend on: `env()` absorbs its own denial and returns `null`
(`stdlib/system.agency`), so a policy reject on `std::env` never fails the
run — the refused variable reads as unset, which is what a host wants.

- agent calls `env("A")` with no handler; policy `{"std::env": [{match:{name:"A"}, action:"approve"}, {action:"reject"}]}`
  → returns the value; `env("B")` → returns `null`, no interrupt surfaced.
- **(security-critical — do not fold into the `env("B")` case in a shrink
  pass)** agent wraps `env("B")` in an approving handler
  (`handle { … } with approve`); same policy → still `null`, not the value.
  This is the one test that proves a host `reject` beats the agent's own
  approving handler; `env("B")` with no handler proves nothing about
  precedence because there is no inner handler to beat.
- the approving-handler node under a policy with an explicit `propagate` rule
  → the interrupt surfaces anyway (a propagate verdict beats an approve in
  the chain; the host's "always ask me" works even over an auto-approving
  agent).
- a served function (not just a node) with the same `env` policy, proving the
  shared `initFreshExecCtx` install covers served functions too.
- `traceId`/`config` behaviour unchanged when `policy` is present.

Docs (see Rollout for who owns which): a "Serve hosts" section for the
policies guide, and a note that `CreateServeHandler`'s fourth argument carries
`policy`; a dev note under `docs/dev/hosting/how-hosted-serving-works.md`
covering the root policy and the resume-integrity gap.

## Rollout

Single PR in agency-lang, no migration, no CLI change. Existing hosts that
pass no `policy` are unaffected. The host's companion PR (a separate repo)
then passes a per-project policy; once this agency-lang change is released,
the host's own `projectSecretsEndToEnd` CI test goes green again via a
`std::env` approve rule rather than any host-side auto-approval.

`docs/site/guide/policies.md` is a hand-written, owner-owned page. The
implementer does NOT edit it; the needed "Serve hosts" additions are listed
in the PR description for the owner. The dev note
(`docs/dev/hosting/how-hosted-serving-works.md`) and its
`docs/dev/runtime/interrupts.md` cross-reference are the implementer's to
write. While there, correct `how-hosted-serving-works.md` where it says the
caller sends the interrupt objects back "unchanged": the runtime does not
verify that (see §3, the resume-integrity gap).
