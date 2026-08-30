# Review: Host-supplied interrupt policy for served agents

Reviewer: Claude. Date: 2026-08-30.
Spec: `2026-08-29-serve-host-interrupt-policy-design.md`.

Verdict: a well-scoped, accurate spec that reuses the existing policy/handler
machinery instead of adding a parallel mechanism, and the security property it
depends on is real and already proven by the CLI `--policy` path. Every code
claim I checked holds. Three things need attention before implementation: one
real wiring gap on the fresh-run path the spec treats as trivial, one ordering
precision issue in §3, and a simplification of the §3 rule. The rest are minor.

## What I verified (all accurate)

- CLI `--policy` installs `makeRunPolicyHandler` as the outermost handler on both
  entry points (`node.ts` bootstrap, `respondToInterruptsCore` in
  `interrupts.ts:805`); `mergeChainOutcomes` is `reject > propagate > approve >
  noResponse` (`interrupts.ts:411,419`) regardless of nesting, so a root
  `reject` is genuinely un-bypassable by an agent's own approving handler. The
  central security claim holds.
- `policy.ts` has the grammar, globs, and `checkPolicyExplicit` that returns
  `null` when no rule matches — exactly what §3 needs to leave un-mentioned
  effects to the caller.
- `InvocationOptions` today is `{ config?, traceId? }`, and `ServeHandler`'s
  fourth argument is already `invocation?: InvocationOptions`
  (`createServeHandler.ts:16`). So "a host passes `policy` with no adapter
  change" is true for the transport; the only real wiring is inside the runtime
  (see the gap below).
- §3's core premise is correct: on resume, a caller response bypasses the
  handler chain. `agencyInterrupt.ts:158` reads `getInterruptResponse` first and
  only falls through to `interruptWithHandlers` (line 166) when there is none.
  So without §3 the root handler never sees a resumed interrupt — the gap is
  real.
- `interruptResolved` is emitted with `resolvedBy: "user"` for every resumed
  interrupt (the loop in `respondToInterruptsCore`), so the open question is
  well-posed.
- The MCP path (`serve/mcp/interruptLoop.ts` `runWithPolicy`, used at
  `mcp/adapter.ts:186`) is the post-hoc loop the non-goals describe; leaving it
  alone is the right call.
- `env` (from `std::system`) does raise `std::env` — `docs/site/stdlib/system.md`
  declares `effect std::env` and lists it under "Throws", and
  `splice/runGenerator.ts:51` records the change. Motivation confirmed.
- `adapter.perInvocation.test.ts` exists and already drives a compiled module
  through the HTTP adapter with `InvocationOptions`, so the named integration
  target is real.

## 1. The fresh-run install site does not have `resolved` in scope (wiring gap)

§2 says "Both call sites pass `resolved.policy ?? loadEnvPolicy()`", implying the
two are symmetric. They are not. The resume site
(`respondToInterruptsCore`, `interrupts.ts:787`) does have `resolved` in scope.
But the fresh-run install — `installRunPolicyHandler(execCtx)` — runs inside
`initFreshExecCtx(execCtx, { initializeGlobals })` (`node.ts:126`, called from
`runNodeCore` at `:298` and the served path at `:413`). `initFreshExecCtx`
receives only `execCtx` and an opts bag; the `ResolvedInvocation` lives one
frame up in the caller, and `RuntimeContext` carries no policy field. So on the
fresh path the policy has to be threaded down — an extra `opts.policy` on
`initFreshExecCtx` (both call sites already hold `resolved`), or stashed on
`execCtx` at `createExecutionContext(resolved)` time.

This is small, but the spec should name it, because as written it reads as a
two-line change symmetric across both sites, and an implementer will hit the
scope wall on the fresh path. Also worth stating: `initFreshExecCtx` is the
shared bootstrap for BOTH served nodes and served functions (see the comment at
`node.ts:115`), so threading it there covers `/function` as well — the data-flow
diagram in §5 only draws `/node/*`, but the mechanism does (and must) cover the
function route too. Add that route to the diagram or note it.

## 2. §3's override must land before the `interruptResolved` loop, not just before `setInterruptResponses`

§3 says apply the rewrite "before `setInterruptResponses`". But in
`respondToInterruptsCore` the `interruptResolved` lifecycle events are emitted in
a loop that reads `responses[i]` and runs BEFORE `setInterruptResponses`
(`interrupts.ts:855`). If the rewrite is applied only immediately before
`setInterruptResponses`, that loop still emits `outcome: "approved"` /
`resolvedBy: "user"` for an interrupt the policy overrode to reject —
inconsistent with the actual run outcome and with the whole point of the
`resolvedBy: "policy"` open question. The override has to be computed before the
emission loop (or the loop must read the rewritten responses). State the
ordering precisely: rewrite first, then emit lifecycle events off the rewritten
responses, then `setInterruptResponses`.

On the open question itself: emit `resolvedBy: "policy"` for overridden
interrupts. The spec's own reasoning ("seeing why a run was rejected is the
point of hosting") is right, and finding #2 shows the emission loop is already
the natural place to compute it — the cost is one enum value, and doing it
correctly is not optional once #2 is fixed.

## 3. The four-row table is really one rule

On resume every interrupt in the batch has a paired caller response, so rows
2-4 of §3's table all collapse to "keep the caller's response"; only a policy
`reject` overrides. The effective rule is one line: **if the policy explicitly
rejects, force reject; otherwise keep the caller's response.** A policy `approve`
is inert on resume — the caller already answered — which is why "only the first
row changes behaviour". Say it that way so an implementer doesn't write
redundant approve-handling. (The table is fine as an exhaustive illustration;
just add the one-line rule it reduces to.)

## Minor

- `InvalidInvocationPolicyError` is net-new (it does not exist today), and
  `resolveInvocation` currently does no validation — it is a pure sync resolver
  returning `{ runId, contextOverride }`. Adding a `validatePolicy` call and the
  throw there is reasonable and the "before any execution context exists" claim
  holds on both paths (`resolveInvocation` is called at `node.ts:290/380` and
  `interrupts.ts:787`, each before `createExecutionContext`). Just flagging it is
  new code, not a tweak to an existing validator.
- `makeRunPolicyHandler` already maps an explicit `propagate` rule to
  `{ type: "propagate" }`, consistent with §3 treating propagate/no-rule as
  "caller's response". No change needed; noting the two paths agree.
- `projectSecretsEndToEnd` lives in statelog, not this repo, so it is
  unverifiable here. The rollout line reads as if it is agency-lang CI; clarify
  it is the companion's test.

## Ask before implementation

1. Name the fresh-run threading in §2 (`initFreshExecCtx` gets the policy), and
   note it also covers `/function`.
2. Specify the §3 ordering (rewrite before the lifecycle-emission loop) and
   commit to `resolvedBy: "policy"`.
3. Add the one-line reduction of the §3 table.
