# Review: Eval grading goes disk-first

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-30-eval-grading-disk-first.md`
against the working tree on branch `adit/eval-refactor` (`98ac70db6`).

## Verdict

This is a good plan and a good decision. Collapsing `gradeRun` from a
three-shape union to "give me a run directory" removes the only reason the
in-memory path existed, and the plan is right that the load-bearing read was
already disk-first — `lookUpOutput` reads `eval-record.json` off disk on every
branch today (`lib/eval/grading/gradeRun.ts:201-225`). So this is deleting
bookkeeping, not changing where evidence comes from, and the plan says so
plainly instead of overselling it.

I checked the four claims the plan rests on. Three hold exactly as stated; one
has a hole. Details below, then the smaller things.

**Verified:**

- Task 1's grep claim is right. The only consumer of an `AgentRun` outside
  `runAgent.ts` is `toInputResult` (`lib/cli/eval/run.ts:303-311`), and it reads
  only `status` and `errorMessage`. Dropping `record` breaks nothing else.
- Task 3 Step 2's ordering claim is right. `writeEvalRunSummary` writes
  `summary.json` to disk before returning (`lib/eval/runArtifacts.ts:204`), and
  it is called at `lib/cli/eval/run.ts:279`, five lines before the `gradeRun`
  call. Re-reading is safe.
- Task 4's policy claim is right, and its new test is a real tripwire rather
  than a tautology. `inputStatus` returns `"failed"` whenever the summary says
  the input errored, *regardless of whether a record exists*
  (`lib/eval/readRun.ts:53-56`), so an errored run with a salvaged
  `eval-record.json` is diverted from graders by construction. Good — I went
  looking for this to break and it doesn't.
- Task 2 correctly writes no documentation. The graders docs describe the
  destructured argument `{ output, input, workdir, record, judge }`
  (`docs/site/cli/eval.md:161`), never the type name, so the rename is invisible
  to users.

---

## Must fix

### Deleting `readInputSpec` deletes a tolerance the loader does not have

This is the one real hole. `readInputSpec` reads `input.json` inside a `try`
and, on a parse failure, warns and degrades to a bare input
(`lib/eval/grading/gradeRun.ts:179-186`):

> Degrade to a bare input rather than failing the pass; the caller falls back
> to `{ id, args: {} }`, which costs graders their goal/expected but no more.

The loader it is being replaced by has no such guard. `readOptionalJson` checks
only for existence and then parses unprotected (`lib/eval/readRun.ts:68-71`), so
a corrupt `input.json` will **throw out of `readEvalRun`** and take the entire
grading pass down.

That matters most on the path this plan is switching over. On the inline
`eval run --grade` path, the throw arrives after every agent in the suite has
already run and been paid for — which is precisely the failure mode
`lookUpOutput`'s own doc block says must never happen
(`lib/eval/grading/gradeRun.ts:192-200`: "in the `eval run` inline path the
exception would arrive after every agent had already run and been paid for,
taking the whole result down over one bad file").

Deleting `readInputSpec` is right. The tolerance it encoded has to move into
`readEvalRun`, not evaporate. Add a step to Task 3: `readOptionalJson` warns and
returns `undefined` on a parse error, matching the reason `readInputSpec` gave.
While there, the same question applies one line up — `readJson` on `summary.json`
(`lib/eval/readRun.ts:22`) is also unprotected, and a corrupt summary is now the
single point of failure for all grading. At minimum it deserves an error message
naming the file.

---

## Worth fixing

### Task 2's file list misses the other public surface

`AgentRun` is exported from **two** public entry points, not one. The plan lists
`lib/optimize/public.ts:24` but not `lib/eval/public.ts:14`, which is the new
home for the grader-authoring API (the comment at the top of
`lib/optimize/public.ts` says as much: "Grading lives in the eval layer now").
Miss it and `agency-lang/eval` still exports the old name.

Note also that `lib/eval/public.test.ts` guards only runtime *value* exports
(its `GRADING_NAMES` list), so nothing catches a type export that silently
disappears. If the grader-authoring types are part of the contract, they belong
in that guard; if they are not, the plan should say the type export is
incidental. Either answer is fine — the current state is that nobody knows.

Cosmetic straggler in the same sweep: `lib/optimize/reflectionFeedback.test.ts:8`
has a comment referring to "the AgentRun".

### Task 1 leaves an unlogged catch and a discarded parse

Today the salvage call is:

```ts
const record = await this.extractRecord(undefined).catch(() => undefined);
```

(`lib/eval/run/runAgent.ts:96`). Once `record` leaves the type, this line exists
only for the disk write — but `extractRecord` still ends with
`JSON.parse(readFileSync(evalRecordPath))` whose result is now thrown away
(`:157-160`), and `.catch(() => undefined)` swallows an extractor crash with no
log at all.

The plan's instruction ("STILL calls `extractRecord` first … add the one-line
comment saying the call is for the on-disk salvage") keeps a line whose shape
argues against its own purpose, and the swallowed catch is on the anti-pattern
list the plan's own Task 5 Step 3 audits against. Better: split a small
`salvageRecord()` that runs the extractor for its side effect and `console.warn`s
on failure. Then the comment is unnecessary because the name says it.

### The input set quietly changes from a list to a map

`gradeRun` today maps over `summary.inputs`, a list. After Task 3 it maps over
`Object.values(readEvalRun(runDir).inputsById)`, a record keyed by `inputId`
(`lib/eval/readRun.ts:41`). Two results sharing an id collapse into one, which
changes the denominator of `objective` (a mean).

Being fair about reachability: the CLI cannot hit this, because `loadInputs`
rejects both duplicate and empty ids (`lib/eval/loadInputs.ts:184-198`). But
`evalRunLoadedInputs` is a programmatic surface as well, its inputs do not go
through `validateInputs`, and every prepare failure reports `inputId: ""`
(`lib/cli/eval/run.ts:262`) — so two id-less inputs in a programmatic call would
merge. Cheap resolutions: state the invariant in `gradeRun`'s doc, or have
`readEvalRun` warn when a key repeats. Not a blocker; just do not let it be
discovered later as a mystery in a score.

### Say which tests convert and which die

Task 3 Step 3 says the in-memory tests "need converting". Two of them are
`gradeRun.test.ts:196` and `:209-210`. The second is a *branch-agreement* test —
it grades the same run through a path and through memory and compares. After
this change there is no second branch to agree with, so it should be deleted,
not converted. Naming that in the step avoids an implementer contorting a test
into something that no longer tests anything.

---

## Altitude

**The `Entry` shape is still impersonating an `EvalRunInputResult`.** With one
entry path, `loadedEntry` synthesizes a full `EvalRunInputResult` in which
`statelogPath` is always `""` and `status` is a re-derivation of a status the
loader already computed (`lib/eval/grading/gradeRun.ts:132-150`). What grading
actually needs from an entry is: the input spec, a record path, a workdir, and
optionally a reason not to grade.

The reason it cannot be that today is real and worth writing down rather than
silently living with: `gradeInput` must keep taking an `EvalRunInputResult`
because the optimizer calls it per input (`lib/optimize/baseOptimizer.ts:246`).
So the near-duplicate shape is forced by a seam the plan explicitly defers
("pointing `baseOptimizer` at the new surface" is in Out of Scope). Fine — but
add one sentence to Task 3 saying that `Entry`'s shape is inherited from the
optimizer's seam and collapses when that seam moves. Otherwise the next reader
sees a synthesized struct with two dead fields and assumes it is an oversight.

**Write the invariant down somewhere durable.** The whole point of this
iteration is a contract: *the run directory is the interface between running and
grading; grading never receives run data in memory*. Task 5 Step 4 only appends
an executed-iteration note to the living spec, which is a working document. One
short paragraph in the eval dev docs would keep someone from "optimizing away"
the re-read in six months — and the re-read looks exactly like the kind of thing
a future reader deletes as obviously wasteful. The plan already has the right
sentence for it in Task 3 Step 2 ("grading deliberately re-reads the artifacts
this process just wrote"); it just needs to live somewhere other than a code
comment.

**Judge divergence.** After this, `gradeRun` takes a directory while `judgeSuite`
still takes the union via `coerceRun` (`lib/eval/judge/suite.ts`). The plan logs
this as deliberate and out of scope, which I agree with. Please put that
divergence in `gradeRun`'s doc comment as well, so the next person does not
"restore consistency" in the wrong direction.

---

## Process nits

- **No commits between tasks.** The plan works directly in the main checkout on
  `adit/eval-refactor` with the owner reviewing the tree. Tasks 1–5 delete
  `toEntries` and `readInputSpec` and rewrite several test fixtures; with no
  checkpoints there is no way to tell which task broke a test that only shows up
  in Task 5's sweep. WIP commits per task (squashed later) cost nothing and the
  previous plan in this series had exactly that property.
- **Scratchpad path.** Task 1 Step 3 says "use the session scratchpad dir" and
  then writes `/tmp/scratchpad-t1.log`. Pick one; `/tmp` is the one the
  environment asks you to avoid.
- Task 5 Step 1's grep expects `ReadEvalRunResult` to survive in `readRun.ts`
  and `judge/suite.ts` — correct, verified.
