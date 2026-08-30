# Plan: host-supplied interrupt policy for served agents

Spec: `../specs/2026-08-29-serve-host-interrupt-policy-design.md` (read first;
revised twice — §3 no longer rewrites resume responses).
Reviews: `../specs/…-REVIEW.md`, `../specs/…-REVIEW-2.md`,
`./2026-08-29-serve-host-interrupt-policy-plan-REVIEW.md`.
Companion: a host-side (statelog) PR in a separate repo; out of scope here.
Branch: a fresh branch off `main`.

## What changed after review (read this before the phases)

The original plan had a Phase 3 that re-evaluated the policy against the
caller's responses on `/resume`. That is **cut**. Two reasons, both confirmed
in code:

- The resumed program returns a response by interrupt id
  (`agencyInterrupt.ts:158`) and never re-reads the interrupt's `effect`/`data`;
  the effect runs off the *restored execution state* (`env` does
  `return _env(name)` with `name` from the frame, `stdlib/system.agency`
  `requestEnvRead`). So rewriting the echoed response/data changes nothing the
  program acts on.
- It was redundant: the policy already decides each interrupt on its **raise**
  via the root handler (§2), when the data is the real in-memory value. Nothing
  the policy would reject reaches the resume leg.

The genuine resume-leg risk — a caller tampering the serialized checkpoint arg
and replaying a host-approved interrupt id — is **checkpoint integrity**, not
response-binding. It needs checkpoint signing and/or host-side checkpoint
storage; both are separate roadmap items and out of scope. This plan delivers
the raise-time enforcement (the fresh leg) that fixes the 0.17.0 break, and
adds nothing to the resume answer path.

## What "done" means

