# Review: runAgent + runTypes Cleanup Implementation Plan

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-30-eval-runagent.md`
against the spec `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-30-eval-cleanups-design.md`
and the code on `main` at `7ac301701` (PR #733 merged).

## Verdict

The plan is well built. The task ordering is genuinely reviewable — two cleanup
commits, one pure-move commit, one build-beside-the-old commit, one rewire
commit — and each one compiles and passes on its own, which is the property
that makes a refactor like this survivable. The rename table in Task 4 Step 2
is the right level of detail: an implementer can follow it without re-deriving
anything. The self-review section is honest about what it defers.

Three things need to be fixed before this is executed, and I have listed them
first because two of them are silent behavior changes that the plan believes it
does not have, and the third is a whole file the plan never mentions.

Then there are two questions about altitude — about whether the new code is
being put in the right place, and whether one atom is really one atom — that I
think are worth settling before Task 3, because they change where files land.

---

## Must fix

### 1. Two behavior changes the plan does not know about

The plan states one deliberate delta (failed runs now attempt extraction). I
found two more, both in the `runAgent` recipe in Task 4 Step 4.

**A run that produces an empty statelog flips from success to error.**

Today, `lib/eval/runEvalInput.ts:105-121`: if `shouldExtractStatelog` is false —
the statelog file is missing or zero bytes (`lib/eval/runArtifacts.ts:197-205`) —
extraction is skipped and the function still returns `recordInputSuccess(prepared)`.
The input counts as a success; the eval record simply is not there, and
`readEvalRun` later reports that input as `"missing"` rather than `"failed"`.

The planned recipe does the opposite:

```ts
  if (record === undefined) {
    return fail("agent produced no statelog to extract");
  }
