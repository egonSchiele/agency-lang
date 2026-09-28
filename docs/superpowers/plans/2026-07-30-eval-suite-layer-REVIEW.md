# Review: Iteration A — the suite layer

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-30-eval-suite-layer.md`
against the working tree on branch `adit/eval-refactor`.

## Verdict

This is the right iteration and most of it is precisely specified. The two
structural wins are real: moving the suite loop out of a command file removes
the last reason `lib/optimize` reaches up into `lib/cli`, and pointing the
optimizer at `gradeRun(runDir)` is what finally lets the fake
`EvalRunInputResult` in `loadedEntry` die — the comment in
`lib/eval/grading/gradeRun.ts:126-131` literally says it collapses when that
seam moves, and this is that move.

I checked every "verified by grep" claim in the plan. They all hold; I have
listed them at the end so they don't have to be re-checked. Three things are
missing, and there are three questions about where things are landing.

---

## Missing

### 1. Task 4 changes a documented seam and updates no documentation

`docs/dev/writing-optimizers.md:245` documents the `runInput` seam:

> `runInput` | Running the agent — return an `EvalRunInputResult` pointing at an
> eval record on disk. Grading reads that record, so the file must exist;
> `fakeRun` in `lib/optimize/testUtils.ts` builds one, under the run layout's
> `agent/` directory.

Task 4 changes both halves of that sentence: the seam returns a run-directory
string, and `fakeRun` starts writing `input.json` and `summary.json`. `RunInput`
is also re-exported from `lib/optimize/public.ts:40`, so this is the documented
contract for anyone writing a custom optimizer.

Task 5 remembers to update `docs/dev/eval-grading.md`. Task 4 needs the
equivalent step for `writing-optimizers.md` — the seam table row, and the
sentence about `fakeRun`. Worth checking the rest of that page while you are in
it: the `cache` seam row describes the per-`(workspace, input)` run cache, which
stays true, but the surrounding prose may name the cached value.

### 2. `gradeRun.test.ts` has a `gradeInput` suite that Task 4's file list omits

`lib/eval/grading/gradeRun.test.ts:91-130` is a whole `describe("gradeInput")`
block — three tests calling the exported function directly (`:100`, `:120`,
`:130`). Task 4 Step 3 unexports `gradeInput`, but Task 4's test list names only
optimizer test files.

Decide the fate of those three explicitly, because the choice matters: either
they become `gradeRun` tests over a one-input run directory (consistent with what
the last iteration did to the in-memory `gradeRun` tests, and the honest option),
or `gradeInput` stays exported "for tests", which re-opens the seam you are
closing. My vote is the first.

This also makes Task 6 Step 1's grep expectation too tight — it predicts zero
`gradeInput` hits "outside `gradeRun.ts`'s private `gradeInput`", which will not
be true if the tests keep the name in a comment or the conversion lands
differently. State the expected hits rather than "zero".

### 3. `lib/utils.ts` is the wrong home for `parseTarget`

`lib/utils.ts` already exists and is a generic-helpers bag: `safeDeleteFile`,
`safeDeleteDirectory`, `escape`, `deepCopy`, `zip`, `uniq`, `uniqBy`, `isObject`,
`mergeDeep`, `round` — 184 lines with no domain concept in it. There is also a
`lib/utils/` **directory** (`termcolors.ts`, `diff.ts`, `projectTree.ts`, …), so
`@/utils.js` and `@/utils/x.js` are already two different things.

`parseTarget` is not a generic utility. It parses an *agent target* —
`path`, `path:node` — which is a domain concept of exactly the module Task 1 is
creating (`lib/eval/run/target.ts`). Adding it to the generic bag makes a
multi-concept file more multi-concept, which is the debt this whole refactor is
paying down.

Two clean options:

- Put `parseTarget` in `lib/eval/run/target.ts` next to `resolveEvalRunTarget`
  and have `lib/cli/test.ts` import it from there. The cost is `cli/test.ts`
  importing from `eval/`, which is a bit odd for a non-eval command.
- Or give it its own small home, `lib/agentTarget.ts`, holding both
  `parseTarget` and `resolveEvalRunTarget`, imported by `cli/test.ts` and the
  eval/optimize paths alike. This is what I would do — "how an agent target
  string is parsed and resolved" is one concept with three consumers.

Either way, not `lib/utils.ts`.

---

## Altitude

### Task 3 moves library policy from one command file to another

`recordGrading` grades a finished run, sets `summary.grading`, writes the
verifier directory, and rewrites `summary.json`. That is suite-level write
policy — anything that runs a suite programmatically and wants the verdict
recorded the standard way needs it. It is not flag parsing.

Task 3 moves it from `lib/cli/eval/run.ts` to `lib/cli/eval/grade.ts`, but
`grade.ts` is also a command file: it exports `evalGrade`, the implementation of
`agency eval grade`. The iteration's stated goal is that `run.ts` becomes "a
command file that only parses flags and composes"; moving library logic sideways
into the neighbouring command file satisfies the letter of that and not the
spirit.

The framing in the plan ("the two ways a grading verdict gets written") is a good
observation about what the two functions have in common — I would act on it one
level down: `lib/eval/grading/recordGrading.ts` (or a `gradingOutput.ts` holding
both write policies) beside `gradeSuite.ts`, with both CLI files importing it.
Then `run.ts` and `grade.ts` are both purely commands, which is a cleaner
finish line than "one of them also holds the shared policy".

(Checked for the obvious objection: there is no import cycle either way.
`grade.ts` imports `resolveGraders` from `./graders.js`, not from `./run.js`, so
`run.ts → grade.ts` would be a clean one-way edge. The objection is about
altitude, not mechanics.)

### The "same shape" claim doesn't survive Task 5

The goal sentence says the three functions end up with the same shape, "each
takes/produces run directories". After Task 5, `judgeSuite` still takes
`inputs: Input[]` in memory alongside its two run directories
(`lib/eval/judge/suite.ts:15-21`), and uses them for the per-input goals.

But the run directories already carry the specs: `readEvalRun` returns
`ReadEvalRunInput.input`, parsed from each `input.json`
(`lib/eval/readRun.ts:27`, `:43`), which is exactly how `gradeRun` gets the specs
graders need. So the natural completion of Task 5 is that `judgeSuite` reads the
goals off disk too and loses the third parameter — at which point the symmetry
claim is true rather than aspirational.

If that is too much for this iteration, say so and downgrade the claim. Note it
would also retire a small pre-existing wart: `lib/cli/evalJudge.ts:44` calls
`loadInputs(path.resolve(opts.inputs))` directly, so `agency eval judge` silently
does not support the git suite sources `agency eval run` does.

### `runSuite` → `recordGrading` is still an in-memory, mutating handoff

`recordGrading(summary, …)` takes the `EvalRunResult` that `runSuite` returned,
**mutates it** (`summary.grading = …`), and rewrites `summary.json` from the
mutated object (`lib/cli/eval/run.ts:167-176`). That is the one place in the new
structure where suite-level data moves between two functions in memory rather
than through the run directory.

I do not think it is wrong — `runSuite` is the *producer* of the summary, and
the disk-first rule is about grading's *input*, which is still a directory. But
the plan should say that in one sentence, because it is the first thing a reader
who just internalized `docs/dev/eval-grading.md` will trip over. If you want it
airtight, `recordGrading(runDir, graders, config)` re-reading `summary.json` is
a two-line change and removes the mutation.

---

## Smaller things

**`PerRunOptions = Pick<…>` inherits a doc comment that is wrong at the new
altitude.** The idea is good — the compiler keeps the two in sync. But
`RunAgentOptions.seed`'s doc says "Computed from the agent's imports when
omitted, which is right for a one-off run"
(`lib/eval/run/runAgent.ts:20-27`). At suite level, omitting `perRun.seed` does
not mean each run computes its own; it means `runSuite` computes one for the
whole suite (`lib/cli/eval/run.ts:230`, "One closure walk per suite; never per
input"). `Pick` cannot override the comment, so `PerRunOptions` needs its own
sentence saying what omission means there.

**`evalRun` keeps a mixed bag after `runSuite` cleans one up.** Task 2 correctly
splits `deps = { runner }` (test seam) from `perRun.extractor` (production knob)
for `runSuite`, but `evalRun` keeps `overrides: { runner?, extractor? }`. Give it
the same treatment while you are editing the signature.

**Name the second tripwire in Task 4.** The plan names one (the objective math
must not drift). There is a second, quieter one: today `gradeInput` receives the
in-memory input object; after the change the spec comes from `input.json`
(`lib/eval/runArtifacts.ts:136`). A JSON round trip drops keys whose value is
`undefined`. If a grader or the reflection feedback distinguishes "`expected`
absent" from "`expected: undefined`", that difference is silent. Cheap to check
once, expensive to find later.

**Cost note worth one line.** After Task 4, each optimizer input's grade re-reads
`summary.json` and `input.json` in addition to the record, once per candidate per
input. Next to an agent subprocess this is noise, but the plan quantifies costs
elsewhere and this one is worth a clause so nobody re-discovers it as a
regression.

**Line-reference inconsistency.** The Background cites the stdlib judge caller at
`lib/stdlib/agencyEval.ts:173`, Task 5 cites `:186`. Both are inside the same
function (`:173` is the `runA` parameter, `:186` the call site). Harmless, but
pick one so the two sections don't look like they describe different code.

---

## Claims I verified, so they need not be re-checked

- **`verbose` is dead.** Declared at `lib/cli/eval/run.ts:39` and `:58`,
  forwarded once at `:149`, read nowhere. Safe to delete from both types.
- **`quietCompile` on the eval option is dead** — only `baseOptimizer.ts:272`
  passes it, and `evalRunLoadedInputs` never reads it. Caution for the
  implementer: there is a *live* `quietCompile` of the same name in
  `lib/cli/util.ts:231/259/292` used by `runAgencyNode` and
  `lib/eval/grading/agencyRunner.ts:61`. Delete the eval one, not that one. The
  plan should say this, because a blind grep-and-delete would break the judge
  runner.
- **The extractor's `input` field is unread.** Both implementations destructure
  only `{ statelogPath, outPath }` (`lib/eval/run/extract.ts:20`, and the test
  extractor at `lib/cli/eval/run.test.ts:25`). The fabrication at
  `runAgent.ts:156` goes with it.
- **The optimizer really is a suite-of-one in its own directory** — `inputs:
  [{ …input, id }]` with a per-candidate `runsDir` and `runId`
  (`baseOptimizer.ts:266-271`) — and it really does throw on a failed input
  before grading (`:285-288`). So switching to `gradeRun(runDir)` cannot change
  behavior via the errored-run-scores-zero policy: that branch stays
  unreachable. Good; this was the thing most likely to bite and it doesn't.
- **`input.json` is written** (`lib/eval/runArtifacts.ts:136`), so the input spec
  survives the disk round trip for `perInput[0].input`.
- **Both judge callers already pass strings**: `lib/cli/evalJudge.ts:45-46`
  passes the two positional run directories; the stdlib binding declares
  `runA/runB: string`.
- **`parseTarget` has exactly the two importers the plan names**
  (`lib/cli/test.ts:14`, `lib/cli/eval/run.ts:7`).
