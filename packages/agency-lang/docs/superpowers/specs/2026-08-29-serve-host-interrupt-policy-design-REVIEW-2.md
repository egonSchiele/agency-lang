# Review 2: Host-supplied interrupt policy for served agents

Reviewer: Claude. Date: 2026-08-30.
Spec: `2026-08-29-serve-host-interrupt-policy-design.md` (the revision after
`-REVIEW.md`).

Verdict: the revision resolved everything round 1 raised, and the fresh-run
half (§1, §2, §4) is ready to build. The resume half (§3) has one problem the
spec does not mention, and it is a security problem, so it needs a decision
before implementation. Everything else below is small.

## What I re-verified in code

- `InvocationOptions` is `{ config?, traceId? }` and `resolveInvocation` does
  no validation (`lib/runtime/invocationOptions.ts:13,164`). Correct.
- `installRunPolicyHandler` reads the env policy privately and is called from
  `initFreshExecCtx` (`lib/runtime/node.ts:202`) and the resume core
  (`lib/runtime/interrupts.ts:805`). The fresh-path thread-through §2
  describes is real: `initFreshExecCtx` takes only `{ initializeGlobals }`
  (`node.ts:126`). Correct.
- Resume order: `buildResponseMap` at `interrupts.ts:769`, `resolveInvocation`
  at `:787`, the `interruptResolved` loop at `:829` reading `responses[i]`,
  `setInterruptResponses` at `:855`. §3's ordering paragraph is right.
- `resolvedBy` already admits `"policy"` (`lib/statelogClient.ts:1119`,
  `lib/eval/types.ts:174`). No agency-lang enum change needed.
- The interrupt site returns a cached response before consulting handlers
  (`lib/runtime/agencyInterrupt.ts:158`). §3's premise holds.

## 1. §3 evaluates the policy against data the caller wrote (security)

On `/resume`, the `interrupts` array comes from the request body. The docs
say the client sends the objects back "unchanged"
(`docs/dev/hosting/how-hosted-serving-works.md:219`), but nothing checks that.
`validateResumeBatch` (`interrupts.ts:658`) checks the shape only. The
response map is keyed on `interruptId` (`interrupts.ts:679`), and the resumed
program never re-derives `effect` or `data`: the site at
`agencyInterrupt.ts:158` returns the cached response by id without looking at
them.

So §3's `checkPolicyExplicit(policy, interrupts[i])` reads `effect` and
`data` as the caller claims them. A caller who is refused `std::env` for
`DB_PASSWORD` resends the same `interruptId` with `data.name` changed to
`"A"` (an allowed name) and `approve`. The policy sees `A`, keeps the
approve, the id matches, and the program reads `DB_PASSWORD`.

Worse, the checkpoint travels the same way: `intr.checkpoint =
ctx.checkpoints.get(checkpointId)` is attached to the surfaced interrupt
(`agencyInterrupt.ts:194`) and echoed back by the caller, and
`respondToInterruptsCore` restores whatever arrives. The spec's own §3 says
"a caller could approve their own `std::read`"; the deeper truth is that a
caller controls the whole resumed state, so the runtime cannot enforce a
policy on the resume leg against a hostile caller at all.

This does not make §3 useless, but the spec must say what it protects
against. Options, in order of preference:

1. **State the trust boundary and move the matching to the host.** Statelog
   already knows which interrupts it surfaced for a run. The honest design is:
   statelog keeps the surfaced batch (or at least `interruptId → effect,
   data`) server-side, matches its policy on the *stored* data, and rejects
   any resume whose echoed interrupts differ. Agency-lang's §3 then becomes a
   convenience for hosts that trust their callers, and the spec says so.
2. **Have the runtime verify the echo.** A cheap partial check: the
   checkpoint carries the persisted interrupt id in frame locals
   (`agencyInterrupt.ts:150`), but not `effect`/`data`. Persisting those
   next to the id, and refusing a resume whose body disagrees, closes the
   `data` hole but not the forged-checkpoint hole. Only worth it if the host
   cannot do option 1.
3. Keep §3 as written and add a paragraph under "Non-goals" saying resume
   enforcement assumes a caller who echoes faithfully, because a stateless
   resume is caller-controlled state. Least work, and at least readers of the
   security roadmap (`docs/dev/security/roadmap.md`) will not think this gap
   is closed.

Whichever is chosen, the "Why" section's promise that a host `reject`
"wins regardless of what the resuming caller says" is only true for the
fresh leg today. Reword it.

## 2. §1: the error is not loud to the caller

The spec says an invalid policy "should be loud". It is loud in the host's
log only. Both `callNode` and `resumeInterrupts` route a thrown error through
`errorResult` (`lib/serve/http/adapter.ts:132`), which logs the message and
returns the generic `TOOL_ERROR_MESSAGE` so no server detail leaks. That is
probably right for a host bug, but the spec should say "logged, generic
error to the caller" instead of implying a distinct invocation-error
response. There is no "existing setup-failure path" that reports it any
differently.

## 3. §2: the default parameter already gives the fallback

With `policy: Policy | null = loadEnvPolicy()` as the signature, a caller
passing `resolved.policy` (which is `undefined` when absent) triggers the
default. So the call sites can pass `resolved.policy` directly; the
`resolved.policy ?? loadEnvPolicy()` spelled out three times, and the
"export `loadEnvPolicy`" the plan derives from it, are not needed. One
subtlety to write down: `null` means "no policy, and do not read the env"
while `undefined` means "fall back to the env". If that distinction is not
wanted, make the parameter `Policy | undefined` and drop `null`.

## 4. §3: the rewrite need not move `buildResponseMap`

The spec asks for the rewrite to run before the emission loop, and the plan
turns that into moving `buildResponseMap` below `resolveInvocation`. It does
not have to move. `buildResponseMap` validates and builds an id-keyed map;
the rewrite can run on the *map* after `resolveInvocation`, and the emission
loop can read `responseMap[intr.interruptId].response` instead of
`responses[i]`. That keeps validation first (a malformed batch still fails
before the checkpoint lookup, as today) and removes the reorder the plan
calls "the sharp edge". Suggest the spec name this shape.

## 5. §3: the rewrite should carry the same IPC gate as the installer

`respondToInterruptsCore` runs in IPC subprocesses too (the comment at
`interrupts.ts:822`), and a subprocess inherits `AGENCY_RUN_POLICY`. The
rewrite is idempotent (reject stays reject), so a second application in the
child is harmless, but the spec's §2 says "the policy stays root-only". Say
explicitly whether the rewrite is gated by `isIpcMode()` like the installer,
or whether it is allowed to re-run because it is idempotent. Pick one; the
plan currently claims a gate that the spec does not define.

## 6. Small things

- `checkPolicyExplicit` takes `{ effect, message, data, origin }`
  (`policy.ts:38`). Confirm the surfaced `Interrupt` object carries `origin`
  so the call type-checks without a cast; if it does not, a rule that globs
  on origin would silently never match.
- §4 says a policy-rejected interrupt "never appears in the `interrupts`
  batch". True for the fresh leg. On the resume leg the interrupt was already
  surfaced once, so a host reading `interruptResolved` sees it resolved by
  policy; worth one sentence so §4 and §3 agree.
- Testing section: the integration case "agent wraps `env("B")` in
  `with handler(std::env) { approve }`" is the single test that proves the
  security claim of the whole spec. Mark it as such so it does not get cut in
  a shrink pass.
- Docs: `docs/site/guide/policies.md` is hand-written and owner-owned. List
  it under rollout as a note for the owner rather than a task for the
  implementer.