| Scenario | Result |
|---|---|
| fresh run, `env("A")`, no handler, policy approves `name:"A"` else rejects | value returned; nothing surfaced |
| fresh run, `env("B")`, same policy | `env` returns `null`; nothing surfaced. (Not a failed run: `env()` absorbs its own denial — `stdlib/system.agency` `env()` maps a rejected read to `null`, so a refused variable reads as unset. The run only fails for effects whose callers propagate the failure.) |
| fresh run, `env("B")` wrapped in an approving handler (`handle { … } with approve`) | still `null`, not the value (root reject beats inner approve) — **the security-critical test** |
| fresh run, `env("B")` wrapped in an approving handler, policy has an explicit `propagate` rule for `std::env` | interrupt surfaces anyway (a propagate verdict beats an approve in `runHandlerChain`, `interrupts.ts:399` — the host's "always ask me", even over an auto-approving agent) |
| `/function` route, same `env` policy | governed identically (shared `initFreshExecCtx`) |
| interrupt RAISED during a resume leg, policy rejects it | the raise is rejected there and then (root handler re-installed on resume); for an `env` read that means `null`, not the value |
| invalid `policy` shape, any route | throws a plain `Error` ("invalid invocation policy: …") before any exec context; logged host-side, generic error to caller |
| no `policy`, no `AGENCY_RUN_POLICY`, any route | byte-identical to today |

The last row is the first invariant to pin.

## Facts the plan relies on (verified 2026-08-30)

- `InvocationOptions` is `{ config?, traceId? }` (`invocationOptions.ts:13`);
  `ServeHandler`'s 4th arg is `invocation?: InvocationOptions`
  (`createServeHandler.ts:16`) — no transport change.
- `resolveInvocation` (`invocationOptions.ts:164`) does NO validation today;
  returns `{ runId, contextOverride }`. Called on the fresh path
  (`node.ts` `runNodeCore`) and resume (`interrupts.ts:787`), each before
  `createExecutionContext`. The HTTP adapter turns a thrown setup error into a
  logged, generic `TOOL_ERROR_MESSAGE` (`adapter.ts:132`).
- `installRunPolicyHandler(execCtx)` (`runPolicyHandler.ts`) reads the env
  policy via a private `loadEnvPolicy()`, is IPC-gated, pushes
  `makeRunPolicyHandler(policy)` with `liveGuardIds: []`. `makeRunPolicyHandler`
  maps approve/reject/explicit-propagate and abstains (`undefined`) when
  `checkPolicyExplicit` is `null`.
- Fresh-run install runs inside `initFreshExecCtx(execCtx, { initializeGlobals })`
  (`node.ts:126`, install at `:202`, callers `:298` and `:413`) — the shared
  bootstrap for served nodes AND functions. It receives no `resolved`;
  `RuntimeContext` has no policy field.
- Resume install at `interrupts.ts:805`; `resolved` is in scope from `:787`.
- `chain precedence reject > propagate > approve` (`mergeChainOutcomes`,
  `interrupts.ts:411,419`), regardless of nesting.
- `env` from `std::system` raises `std::env` (`stdlib/system.agency`,
  `effect std::env { name: string }`; `requestEnvRead`).
- There is NO integration harness that drives a compiled module through the
  serve path. `lib/serve/http/adapter.perInvocation.test.ts` is spies only (its
  invokers are `vi.fn`; it proves the adapter passes `InvocationOptions`
  through by identity, nothing more). `createServeHandler.test.ts` uses a
  hand-written stand-in module, and `perInvocation.integration.test.ts` drives
  the real serve core with hand-built functions that cannot raise interrupts.
  The end-to-end policy tests therefore go in a new agency-js fixture
  (Phase 3), following `tests/agency-js/block-callback-tool-resume/test.js`:
  compile a real module, drive its exported `respondToInterrupts` from JS.

## Phase 0 — the no-policy pin test

With no `policy` and no `AGENCY_RUN_POLICY`, fresh and resume paths are
unchanged: `installRunPolicyHandler` a no-op, `resolvedBy:"user"` on resume.
Keep green through every phase. (Nothing in this change touches the resume
response path at all, so there is no byte-identical-responses clause to pin —
that was the cut Phase 3's concern.)

Verify: `pnpm test:run lib/runtime/interrupts.test.ts lib/runtime/invocationOptions.test.ts lib/runtime/runPolicyHandler.test.ts > /tmp/p0.txt 2>&1`.

## Phase 1 — `policy` on the invocation shape, validated

1. `invocationOptions.ts`: add `policy?: Policy` to `InvocationOptions` and
   `ResolvedInvocation` (import `Policy` from `./policy.js`).
2. In `resolveInvocation`, when `request.options?.policy` is present, run
   `validatePolicy(it)` and throw a plain
   `Error("invalid invocation policy: " + error)` on `!success`; put the
   validated policy on `ResolvedInvocation` for BOTH the fresh and resume
   branches (the resume branch returns early — add `policy` there too).
   Plain `Error`, not a class: nothing catches this by type (the adapter
   maps every throw to the same generic message, `adapter.ts:132`), the env
   channel's identical failure is a plain `Error` (`loadEnvPolicy`), and an
   error class with no consumer is machinery without a user. Tests match on
   the message prefix.

Red first: `invocationOptions.test.ts` — `policy` round-trips for fresh and
resume; an invalid shape throws with the "invalid invocation policy" prefix
and names the schema problem; absent → `undefined`. Note in the test that
the HTTP adapter surfaces this as a generic error to the caller
(`adapter.ts:132`), so "done"'s "reported as a setup error" means host-log
only.

## Phase 2 — install the supplied policy (fresh + resume), no reorder

1. `runPolicyHandler.ts`: give `installRunPolicyHandler` an optional
   explicit-policy parameter with the env fallback in the BODY (a default
   argument that reads the environment, validates, and can throw is
   imperative work hidden in a signature — anti-patterns review), and keep
   `loadEnvPolicy` PRIVATE:
   ```ts
   export function installRunPolicyHandler(
     execCtx: { pushHandler: (h: HandlerFn, liveGuardIds: string[]) => void },
     policy?: Policy,
   ): void {
     if (isIpcMode()) return;
     const effective = policy ?? loadEnvPolicy();
     if (!effective) return;
     execCtx.pushHandler(makeRunPolicyHandler(effective), []);
   }
   ```
   Call sites pass `resolved.policy` directly — no `?? loadEnvPolicy()`, no
   export, no `?? undefined` conversion. (This refines the spec §2 sketch;
   behaviour is identical.)
2. Fresh path: add `policy?: Policy` to `initFreshExecCtx`'s opts; at its
   install site pass `installRunPolicyHandler(execCtx, opts.policy)`. In the two
   callers (`:298`, `:413`) pass `policy: resolved.policy` into the opts. One
   change covers `/node/*` and `/function`. The narrow field is deliberate:
   passing the whole `ResolvedInvocation` would leak invocation-resolution
   shape into the bootstrap, which needs exactly one value.
3. Resume path: `interrupts.ts:805` becomes
   `installRunPolicyHandler(execCtx, resolved.policy)`. This governs interrupts
   RAISED during the resume leg. Do NOT touch `buildResponseMap`, the
   `interruptResolved` loop, or `setInterruptResponses` — the resume answer path
   is unchanged (no reorder; the "sharp edge" of the old plan is gone).

Red first: `runPolicyHandler.test.ts` — an explicit policy installs the
handler; the **precedence** test uses disagreeing policies (env rejects effect
X, explicit policy approves X, handler must return approve — a both-agree test
would pass even if env leaked); IPC mode still skips; `undefined` → falls back
to env; env-unset + no arg → no handler.

## Phase 3 — end-to-end tests (new agency-js fixture)

No existing serve test compiles a module (see Facts), so the end-to-end cases
go in a new `tests/agency-js/serve-policy/`, modelled on
`block-callback-tool-resume/test.js`: a real `.agency` module whose compiled
exports (`invokeServed`-style entry plus `respondToInterrupts`) are driven
from `test.js` with `InvocationOptions`. No LLM calls.

Fixture module: a node calling `env("A")`/`env("B")` bare; a node wrapping
`env("B")` in an approving `handle { … } with approve`; an exported function
doing the same (for the `initFreshExecCtx`-covers-functions case); and a node
raising two interrupts in sequence (for the resume-leg case).

Cases (note: `env()` absorbs a denial and returns `null` — a policy reject on
`std::env` never fails the run, it makes the variable read as unset):
- `env("A")`/`env("B")` fresh-run (approve returns the value; reject returns
  `null`, nothing surfaced).
- **security-critical, mark it so a shrink pass cannot fold it away**: the
  approving-handler node, policy rejects `std::env` → `null`, not the value.
  This is the only test that proves a host reject beats the agent's own
  handler.
- the approving-handler node under a policy with an explicit `propagate` rule
  for `std::env` → the interrupt surfaces (propagate beats approve,
  `runHandlerChain` checks `hasPropagation` before approvals,
  `interrupts.ts:399`).
- the exported function under the same `env` policy, proving the shared
  `initFreshExecCtx` install covers served functions.
- the two-read node: surface the first read (no matching rule), resume it
  with approve under a policy that rejects the second read's `name` → the
  second read comes back `null` instead of surfacing (the root handler
  re-installed on the resume exec context decides raises made during the
  leg). Control: with no policy, the second read surfaces as a second
  interrupt. This replaces the `interrupts.test.ts` unit variant — that file
  tests leaf functions with stubs and has no exec-context rig.

The adapter itself needs nothing new: the existing identity-pass-through
spies in `adapter.perInvocation.test.ts` already cover all the adapter does
with the options, and gain only a case asserting `policy` rides along
untouched next to `traceId`/`config`.

No hostile-caller resume test is written here, because the runtime cannot
enforce it (see "What changed"); that guarantee is the host's, against its
own stored checkpoints, and belongs to the checkpoint-integrity roadmap item.

## Phase 4 — docs

1. `docs/site/guide/policies.md` is hand-written and owner-owned — do NOT edit
   it. List the needed "Serve hosts" additions (policy via `InvocationOptions`,
   root precedence on the raise, that the resume answer path is not a policy
   seam) in the PR description for the owner.
2. Dev note: add a "Root interrupt policy" subsection to
   `docs/dev/hosting/how-hosted-serving-works.md` (the two install sites, the
   raise-time enforcement model, and the resume-integrity gap with a pointer to
   the roadmap), and a cross-reference from `docs/dev/runtime/interrupts.md`.
   While there, correct the line in `how-hosted-serving-works.md` that says the
   caller returns the interrupt objects "unchanged" — the runtime does not
   verify that.
3. `docs/dev/security/roadmap.md`: add (or point at) the checkpoint-integrity
   item — checkpoint signing (HMAC) and/or host-side checkpoint storage plus
   interrupt-id replay protection — as the real resume-leg protection this spec
   deliberately does not implement.
4. Keep the CLAUDE.md doc index in step if a new dev doc is added.

## Repo guards before any push (per standing feedback)

- `pnpm run typecheck` (all three configs, not bare tsc).
- `pnpm run fmt:ts`.
- `pnpm run lint:structure`.
- `pnpm test:run` for the touched `lib/runtime` and `lib/serve/http` files,
  output saved to a file.
- Do NOT run the full agency suite locally; CI runs it.
- Anti-pattern audit of the diff against `docs/dev/contributing/anti-patterns.md`.

## Risks and notes

- **Scope is now genuinely small.** No reorder, no new response path, no codegen
  change. The change is: a validated `policy` field, one new parameter on
  `installRunPolicyHandler`, and threading it into `initFreshExecCtx` and the
  resume install. The blast radius is the two install sites plus validation.
- **CLI path unchanged.** Every new parameter defaults to the env-policy
  behaviour; `agency run --policy` is byte-identical. The disagreeing-policy
  precedence test pins that env is used only when no explicit policy is passed.
- **The resume-integrity gap is real and named, not fixed.** Anyone reading the
  security roadmap must not take this PR as closing hostile-caller resume. The
  dev note and roadmap entry (Phase 4) are load-bearing for that reason — treat
  them as part of "done", not optional polish.
- **This plan survives "serve over run".** A separate spec
  (`../specs/2026-08-30-serve-over-run-design.md`) explores running each
  served invocation in a `std::agency.run` subprocess under an Agency
  supervisor. Even there, the host still hands a per-invocation policy across
  the TS boundary, so `InvocationOptions.policy` is the contract in both
  worlds; only the install site would move (from `initFreshExecCtx` to a
  `handle` block calling `std::policy.checkPolicy`). Do not wait for it.
- **`resolvedBy:"policy"` is optional.** Tagging the root handler's decisions
  `"policy"` (the enum already admits it, `statelogClient.ts:1119`) is a nice
  observability touch but not required; if included, it is a one-line change at
  the root handler's decision site, with a test that a policy-rejected raise
  emits `resolvedBy:"policy"`.
