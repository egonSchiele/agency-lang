# Review: plan for host-supplied interrupt policy

Reviewer: Claude. Round 2, 2026-08-30, against the revised plan (the one whose
"What changed after review" section cuts the resume response-rewrite).
Round 1 of this review is superseded: its findings 1 and 2 argued about a
resume decision point that does not exist (see CLAUDE.md, "How interrupts,
handlers, policies, and effects work" — the decision happens at the raise;
resume returns the stored answer by interrupt id). Findings 3-7 of round 1
were absorbed into the revised plan.

Verdict: the revised plan is correct on the interrupt model, and its scope is
genuinely small. Every file:line it cites checks out on main at `0c1d5ff07`
(re-verified 2026-08-30, after #975/#976 merged). One premise is wrong — the
integration harness Phase 3 builds on does not do what the plan says — and
one test is worth adding. Phases 0-2 can be executed as written.

## Facts re-verified

`InvocationOptions` (`invocationOptions.ts:13`), `resolveInvocation` with no
validation (`:164`), `ServeHandler`'s 4th arg (`createServeHandler.ts:17`),
the fresh-path resolves (`node.ts:290`, `:380`) and installs
(`initFreshExecCtx` at `node.ts:126`, install `:202`, callers `:298`/`:413`),
the resume resolve/install (`interrupts.ts:787`/`:805`), the chain precedence
comment (`interrupts.ts:411`), and `makeRunPolicyHandler`'s
approve/reject/propagate/abstain mapping (`runPolicyHandler.ts:27-36`). All
accurate.

One model-level check the revised plan gets right and round 1 never made:
the root handler is installed before `restoreState` on resume, and the
agent's own handlers re-push as the replay re-enters their `handle` blocks,
so the policy stays outermost on a resumed leg exactly as on a fresh one.

## 1. Phase 3's harness premise is false (blocking for Phase 3 only)

The plan says `lib/serve/http/adapter.perInvocation.test.ts` "drives a
compiled module through the HTTP adapter with `InvocationOptions`". It does
not. That file's invokers are `vi.fn` spies (`adapter.perInvocation.test.ts:34`,
`makeHandler`); it proves the adapter passes the options object through by
identity and nothing more. No serve test anywhere compiles an Agency module:
`createServeHandler.test.ts` uses a hand-written stand-in module (its own
comment says so, line 7), and `perInvocation.integration.test.ts` drives the
real serve core (`runExportedFunctionForServe`) with hand-built
`AgencyFunction`s whose bodies cannot raise interrupts.

(Round 1 listed this harness claim under "facts: all verified". It was never
verified. Same mistake as the resume model: a name that sounded right.)

So the Phase 3 cases — `env("A")`/`env("B")`, the handler-precedence test,
the `/function` route, the resume-leg raise — have nowhere to run as written.
Two ways to get them a home:

- **An agency-js test (recommended).** `tests/agency-js/` already has the
  exact pattern: compile a real `.agency` module and drive its exported
  `respondToInterrupts`/`hasInterrupts` from JS
  (`tests/agency-js/block-callback-tool-resume/test.js`). A new
  `tests/agency-js/serve-policy/` fixture with an `env`-calling node and a
  handler-wrapped variant covers every case, including the resume-leg raise
  (two sequential interrupts: resume the first with approve under a policy
  that rejects the second; the run must fail). No LLM calls needed. The
  serve adapter itself stays covered by the existing identity-pass-through
  spies, which is all the adapter does with the options.
- **Teach the integration test to raise.** Extending
  `perInvocation.integration.test.ts`'s hand-built functions to call the
  runtime's interrupt entry point is possible but reimplements what the
  compiler emits; the agency-js route tests the real generated code instead.

Phase 3 should be rewritten around the agency-js fixture, and the "Facts"
bullet corrected.

## 2. Add the propagate-beats-approve case

Verified in `runHandlerChain` (`interrupts.ts:371-399`): `hasPropagation` is
checked before approvals, so one `propagate` verdict surfaces the interrupt
even when another handler approved. `makeRunPolicyHandler` returns
`{ type: "propagate" }` for an explicit propagate rule. Together that means a
host policy can force "always ask me" for an effect *over the agent's own
auto-approving handler* — for a host, arguably as valuable as the reject
veto, and one line of policy JSON. Neither the spec's tests nor the plan's
cover it. Add one case beside the security-critical reject-beats-approve
test: agent wraps `env("B")` in an approving handler, policy says
`propagate` for `std::env` → the interrupt surfaces.

## 3. Small notes

- Phase 0's "resume responses untouched, byte-identical" pin is now almost
  vacuous — with the rewrite cut, no code in this change touches responses.
  Keep the pin for `installRunPolicyHandler` being a no-op and
  `resolvedBy:"user"`, but don't let the byte-identical clause suggest the
  change goes anywhere near the response path.
- The "interrupt RAISED during a resume leg" unit test the plan puts in
  `interrupts.test.ts`: that file today tests leaf functions with stubs
  (`stubCtx` at `:483`); a real raise-during-resume needs a compiled program
  and belongs in the agency-js fixture from finding 1. Drop the unit
  variant rather than building an exec-context rig for it.
- The optional `resolvedBy:"policy"` note is correctly scoped: on the fresh
  leg a policy decision flows through the ordinary handler events, so the
  tag is a decision-site change in `makeRunPolicyHandler`'s caller path, not
  a resume change. Fine to defer.
