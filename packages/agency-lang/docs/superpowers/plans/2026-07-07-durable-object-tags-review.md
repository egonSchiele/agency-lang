# Review: Durable Object Tags Implementation Plan (2026-07-07)

**Plan:** `2026-07-07-durable-object-tags.md`
**Spec:** `docs/superpowers/specs/2026-07-07-durable-object-tags-design.md`
**Spec review:** `docs/superpowers/specs/2026-07-07-durable-object-tags-design-review.md`
**Verdict:** Approve with revisions — Finding A will make Task 4's fixture fail
as written and must be fixed before execution; Findings B and C are one-line
hardenings to the flag machinery; Finding D needs a documenting sentence.

All harness/helper/syntax claims below were verified against the worktree code,
not just read off the plan.

## What checks out (verified against code)

- **Spec-review findings are all folded in correctly.** Finding 1 → Task 4
  (join OR-in), Finding 2 → Task 3 (`removeAllTags` clears keys, never
  `delete`s), Finding 3 → Task 1 (`attachTag` forces null prototype, exercised
  by Task 2's revive test), split-flag suggestion → the two-flag Global
  Constraint + Task 3, `tagsRecordFor` naming → Task 3 edits the unified helper
  rather than forking per-method.
- **The read-existing-first dispatch is better than the spec.** Locating an
  existing record before choosing a storage path makes `setTag` *and*
  `removeAllTags` on a tagged-then-frozen object correct (the spec only handled
  serialize/read after freeze). Task 3's freeze-after-tag test pins it.
- **`runBatch` insertion point is right.** `shareGlobals`, `parent`, and
  `branchGlobals` are all in scope in the settle closure
  (`lib/runtime/runBatch.ts:336-388`), and both value and interrupt settles
  return through that line.
- **Harness names are real.** `makeCtx`/`makeParent` exist in
  `lib/runtime/runBatch.test.ts:40,69`. Task 5's `makeStdoutCtx`/`printed`/
  `runInTestContext`/`post({event, args})` all match
  `lib/statelogClient.redaction.test.ts` exactly (the new test is a minimal
  variation of the existing creds/hunter2 test at `:51-59` — good mirroring).
- **Agency syntax is right.** `fork(["only"]) as item { ... }` and the
  `std::tag` imports match the existing `tests/agency/tag.agency`
  (`forkInheritsPrimitiveTag` at `:50` is the exact template being mirrored).
  Task 6 uses `pnpm run a test` per repo convention.

## Finding A (must fix): Task 4's agency-js fixture is missing `agency.json` — it will fail for the wrong reason

The fixture's `test.js` reads `./statelog.log`, but a statelog file only exists
when the fixture directory has an `agency.json` enabling file logging. Every
sibling that reads `statelog.log` has one (verified:
`tests/agency-js/llm-call-single-span/agency.json`,
`tests/agency-js/fork-branch-value/agency.json`):

```json
{
  "observability": true,
  "log": {
    "logFile": "statelog.log"
  }
}
```

Without it, the log file is missing/empty, the `!log.includes("[REDACTED]")`
check throws, and the failure looks like the redaction bug rather than a
missing config — inviting the executor to "fix" the test by weakening
assertions. **Fix:** add `tests/agency-js/tag-fork-redaction/agency.json` (the
content above) to Task 4's file list, Step 5, and the Step 7 `git add`.

Related: Step 6's literal invocation is `node tests/agency-js/.../test.js`, but
the repo runner for these fixtures is `pnpm run agency test js <file>` (per
CLAUDE.md), which handles compiling `agent.agency` → `agent.js`. The hedge
("mirror the sibling invocation") points the right way, but the literal command
shown is the one an executor will paste. Make the runner command the primary
instruction.

## Finding B: the durable flag is not set when a store adopts an already-tagged object

Task 3's dispatch sets `DURABLE_FLAG_KEY` only on the **create-new-record**
path. When `readTag(value)` finds an existing durable record (an object tagged
elsewhere, arriving by reference), the store mutates the record but never sets
its own flag. Today the known by-reference flow (branch → parent) is covered
because Task 4's join OR-in runs before the parent can touch the object — but
that makes the gate's correctness depend on propagation *ordering* instead of
being locally true in the store.

**Fix (one line):** in `tagsRecordFor`, when `create === true` and the value
resolves to a durable record (existing or new), set the flag. It's monotonic
and idempotent, so the extra write is free, and the gate becomes correct
independently of who tagged the object first.

## Finding C: join propagation is skipped when the branch throws

Task 4 places the OR-in after `const value = await fn()`, so a branch that
**throws** never propagates its flag. A thrown error can carry a reference to a
branch-tagged object and be caught and logged by the parent — same leak shape
as Finding 1 of the spec review. The neighboring snapshot block deliberately
skips throws, but that logic is about *resume state* (error branches are torn
down, not resumed); the monotonic flag has no such reason to skip.

**Fix:** wrap the body in `try { ... } finally { if (!shareGlobals &&
branchGlobals.hasDurableObjectTagFlag()) parent.globals.setDurableObjectTagFlag(); }`
so value, interrupt, and throw settles all propagate. (With Finding B's
hardening this becomes belt-and-braces, but it's one keyword.)

## Finding D (document it): durable `removeAllTags` leaves `getTagsFor` returning `{}`, not `undefined`

On the WeakMap and primitive paths, `removeAllTags` deletes the entry, so
`getTagsFor` returns `undefined`. On the durable path it clears keys in place
(necessarily — the frozen-after-tag case), so `getTagsFor` returns `{}` and the
`TaggedReviver` keeps wrapping the object (an empty `Tagged` marker in every
subsequent checkpoint). Task 3's test pins `toEqual({})` without saying why the
paths diverge. Behavior is harmless (`isRedacted` reads `=== true`; agency-level
`getTags(x)["k"]` is falsy either way), but the asymmetry should be stated in
the plan/test comment so a future cleanup doesn't "unify" it back to a
throwing `delete`.

## Smaller notes

- **Commit trailer:** the Global Constraints hardcode
  `Co-Authored-By: Claude Opus 4.8 (1M context)`. The trailer should be the
  executing model's, not pinned to a specific one in the plan.
- **Guide wording:** the Task 6 doc text says tags "now survive" — "now" ages
  poorly in reference docs. Phrase it timelessly ("Tags on plain objects and
  arrays survive …").
- **Final verification step:** the plan has no closing task that runs the full
  unit suite and the structural linter. Add a last step before the PR: full
  `pnpm test:run` (save output to a file per repo convention) +
  `pnpm run lint:structure`. Per repo rules, do *not* run the full agency
  execution suite locally — CI covers it.
- **Task 4 Step 1 mechanism test is pseudocode** — acknowledged inline with the
  concrete assertion and an e2e fallback. Acceptable, provided Finding A is
  fixed so the e2e guard actually functions.
