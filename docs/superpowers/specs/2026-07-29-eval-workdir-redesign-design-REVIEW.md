# Review: Eval workdir redesign

**Spec:** /Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-29-eval-workdir-redesign-design.md
**Reviewed:** 2026-07-29, against `main` at commit 19b3d02b9 (includes #726 and #727).

## Verdict

The core move is right and the altitude is right: seed from declared inputs instead of cloning the world, let git compute the diff instead of writing bookkeeping code, and separate evidence from opinion in the run directory. The two-ingredient seed (test files + computed agent closure) is the load-bearing idea, and agent-independence is a real property worth paying for. I verified the spec's factual claims against the code and they hold, including the 1.0 GB measurement (list at the bottom).

Four things need resolving before a plan. One is a correctness hole in the central mechanism; one is a silent breaking change to an existing CLI contract; one is a claim the spec makes that is false as written; one is a sequencing constraint that shapes the API.

## Significant findings

### 1. A test fixture that is itself a git repo breaks the git-diff mechanism

The spec's own example names this case — `github.com/egonSchiele/eval-fixtures//broken-git-repo?ref=v1` — and "fix this broken repo" is an obvious eval to want. But the design makes the *workdir* a git repository (`git init`, `git add -A`, commit `seed`), and a seeded fixture that contains its own `.git` is then a nested repository.

Git does not track the contents of a nested repo. I tested this rather than reasoning about it — a fixture repo with one committed file, an outer `git init` + `git add -A` + commit as the seed, then an edit to the fixture's file:

```
warning: adding embedded git repository: fixture

$ git status --porcelain
 M fixture

$ git diff --name-only
fixture
```

The changed file never appears. Git reports only that the gitlink moved, so `changes.patch` would contain a submodule-pointer change and `artifacts/` would harvest nothing — for exactly the tests where the diff matters most. The failure is silent and looks like "the agent changed nothing."

Worth knowing: the nested `.git` already arrives today. `copyProjectTree` (`lib/utils/projectTree.ts:33-45`) matches `PROJECT_COPY_EXCLUDES` against *top-level entries only*, then `fs.cpSync(..., { recursive: true })` copies everything beneath — so a fixture's `.git` survives the copy even though the project's own `.git` is excluded. It is harmless today because nothing git-tracks the workdir. This design is what makes it harmful, which means the fix belongs here rather than being a pre-existing bug to file separately.

This is the central mechanism, so it needs an answer in the spec rather than in the plan. Options worth weighing: strip `.git` from seeded fixtures before committing (loses the fixture's own history, which a "fix the repo" test may need); use `git --git-dir` pointed outside the workdir so the tracking repo and the fixture repo do not nest; or declare fixture-repos out of scope for change tracking and say so in the failure-modes table. Any of these is fine; leaving it unstated is not, because the failure is silent.

### 2. `--inputs <dir>` already means something else

`loadInputsFromDirectory` (`packages/agency-lang/lib/eval/loadInputs.ts:40-48`) treats a directory as **one `.json` file per input** — it reads `*.json`, sorts, and normalizes each. The spec's "heavy" format wants `--inputs <dir>` to mean **a directory of test directories**, each holding `test.json` and an optional `files/`.

Those are different shapes for the same argument, and the spec never addresses the collision. As written this is a silent breaking change for anyone using the existing directory form. The spec needs a disambiguation rule stated explicitly — for example: subdirectories containing `test.json` are tests; loose `*.json` files are inputs; a directory containing both is an error naming the conflict. Whatever the rule, it belongs in the spec, and the "Migration and compatibility" section should list the existing directory form as an affected surface. It currently does not.

### 3. "Nothing outside `workdir/` depends on it existing" is false

The spec leans on this twice — to argue deletion is "a later knob, not a structural change," and again in the layout section. But #727 put `workdir` in the grader contract: `GraderContext` is `{ output, input, workdir, record, judge }`, and `agency eval grade <runDir>` re-scores a finished run using those same graders. A grader that reads `workdir` — the case the field was added for, and the one the docs advertise with `existsSync(join(workdir, "analyze.py"))` — silently breaks on re-grade once workdirs are pruned. It will not error usefully; `existsSync` just returns false and the input scores 0.

So pruning is not purely a knob: it changes what re-grading can do. The spec should either

- state that workdir-reading graders are incompatible with pruning, and that `eval grade` on a pruned run is only valid for output/record-based graders (with a diagnosable error rather than a silent 0), or
- make `artifacts/` the thing graders read, so the harvest — not the workdir — is the durable grading input. That is the more principled answer and fits the design's own "the diff is the output" thesis, but it is a real change to the #727 grader contract and needs to be a decision, not an implication.

This is the one place the spec's structural promise is overclaimed rather than underspecified.

### 4. Harvest must wait for suite-level grading, so all workspaces stay live

The spec says harvest runs "after the run finishes and grading completes (graders may read the workdir)". But grading is suite-level: `evalRunLoadedInputs` runs every input in a loop and only then calls `gradeRun` at the tail (`packages/agency-lang/lib/cli/eval/run.ts`, the block added in #727). So harvest cannot happen inside the per-input loop — every `Workspace` must be retained until after the whole suite has been graded.

That is workable but it shapes the API and the spec's example does not show it: `ws.harvest()` reads as a per-input call adjacent to `ws.run()`. Worth stating the ordering (`create → run` per input, then `gradeRun` once, then `harvest` per workspace) and noting that N workspace objects are held for the duration. For the optimizer, which makes the most workdirs, this is N-inputs-per-candidate rather than N-per-suite, so the retention window is bounded per candidate — worth confirming that is true and stating it.

## Moderate findings

### 5. The glob form has no stated base directory

`"files": ["./shared/tsconfig.json", "./fixtures/fix-failing-test/**"]` — the spec says test files are "copied to the workdir root preserving relative structure," but relative to what? The directory form has an obvious base (the sibling `files/`), so `files/src/math.ts` plainly lands at `src/math.ts`. A glob has no such base. Read literally, `./fixtures/fix-failing-test/**` would land at `fixtures/fix-failing-test/src/math.ts` in the workdir, which is almost certainly not what the author meant — and the same list mixes `./shared/tsconfig.json`, which presumably *should* land at `tsconfig.json`.

Needs an explicit rule (a per-entry base, a `{ from, to }` object form, or dropping the glob-list form from v1 in favor of directories).

### 6. `ResolvedFile` is used but never defined

The `Workspace.create` signature takes `files: ResolvedFile[]`, and the type appears nowhere else in the spec. Since it is the boundary between source resolution and seeding — and since finding 5 shows the base-directory question lives exactly there — it should be defined. Something carrying both the on-disk absolute path and the intended workdir-relative destination would answer finding 5 at the same time.

### 7. The `verifier-N` numbering rule is unspecified

`verifier/`, then `verifier-2/`, `verifier-3/` on re-grade. How is the number chosen — scan for the highest existing and add one? What happens when `agency eval grade -o` wrote out of tree and left no `verifier-N` behind? What if two re-grades run concurrently? A sentence fixes it; leaving it implicit invites two implementations.

### 8. The affected-readers list is incomplete

The spec names `readEvalRun`, `judgeSuite`, `gradeRun`'s directory path, and the report writer. Two more construct or consume the layout:

- `packages/agency-lang/lib/eval/grading/gradeRun.ts:156-157` — `workdirFor(runDir, inputId)` hard-codes `runDir/inputs/<id>/workdir`. (This is arguably "gradeRun's directory path," but it is a distinct hard-coded path constant worth naming.)
- `packages/agency-lang/lib/optimize/testUtils.ts:18,43` — `fakeRun` builds `eval-record.json` and `statelog.jsonl` at the old per-input paths. Added in #727 and used by every optimizer test seam, so it moves with the layout.

Also, "for one release" appears twice as a deprecation window (`readEvalRun` dual-layout, `working_dir`) with no mechanism named for enforcing or ending it. Worth either naming the version or saying "until manually removed."

## Minor findings

- **`resolveSeed` is actually `resolveInputSeed`** (`lib/cli/eval/run.ts`). The behavior described — validating that `working_dir` contains the agent file — is accurate.
- **`~/.agency/cache/git/` fits an existing convention.** `lib/cli/schedule/index.ts:42` already uses `~/.agency/schedules`, so the cache location is consistent rather than novel. Worth citing in the spec as precedent.
- **A git invoker already exists.** `lib/stdlib/git.ts` exports `_gitRun(cwd, args)` and `_gitIsRepo(cwd)`. No clone or cache machinery, so the resolver is genuinely new — but the spec should decide whether to reuse `_gitRun` or introduce an eval-layer equivalent. Importing stdlib support code from `lib/eval/` may be the wrong direction; either answer is defensible, but a new third way to shell out to git would not be.
- **The Terminal Bench 54 MB figure and every warren claim are unverifiable from this repo.** They are motivation rather than load-bearing design, which is fine — but they read with the same authority as the 1.0 GB measurement, which I could and did confirm. Worth marking which numbers are measured here and which are cited.
- **The size regression guard is the right test to have.** Note it needs a fixture agent with a known closure, and that its budget should be stated as a number in the spec so the plan does not invent one.
- **`keep` globs** are described as harvesting files "even if identical to a seeded file." Worth one example, since the motivating case is not obvious.

## Claims verified against the code (all hold)

- `prepareRunDir` (`lib/eval/runWorkdir.ts:57`) calls `copyProjectTree` (`lib/utils/projectTree.ts:34`), which copies every top-level entry of the seed dir minus `PROJECT_COPY_EXCLUDES` (`node_modules`, `.git`, `dist`, `runs`, `.worktrees`, `.agency-tmp`, `.js-tmp`, `.agency-memory`, `package.json`).
- **The 1.0 GB measurement is exact.** `du -sh runs/UqDcqaYbJkScb6Ogd3Tf0` → 1.0G; `du -sh runs/UqDcqaYbJkScb6Ogd3Tf0/inputs/input-1/workdir` → 1.0G. "Essentially all of it is the workdir clone" is right to the resolution of `du`.
- `working_dir` is validated to contain the agent file, in `resolveInputSeed` (`lib/cli/eval/run.ts`), and the optimizer does forbid it per-input (the same function throws when a caller-supplied seed is combined with `working_dir`).
- The optimizer's `Workspace` is a cache-partition token `{ key: string }` (`lib/optimize/workspace.ts:9`), so the name collision the spec flags is real.
- `resolveWithin` (the overlay escape guard) exists in `lib/eval/runWorkdir.ts:33` and is reusable as claimed.
- The closure walk exists twice as described: `agencyClosureBaseDir` / `visitFile` in `lib/optimize/targets.ts`, and `deriveSeedFromAgent` in `lib/cli/eval/run.ts`.
- The statelog value-cap precedent is real (`EVAL_MAX_VALUE_BYTES` in `lib/eval/extract.ts`), so "mirrors the statelog's cap policy" is accurate.
- Graders do receive `workdir` today (`GraderContext` in `lib/eval/grading/functionGrader.ts`), which is what makes finding 3 bite.
- `summary.json`'s grading block shape is as shipped in #727 (`EvalRunGrading` in `lib/eval/runTypes.ts`), so "shape unchanged" holds.

## Limitations of this review

I did not attempt to verify the Terminal Bench or warren descriptions — I have no access to either from this repo, and took them as motivation rather than design input.

Finding 1 is tested (transcript inline), but only in a bare temp directory, not through the real seeding path — that path does not exist yet.

I also did not enumerate every consumer of `summary.json` beyond the in-repo readers listed above, and did not evaluate the git-clone cache's concurrency behavior (two runs resolving the same `(url, ref)` at once), which the spec does not discuss.
