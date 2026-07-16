# Plan review: resumable guards, rev 8 (2026-07-16)

**Reviewing:** `docs/superpowers/plans/2026-07-16-resumable-guards.md` (rev 8)
**Supersedes:** the rev-7 review.
**Verdict: execute.** Both rev-7 fixes are in and correct. I re-walked the
dedupe with the new shape and it holds. Two nits below — neither blocks, both
are one line, and the executor can fold them while writing the code.

---

## Verified

- **The loop is at both raising sites**, with the reason attached ("approving the
  inner guard's trip can leave — or push — the OUTER guard over its own limit,
  and decision 16 promises that guard its own question"). Decision 16 now has a
  *where*, which was the whole point.
- **The parked branch returns and lets the caller re-detect.** This is better
  than the `!== tripped` check it replaces: it covers both "the answer refilled
  this guard" and "a different guard is over budget now" with one mechanism
  instead of two, and it does not have to know which case it is in.
- **Nothing sits between the set and the `try`.** The record's lifetime and the
  `finally` are now the same region. The comment says why, in the place where
  someone would otherwise "clean up" by hoisting `guardTripKey` back out.
- **The `if`-then-`while` reads redundant but is not.** The `if` decides whether
  we parked (and therefore whether to return); the `while` handles a third branch
  claiming the record between our wake and our re-check. Both are needed. Worth
  leaving as-is.
- **`unsuspendAll()` is genuinely a safe no-op** when `suspendAll` never ran —
  `unsuspend()` only clears a flag, and the clock restart is the next
  `beforeStep`'s job.
- **The time-guards-inert clause is in**, so nobody "fixes" the missing time
  dedupe later.

## Two nits

**1. `dimensionOf(g)` should be a property, not a call-site branch.** The new
loop calls `dimensionOf(g)`, and there is no way to write it today except an
`instanceof` or a `g.toJSON().kind` round-trip — both of which are the thing
`guard.ts:20-59` explicitly forbids ("StateStack and Runner only ever talk to the
interface — no `instanceof` checks, no variant-specific branching"), and the
thing decision 5 went out of its way to honor for suspension. Add
`readonly dimension: "cost" | "time"` to the `Guard` interface (`GuardJSON`
already carries the same discriminator as `kind`), and the loop reads
`raiseGuardTrip(stack, g, g.dimension)`.

**2. The signature comment is now half-true.** `// returns = approved; throws =
rejected` was accurate when every return meant an approval. The parked branch now
also returns, having approved nothing. Operationally both mean the same thing —
"this question is settled, re-detect" — but only because the caller loops, and a
future caller reading that comment would reasonably call `raiseGuardTrip` once
and treat the return as consent. Say what it now means:
`// returns = this question is settled (approved, or someone else's answer landed) — the caller MUST re-detect; throws = rejected`.

## What is right

Eight revisions in, the thing worth saying is that the document now explains
itself. The loop carries its own justification, the `finally` names all four
exits, the key comment walks all five cases, and the memo cites `runner.ts:772`.
Every one of those is a place where a future reader would otherwise have
"simplified" something load-bearing. That is the difference between a plan that
survives execution and one that gets quietly undone by the first person to tidy
it.

## Next

Execute PR 1. Fold the two nits while writing the code.