```

Under the plan, an agent that exits cleanly having emitted nothing becomes an
error result. That changes `okCount`/`errorCount` in `summary.json`, the CLI
exit code, and whether the run appears in grading — for a case that is not
obviously a failure (an agent that runs a node with no eval outputs, or a run
with observability off).

This may well be the behavior you *want*. But Task 5 is sold on "if an
assertion in `run.test.ts` fails, the rewiring is wrong", and this change
would make that test the wrong oracle. Decide it explicitly, write it into the
deliberate-deltas list, and pin it with a test either way.

**An extractor crash gets reported as a missing statelog.**

Today the extractor is called inside a `try` and a failure becomes an error
result carrying the extractor's own message (`lib/eval/runEvalInput.ts:113-119`).
The plan describes `tryExtract` as "logs-and-returns-undefined on failure",
which then falls into the same `record === undefined` branch above and reports
`"agent produced no statelog to extract"` — which is false, and points the
reader away from the actual bug. `runEvalInput`'s own doc comment says
extractor failures "indicate a bug in the extractor rather than an input
failure", so losing the message is a real regression in diagnosability.

`tryExtract` needs to distinguish "there was nothing to extract" from "the
extract blew up", and the error arm needs to carry the second one's message.

### 2. The Agency-side mirror of these types is never touched

`Input` and `EvalRunResult` exist twice: once in TypeScript, once in Agency.
`stdlib/agency/eval.agency:63-70` declares

```agency
export type Input = {
  id?: string;
  goal?: string;
  args: Record<string, any>;
  node?: string;
  working_dir?: string;
  metadata?: Record<string, any>
}
```

and `stdlib/agency/eval.agency:81-85` declares `EvalRunResult` with an `agent:
string` field. Task 1 deletes `working_dir` from the TypeScript `Input` and
Task 2 renames `agent` → `agentLabel` on the TypeScript result, but neither task
lists `stdlib/agency/eval.agency`. After the plan as written, the Agency type
still advertises a field that no longer exists and still calls the label
`agent`, and `docs/site/stdlib/agency/eval.md:66` (generated) still documents
`working_dir?: string` to users.

Three consequences for the plan's mechanics:

- The global constraint "TypeScript-only changes need at most `pnpm run build`,
  never another `make`" stops holding — an `.agency` stdlib change needs `make`,
  and the docstring/type change needs `make doc` to regenerate
  `docs/site/stdlib/agency/eval.md`.
- Every commit stages with `git add -A packages/agency-lang/lib`. That path
  excludes `packages/agency-lang/stdlib/` and `packages/agency-lang/docs/`, so
  the stdlib edit would be silently left out of the commit. Widen it to
  `packages/agency-lang` (Task 6 already does) or add the paths explicitly.
- Adjacent bug worth folding in while you are in that file: the Agency `Input`
  never gained the `files` field that #733 added on the TypeScript side, so
  Agency callers of `evalRun` cannot express test fixtures at all.

### 3. `lib/utils/projectTree.test.ts` is not in the deletion list

Task 1 deletes `lib/utils/projectTree.ts` but the file has a test —
`lib/utils/projectTree.test.ts:5` imports `copyProjectTree` and
`PROJECT_COPY_EXCLUDES`. Deleting only the implementation leaves a test file
that fails to resolve its import. `git rm` both.

Two smaller members of the same family:

- `lib/eval/runArtifacts.test.ts:100-104` carries a `working_dir` explanation
  comment that Task 1's "drop the stale comment" bullet covers only for
  `runArtifacts.ts`, not the test.
- `docs/site/cli/eval.md` mentions `working_dir` in **three** places, not two:
  the deprecation sentence at line 37, the prose at line 94, and — the one the
  plan misses — the example input JSON at line 33, which still shows
  `"working_dir": "./fixtures/empty-project"` as a live field.

---

## Altitude: two questions worth settling before Task 3

### Does `run/` belong under `lib/cli/`?

The spec puts the four new files at `lib/cli/eval/run/`, and the plan follows.
But the pieces they are being carved out of live in `lib/eval/` — `runArtifacts.ts`,
`runEvalInput.ts`, `workspace.ts`, `loadInputs.ts`, `grading/` — and `runAgent`
is a library primitive, not a command. The spec itself says Level 2 and Level 3
compose over it, and Level 3 is `lib/optimize/`.

Concretely, the plan produces imports in both directions across that boundary:

- Task 3 Step 2: `lib/eval/runArtifacts.ts` imports `agentRunPaths` from
  `lib/cli/eval/run/extract.ts`.
- Task 4 Interfaces: `lib/cli/eval/run/runAgent.ts` imports `shouldExtractStatelog`
  from `lib/eval/runArtifacts.js`.

That is a two-way dependency between one file and one directory. ESM tolerates
it until it doesn't (module-init order), and more to the point it makes "which
layer owns the run directory layout" unanswerable — the layout function lives
under `cli/`, the thing that creates the directories lives under `eval/`.

I want to be fair about precedent: `lib/eval/` already imports upward today
(`lib/eval/workspace.ts:5` imports `compile` from `@/cli/commands.js`;
`lib/eval/judge/pairwise.ts:3` imports from `@/cli/runAgencyAgent.js`), so this
is not a rule the codebase currently enforces. But the layering rule #727 *did*
establish — the eval layer must not reach into optimize, which is why `closure.ts`
and `hash.ts` were moved to shared homes in #733 — is the same instinct, and it
points at `lib/eval/run/` rather than `lib/cli/eval/run/`.

My recommendation: put the four files in `lib/eval/run/`, leave `lib/cli/eval/run.ts`
as the thin command that parses flags and calls them, and let `agentRunPaths`
sit beside `runArtifacts.ts` where the directory is actually created. If you keep
the spec's location, at least move `agentRunPaths` into `runArtifacts.ts` so the
`lib/eval → lib/cli` edge disappears.

### The stdlib re-implements the very pipeline `runAgent` is meant to be

`runEvalInput`'s doc comment claims it is the "single source of truth for run
one eval input" and that "both the CLI and the stdlib route through this
function". That is no longer true: `lib/stdlib/agencyEval.ts:76-119` has its
own `_prepareInput`/`_finalizeInput` pair that creates the workdir itself,
calls `shouldExtractStatelog`, parses the statelog with `StatelogParser`,
writes `eval-record.json`, and routes errors — a third copy of the extract
step, beside `run/extract.ts` and `runAgent`'s `tryExtract`.

The plan says the stdlib "only sees the two renames", which is a defensible
scope call for this pass. But then the PR should not claim that running an
agent is now one building block, because for the stdlib path it is not, and the
stale "both the CLI and the stdlib route through this" comment should die with
`runEvalInput.ts` rather than being carried into `runAgent`'s header. Either
fold `_finalizeInput` onto `run/extract.ts` in Task 5 (it is a small change —
the extraction half is four lines), or add one sentence to the plan's Out of
Scope naming this as the second run path that Level 2 must absorb.

---

## Gaps and inconsistencies

**`opts.extractor` does not exist.** Task 5 Step 1 writes
`extractor: overrides.extractor ? undefined : opts.extractor` and Step 2 says to
"route it through `opts.extractor` now". There is no `extractor` field on
`EvalRunLoadedInputsOptions` today — the extractor arrives only through the
second parameter (`lib/cli/eval/run.ts:246`, defaulted at `:286`), and the
optimizer passes it there (`lib/optimize/baseOptimizer.ts:285`). Adding
`extractor` to the options type is a real interface change and belongs in Task
5's **Produces** list, which currently mentions only the `precomputedSeed`
rename. Also, the expression as written discards the caller's extractor when
the test seam is set, which is backwards; `overrides.extractor ?? opts.extractor
?? defaultEvalRecordExtractor` is what you mean. The plan's own parenthetical
("pass it as one expression rather than the two-step shown above if simpler")
should just become the instruction.

**`precomputedSeed`'s name and its doc contradict the loop that uses it.** The
option's comment says "the optimizer's discovery-time closure … Everyone else
omits this and the closure is computed." But Task 5 Step 1's loop passes
`precomputedSeed: seed` on **every** call, including plain eval, because
`defaultSeed` is computed once per suite to avoid N closure walks (which now
include an esbuild pass per interop entry — not cheap). So the suite path is
also a "precomputed seed" caller, and the doc is wrong the moment it is written.
Either name it for what it is (`seed?: AgentSeed`, "computed from the agent when
omitted; supply it to reuse one walk across inputs or to pin to a discovery-time
file view") or have the loop omit it and accept the re-walks.

**`runDir` means two different directories.** `RunAgentOptions.runDir` and
`AgentRun.runDir` are the *per-input* directory (`runs/<runId>/inputs/<inputId>/`),
because `agentRunPaths(runDir)` puts `agent/` and `workdir/` directly under it
and Task 5 passes `prepared.inputDir`. Everywhere else in this code `runDir` is
`runs/<runId>/` — `EvalRunState.runDir`, `EvalRunResult.runDir`,
`readEvalRun(runDir)`, `evalGrade(runDir)`. Two meanings for one word in files
that import each other is exactly the confusion this plan exists to remove.
`inputDir`, or `agentRunDir`, would cost nothing.

**Recomputing paths that were just handed over.** `toInputResult` calls
`agentRunPaths(run.runDir)` to rebuild `evalRecordPath`/`statelogPath`, which
`prepared` already holds and `runAgent` already computed. Harmless, but if
`agentRunPaths` is the single layout authority then passing the paths out on
`AgentRun` (or reading them off `prepared`) is one fewer place to keep in sync.

**Default drift on `pipeOutput`.** `runAgent` defaults it to `false`; the suite
loop passes `opts.pipeAgentOutput ?? true`. Same knob, opposite defaults, one
layer apart. Pick one and let the other be explicit.

**The conditional-spread waffle.** Task 5 Step 1's parenthetical says to use
`...(cond ? {x} : {})` and then "if `lint:structure` flags the spread shape,
assign on a mutable local instead … keep the catalog happy either way". The
plan's own Global Constraints list conditional spreads as an anti-pattern to
actively avoid. Just write the version that is allowed. (Simplest: make
`errorMessage?: string` and set it unconditionally from `run.status === "error"
? run.errorMessage : undefined`.)

**Unused binding in a plan-provided test.** Task 4 Step 3's third test destructures
`{ agentPath, baseDir }` and never uses `baseDir`.

**Task 5's "proof of zero behavior change" is not quite available.** The step
says `run.test.ts` assertions stay unchanged and that is the proof. But that
file must change anyway: it imports `EvalInputRunner`/`EvalRecordExtractor`
from `@/eval/runEvalInput.js` (`lib/cli/eval/run.test.ts:10`, deleted in Task 5)
and it passes `inputsSource: "test"` (removed in Task 2). The claim is still
morally right — no *assertion* changes — but say that precisely, because an
implementer reading it literally will think the file is untouched.

---

## Coverage check against the spec

Changes 1, 2, 3, 4, 5, 7, 8 all land somewhere concrete, and Change 6 is
deferred by name with a reason. Two spec bullets are silently dropped:

- Change 1 lists `docs/site/cli/optimize.md` as a place `working_dir` might be
  mentioned. I checked: it is not there, so nothing to do — but the plan should
  say so rather than omit the bullet, otherwise the next reader re-checks it.
- The spec's Testing section says Change 1 "additionally wants one new test: an
  input spec containing `working_dir` produces the explicit 'use files' error
  (if that recommendation is adopted)". The owner's later decision (no errors,
  no shims) supersedes it, and the plan is right to drop the test — but the
  self-review should name the drop, since it reads as coverage otherwise.

## What is genuinely good here

Worth saying, because it should survive the revisions:

- Task 3 being a *pure move* with "everything passes untouched" as the pass
  condition is the right way to make a refactor of this size reviewable.
- The deliberate overlap window between Tasks 4 and 5 — old and new seeding
  alive at once — is called out as deliberate with a reason, instead of being
  discovered by a confused reviewer.
- `agentRunPaths` as the one written-down copy of the run-directory layout is
  the single best idea in the plan; `runArtifacts.ts` currently restates that
  layout inline, and #733 added a second restatement in `readRun.ts`'s
  `firstExisting` fallbacks. Consider pointing `readRun.ts` at it too.
- `lastOutput(record)` matching `gradeRun`'s definition is correct — verified at
  `lib/eval/grading/gradeRun.ts:213-218`, which also takes the last of
  `evalOutputs`. Good instinct to check that rather than invent a second rule.
