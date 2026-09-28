# Eval workdir redesign: seeded workspaces and a run directory worth keeping

**Status:** design v2, awaiting review (v1 review: sibling `-REVIEW` file; all findings addressed or made moot by dropping git tracking)
**Date:** 2026-07-29
**Follows:** PR #726 (removed the pairwise optimize loop), PR #727 (graders for `agency eval`)

---

## Background

### What a workdir is and how one gets made today

Every eval input runs in its own isolated directory, called the workdir. The isolation is the point: the agent's file reads, writes, and subprocess executions all resolve inside that one directory, so a run cannot dirty the user's project and two runs cannot dirty each other.

Today a workdir is made by `prepareRunDir` (`packages/agency-lang/lib/eval/runWorkdir.ts:57`), which calls `copyProjectTree` (`packages/agency-lang/lib/utils/projectTree.ts:34`). `copyProjectTree` copies the user's entire current directory, minus a static exclude list (`node_modules`, `.git`, `dist`, `runs`, `.worktrees`, `.agency-tmp`, `.js-tmp`, `.agency-memory`, `package.json`). Whatever survives the exclude list gets copied — data files, unrelated agents, documentation, scratch files, everything.

The consequence is measured, not hypothetical: a single eval run in this repository (`runs/UqDcqaYbJkScb6Ogd3Tf0`) occupies **1.0 GB** (measured with `du`), and all of it to `du`'s resolution is the workdir clone. For comparison, a complete five-trial Terminal-Bench job — five agents solving five tasks, with full logs — occupies 54 MB (measured on `/Users/adityabhargava/bench-agency/jobs/2026-07-20__13-49-44`; cited here as motivation, not as a design input), because it keeps no workspace at all.

### Why this blocks the goal

The eval framework's goal is comparison over time: run a suite today, change the agent, run it again next week, watch the number move. Doing that well means keeping many runs — realistically a thousand or more, since the optimizer alone makes one run per input per candidate per iteration. At a gigabyte per run, a thousand runs is a terabyte. The current design caps how much history a user can keep at "a handful," which caps what the framework can be.

There is a second, quieter problem: the run directory has no discernible organization. The workdir mixes inputs (the seeded project) with outputs (whatever the agent wrote) in one undifferentiated tree. Information is duplicated between the workdir, the statelog, and the eval record. There is no record of what seeded the run, so a run cannot be reproduced.

### What Terminal Bench does

Terminal Bench (the benchmark this repo's agent runs against, via the Harbor harness) makes the opposite trade everywhere. The descriptions below are read from a real job directory on this machine; the design borrows the ideas, not the implementation:

- **Trial results contain no workspace.** The workspace lives in a Docker container and is destroyed. What survives is logs and verdicts.
- **Tasks are not copied into results; they are cited.** A trial's `config.json` records the task's git URL, commit sha, path within the repo, and a content checksum. That is enough to reproduce the trial without storing its inputs.
- **Evidence and opinion are separate directories.** `agent/` holds what the agent did (its statelog, command log, setup output). `verifier/` holds what the grader concluded. Nothing is duplicated between them.
- **A task is agent-independent.** A task directory contains the task's files — never the agent. The same task runs against any agent, which is what makes benchmark numbers comparable across agents.

### The decisions this spec records

These were made in the design discussion preceding this document (v1 → v2 change noted inline):

1. **Terminal-Bench style is the first step.** The durable value of a run is its logs, records, and verdicts — not a project clone.
2. **A workdir is seeded from two things: the test's files and the agent's files.** The test declares its files and knows nothing about the agent; the agent's files are computed (the Agency import closure). This is Terminal Bench's agent-independence property: one suite, many agents.
3. **Test files come from *sources*: local paths or git URLs**, optionally pinned to a subdirectory and a ref. A whole suite can live in its own GitHub repo.
4. **Workdirs are kept.** The owner wants to inspect real contents before committing to a deletion policy. Seeding already collapses the size problem — a workdir of test files plus agency sources is megabytes, not a gigabyte — so keeping a thousand runs is cheap without any pruning.
5. **No git tracking of workdirs in v1.** (Changed from v1 of this spec.) The original design git-initialized every workdir to compute "what did the agent change" as a diff against a seed commit. Review found the mechanism silently fails for test fixtures that are themselves git repositories — git refuses, silently, to track file contents under a directory containing `.git`, so exactly the "fix this broken repo" tests would harvest nothing. Fixing that properly (external git-dir, per-fixture self-tracking, bundle harvest) was judged too much machinery for v1. Since workdirs are kept, "what changed" remains answerable by inspecting the workdir; a change-tracking mechanism can return later as a pure addition. The experiments and the working three-layer design are recorded in the Long-term directions appendix so the work is not lost.
6. **The workspace machinery becomes one internal class** used by eval and the optimizer. Retargeting `std::agency run()` onto it is the named follow-up; a user-facing Agency API is deliberately deferred, for the same reason stdlib `optimize()` was removed rather than retargeted: don't freeze a public shape while the ground is moving.

---

## Design

### Sources: how a directory-shaped thing is named

A **source** is a string that resolves to a local directory of files. It appears in two places: the `--inputs` CLI argument (naming a suite) and the `files` field of an input (naming one test's fixture directory). Both accept the same syntax:

```text
<source> = <local-path>              a directory, used as-is
         | <local-path>?ref=<ref>    a local git repo; files as of <ref>
         | <git-url>[//<subdir>][?ref=<ref>]
```

- `<git-url>` is an ssh URL (`git@github.com:user/repo.git`) or a GitHub https URL (`https://github.com/user/repo`, from which the clone URL is derived).
- `//<subdir>` names a directory inside the repo (the go-getter/Terraform convention — a bare `:` separator would collide with ssh URL syntax).
- `?ref=` takes anything `git rev-parse` accepts: a branch, a tag, or a commit sha. Omitted means the default branch.

Examples:

```bash
agency eval run --agent agent.agency --inputs ./evals/inputs.json
agency eval run --agent agent.agency --inputs git@github.com:egonSchiele/agency-evals.git
agency eval run --agent agent.agency --inputs 'github.com/egonSchiele/agency-evals//tests?ref=v1.2'
```

```jsonc
{ "files": "./fixtures/summarize-report" }
{ "files": "./fixtures?ref=8d601eb1" }                                  // local repo, pinned
{ "files": "github.com/egonSchiele/eval-fixtures//broken-git-repo?ref=v1" }
```

**Resolution.** A plain local path is used directly. Anything with a git URL or a `?ref=` resolves by shallow clone into a cache directory keyed by `(url, ref)` — `~/.agency/cache/git/<hash>/` (precedent for the `~/.agency` home: `lib/cli/schedule/index.ts:42` already uses `~/.agency/schedules`). Fetch policy differs by ref kind, meaning does not:

- **sha:** `git init` + `git fetch --depth 1 origin <sha>` + checkout. Immutable, cached forever. (Fetching an arbitrary sha requires server support — GitHub allows it; when a server refuses, the resolver falls back to a fuller fetch and local checkout. Users never see the difference.)
- **tag:** shallow clone at the tag, cached without revalidation. Tags can technically be force-moved, which is one reason provenance records the resolved sha rather than trusting the ref name.
- **branch or no ref:** re-fetched on every run, then resolved to a sha.

Local paths with `?ref=` work because git clones happily from a local directory (near-instant; it hardlinks objects). A path with `?ref=` is a git source; a path without one is a plain directory.

The resolver shells out to git with a small eval-layer helper. It does **not** import `_gitRun` from `lib/stdlib/git.ts` — stdlib support code backs Agency-language builtins, and `lib/eval` importing it would point the dependency the wrong way — but the helper should be the *only* new way the eval layer invokes git, so there are exactly two git invokers in the codebase, each owned by its layer.

Cache concurrency: two runs resolving the same `(url, ref)` simultaneously is resolved by clone-into-temp-then-atomic-rename; the loser of the race discards its clone. Cheap, and avoids a lock file.

**The invariant: every source resolves to `(directory, sha?)` and the run's `config.json` records both.** A run made against `ref=main` is retroactively pinnable — copy the sha out of its `config.json`. Two runs are comparable exactly when their recorded shas match.

**Nesting limit.** A suite loaded from a git source may contain tests whose `files` are local paths (relative to their position in the cloned repo). A test inside a cloned suite may **not** point its `files` at another git URL. Sources resolve one level deep; a transitive git source is a load-time error. This keeps resolution non-surprising and can be relaxed later if a real need appears.

**Safety property worth preserving.** Tests are inert data: files plus JSON specs. There are no setup scripts in v1 (see Not in scope), so cloning and seeding a remote suite executes nothing. If setup scripts ever arrive, remote suites become remote code execution and need the same consent treatment as running any foreign agent — this spec explicitly flags that boundary for whoever adds them.

### Test file formats: light and heavy

Two authoring shapes, one canonical form. The runner only ever sees the canonical form.

**Light: a `files` field on the input spec.** The suite stays one JSON file; an input that needs no files looks exactly like today. `files` is **one directory source** — not a glob list. (v1 of this spec allowed a glob-list form; review showed it had no well-defined base directory — `./fixtures/x/**` landing at `fixtures/x/...` vs `...` is a coin-flip guess — so globs are dropped from v1. A `{ from, to }` object form can be added later if directories prove insufficient.)

```jsonc
// evals/inputs.json
[
  {
    "id": "capital-france",
    "goal": "Return the capital of France",
    "expected": "Paris",
    "args": { "country": "France" }
    // no "files": the workdir is seeded with the agent closure only
  },
  {
    "id": "summarize-report",
    "goal": "Summarize the quarterly report into summary.md",
    "args": {},
    "files": "./fixtures/summarize-report"     // one directory, resolved relative to this JSON file;
                                               // its CONTENTS are copied to the workdir root
  }
]
```

**Heavy: each test is a directory** (the Terminal-Bench shape). Its spec sits next to its files; `--inputs` points at the parent:

```text
evals/tests/
  capital-france/
    test.json               # spec only; no files/ needed
  summarize-report/
    test.json
    files/
      quarterly-report.pdf
  fix-failing-test/
    test.json
    files/
      src/math.ts
      src/math.test.ts
```

```jsonc
// evals/tests/summarize-report/test.json — note what is absent:
// id defaults to the directory name; files defaults to the sibling files/ dir
{
  "goal": "Summarize the quarterly report into summary.md",
  "args": {}
}
```

**Desugaring.** The directory form lowers to the light form inside `loadInputs`:

```ts
function loadTestDir(testDir: string): Input {
  const spec = readJson(path.join(testDir, "test.json"));
  const filesDir = path.join(testDir, "files");
  return {
    id: spec.id ?? path.basename(testDir),
    ...spec,
    ...(fs.existsSync(filesDir) ? { files: filesDir } : {}),
  };
}
```

After loading, every input is `{ id, goal?, expected?, args, files? }` where `files` has been resolved to an absolute directory. Seeding has no idea which format a test came from. A suite can start as one `inputs.json` and promote individual tests to directories as they grow fixtures — or the reverse.

**Disambiguating `--inputs <dir>`.** A directory argument already means something today: `loadInputsFromDirectory` (`packages/agency-lang/lib/eval/loadInputs.ts:40-48`) reads it as *one `.json` file per input*. The rule that keeps both shapes working:

- Subdirectories containing a `test.json` are tests (the heavy form).
- A single `.json` file whose parsed shape has a top-level `inputs` array is the *file* form — this is what a suite repo whose root holds one `inputs.json` looks like when `--inputs` points at a bare git URL, so it must load as if the file had been named directly.
- Other loose `*.json` files are one-input-per-file (the existing form).
- A directory that mixes shapes (a wrapper file beside loose inputs, or loose files beside test directories) is a load-time error naming the conflicting entries — mixing is more likely a mistake than a plan.

### Seeding: test files + agent closure

The seed of a workdir is the union of two file sets:

1. **The test's files** — the contents of the resolved `files` directory, copied to the workdir root preserving relative structure (`files/src/math.ts` → `workdir/src/math.ts`).
2. **The agent's import closure** — the entry `.agency` file plus every file it transitively needs, preserving their paths relative to the project root. This is computed, never declared: the compiler already walks the `.agency` half (today via `agencyClosureBaseDir`/`visitFile` in `packages/agency-lang/lib/optimize/targets.ts` and `deriveSeedFromAgent` in `packages/agency-lang/lib/cli/eval/run.ts`). The walk relocates to `packages/agency-lang/lib/analysis/closure.ts` — the established home for shared walks (`lib/analysis/effects.ts`) — because its main consumer becomes eval, and eval importing from `lib/optimize` would invert the layering this workstream exists to straighten; the optimizer's target discovery consumes it from there like everyone else. Users never hand-list agent files.

   **The closure includes TypeScript interop files.** An `.agency` file may import a local TypeScript/JavaScript sibling (`import { greet } from "./greet.js"` — the documented interop form, used by 52 files in this repo). Those are not agency imports, so the `.agency` walk alone would miss them and the agent would fail at run time on an unresolved module. The closure walk therefore also collects each `.agency` file's local non-agency relative imports and expands each through esbuild (`buildSync` with `bundle: true`, `write: false`, `metafile: true`, bare imports external) — the metafile's inputs are exactly the transitive local `.ts`/`.js` files, with no hand-written import parser. esbuild is already a dependency (the grading-module loader uses it). A `./x.js` specifier whose on-disk file is `x.ts` seeds the `.ts` (both, when both exist).

   Two well-known project files are additionally seeded from the closure base directory when present: `agency.json` and `.env`. Both are read at run time from the working directory, arrive incidentally under today's full clone, and would otherwise vanish silently.

**Collisions are errors.** If a test's files and the agent's closure both provide the same path, seeding fails with a message naming the path and both sources. A collision almost certainly means the test was written against one specific agent — exactly the coupling the two-ingredient model exists to prevent. Failing loudly at seed time is cheaper than debugging a silent overwrite.

**`working_dir` retires.** Today an input may carry `working_dir`, a directory validated to *contain the agent file* (`resolveInputSeed` in `packages/agency-lang/lib/cli/eval/run.ts`). That contract is the fusion this design splits: the directory was serving as both test files and agent home. `working_dir` keeps working with a deprecation warning pointing at `files` until it is manually removed in a later change; new documentation stops mentioning it immediately. (The optimizer already forbids per-input `working_dir` — `resolveInputSeed` throws when a caller-supplied seed is combined with it — so the optimizer is unaffected.)

**Unseeded reads fail honestly.** An agent that reads a project file nobody seeded gets ENOENT inside the workdir even though the file exists in the user's project. That is correct behavior — the failure mode of declared seeding — but it must be diagnosable: when a run errors, the eval record gains a warning listing the workdir's seeded contents, and the documentation's first troubleshooting entry is "add the file to `files`". A friendlier "did you mean to seed X?" hint (diffing failed paths against the project tree) is a later nicety, not v1.

**Compilation happens in place**, as today: the entry agent compiles inside the workdir, so module-dir == cwd == workdir and all resolution stays inside the sandbox. The overlay escape guard (`resolveWithin`, `packages/agency-lang/lib/eval/runWorkdir.ts:33`) is reused for optimizer overlay files.

### The run directory layout

Terminal Bench's evidence/opinion separation, adapted to our artifacts:

```text
runs/<run-id>/
  config.json               # resolved provenance: agent entry + closure file list with
                            #   checksums; inputs source (URL + resolved sha when git);
                            #   per-input files sources (+ shas); graders; model; CLI
                            #   options as resolved
  summary.json              # counts + grading block (shape unchanged from #727)
  verifier/
    grading.json            # what the graders concluded (inline grading writes it here too)
    # re-grades via `agency eval grade` write verifier-2/, verifier-3/, ...
  inputs/<input-id>/
    input.json              # the resolved input spec, including what `files` resolved to
    agent/
      statelog.jsonl        # what the agent did
      eval-record.json      # the normalized trace
      error.txt             # only on error
    workdir/                # kept; inputs + whatever the agent wrote
```

`verifier/` sits at the **run root**, not per input: grading is suite-level (`gradeRun` produces one `Scorecard` for the whole run), so one `grading.json` covers every input via its `perInput` array. Per-input directories hold only evidence.

The organizing rule: **`agent/` is evidence, `verifier/` is opinion, `workdir/` is the workspace.** The first two never duplicate each other.

**Re-grade numbering.** `agency eval grade` writes to `verifier-N/` where N is one more than the highest existing `verifier` or `verifier-N` directory; `-o <path>` continues to write out of tree and creates no `verifier-N`. Concurrent re-grades of the same run are not coordinated in v1 (single-writer assumption; a collision surfaces as a mkdir failure, not corruption).

**One honest caveat about keeping-then-pruning.** #727 gave graders a `workdir` field (`GraderContext` in `packages/agency-lang/lib/eval/grading/functionGrader.ts`), and `agency eval grade` re-scores finished runs with those same graders. While workdirs are kept, this all works. If a future pruning policy deletes workdirs, workdir-reading graders on pruned runs would silently score 0 (`existsSync` → false), which is unacceptable — so the future deletion decision **must** come with an answer for re-grading (either "re-grading pruned runs requires record/output-based graders, and `eval grade` errors clearly when a workdir grader meets a pruned run," or a harvest step that preserves what graders need). This spec keeps workdirs and therefore defers that answer, but records the constraint so "just delete them" is never treated as a one-line change.

**Compatibility.** This is a breaking layout change for anything that reads or fabricates run directories. The affected surfaces, all in-repo, updated in the same change:

- `readEvalRun` (`packages/agency-lang/lib/eval/readRun.ts`) — should read both layouts (statelog/record at the old flat paths or under `agent/`) until support for old runs is manually removed, so existing runs stay judgeable and gradable.
- `judgeSuite` and `gradeRun`'s directory path (via `readEvalRun`).
- `workdirFor` (`packages/agency-lang/lib/eval/grading/gradeRun.ts:156`) — hard-codes `runDir/inputs/<id>/workdir`; unchanged by this layout but named here so the plan treats it as a layout constant, not a coincidence.
- `fakeRun` (`packages/agency-lang/lib/optimize/testUtils.ts`) — fabricates the per-input layout for every optimizer test seam; moves to the new paths.
- The report writer and `summary.json` writers in `lib/cli/eval/run.ts`.

### The Workspace primitive

One internal class owns the lifecycle every consumer shares. Placement: `packages/agency-lang/lib/eval/workspace.ts`. Naming: the optimizer already has a `Workspace` type that is a cache-partition token `{ key: string }` (`packages/agency-lang/lib/optimize/workspace.ts:9`); that type renames to `CachePartition` (more honest about what it is), freeing the name.

```ts
type SeedSpec = {
  /** The test's fixture directory (already source-resolved), or absent. Its
   *  contents land at the workdir root. */
  filesDir?: string;
  /** Absolute path to the entry .agency file; the closure walk finds the rest. */
  agentEntry: string;
  /** Optimizer candidate files, keyed by workdir-relative path; applied last,
   *  through the resolveWithin escape guard. */
  overlayFiles?: Record<string, string>;
};

const ws = Workspace.create({ workdirPath, seed, overlayFiles, config });
// copies test files, copies the agent closure, errors on collision,
// applies overlayFiles, compiles the entry in place. Synchronous, like the
// prepareRunDir it replaces.

const result = await ws.run(runner, { node, args, statelogPath });
// invokes the injected EvalInputRunner with cwd = workdir. The runner stays a
// parameter (rather than the class owning subprocess execution) so the seam
// every existing test injects survives, and Workspace stays out of the
// subprocess-limits business.
```

Grading happens where it does today — suite-level, after all inputs ran (`gradeRun` at the tail of `evalRunLoadedInputs`) — and reads workdirs that are simply still there. With no harvest step, the Workspace lifecycle is just `create → run`; nothing needs to be retained-then-finalized, and no ordering constraint exists between grading and cleanup because there is no cleanup.

What dies: `prepareRunDir`'s full-project clone and the eval path's use of `copyProjectTree` (the function itself survives; the eval layer stops calling it). What is reused: the compile-in-place logic, `resolveWithin`, and the closure walk shared with optimizer target discovery.

Consumers in v1: `evalRunLoadedInputs` (per input) and, through it, `BaseOptimizer` (per input per candidate — its `overlayFiles` flow through unchanged, and its per-candidate workdirs shrink by the same three orders of magnitude, which matters most for the optimizer since it makes the most workdirs). `std::agency run()` is the named follow-up consumer; its migration is deliberately out of scope because its semantics (interrupt propagation, policy inheritance across the subprocess boundary) deserve their own change. No user-facing Agency API in v1.

### Failure modes, collected

| Failure | Behavior |
| --- | --- |
| Test file collides with a closure file at seed time | Hard error naming the path and both sources |
| Agent reads an unseeded file | ENOENT in the workdir; on error, the eval record lists seeded contents; docs point at `files` |
| git source unreachable / bad ref | Load-time error before any agent runs, naming the source string |
| Transitive git source inside a cloned suite | Load-time error (one-level rule) |
| `--inputs <dir>` mixes loose `*.json` and `test.json` subdirs | Load-time error naming the conflicting entries |
| Server refuses direct sha fetch | Resolver falls back to fuller fetch + local checkout, transparently |
| Concurrent resolution of the same `(url, ref)` | Clone-to-temp + atomic rename; loser discards |

---

## Not in scope

- **Git tracking of workdirs / change harvest** (`changes.patch`, `artifacts/`). Dropped from v1 by owner decision after review; see Long-term directions for the investigated design.
- **Setup scripts per test** (Terminal Bench has them; we don't, yet). Static files only. This is also what keeps remote suites inert — adding setup scripts later turns remote suites into remote code execution and requires a consent story.
- **Workdir deletion/pruning.** Deferred until real contents have been inspected. The re-grading constraint recorded in the layout section is part of that future decision.
- **Glob or `{ from, to }` forms of `files`.** One directory per test in v1.
- **`std::agency run()` retarget onto Workspace.** Follow-up #1, shaped for by the class boundary but not bundled.
- **A user-facing Workspace API in Agency code.** Deferred until the optimize/eval surface for Agency programs is rethought (same reasoning as removing stdlib `optimize()`).
- **A ctrf.json or similar standard-format verifier report.** Noted from Terminal Bench as a cheap future win for dashboard interop; not v1.
- **Transitive git sources** (a cloned suite pointing at further repos). One level deep in v1.

## Long-term directions (recorded, not designed)

**Change tracking, when it returns.** The v1-review investigation produced a verified design worth keeping (experiments in the 2026-07-29 design session transcript):

- Git silently refuses to track file contents under any directory containing `.git` — even explicit `git add <file>` inside an embedded repo is a no-op with exit 0. Any tracking design must therefore treat embedded fixture repos separately.
- The working three-layer shape: (1) tracking repo *outside* the workdir (`--git-dir=<inputDir>/seed.git`, work-tree = workdir), which also hides the bookkeeping repo from the agent entirely (`git status` in the workdir says "not a git repository"); (2) a seed-time scan recording each embedded repo's path and HEAD sha and excluding its subtree via `info/exclude`; (3) two-part harvest — outer status/diff for normal files, and per embedded repo *its own* `git diff <seedSha>` + `git status` + a `git bundle --all` in the artifacts.
- A GitHub-hosted suite cannot contain a real fixture `.git` at all (git refuses to track `.git` paths), so remote git-task fixtures need a rename convention (e.g. `.git-fixture/` → `.git` at seed time) regardless of the tracking design.

From warren (`/Users/adityabhargava/warren`; descriptions read from its SPEC and docs, cited as inspiration):

- **Statelog as eval input.** Warren's "mulch" feature distills expertise records from run event streams and primes them into the next run. Our statelogs already capture everything; a distillation step (grade the trace, extract "what went wrong/right" records, feed them to the optimizer's reflection prompt or to the agent itself) is the natural next layer on top of a thousand cheap saved runs.
- **A task queue** ("software factory"): a queue of test-shaped tasks that agents pick up, execute in workspaces, and whose results land in the run store. The Workspace primitive and the agent-independent test format are the two building blocks it would need.
- **An observe-only lifecycle bus** (warren's tier-1 extension seam) if third-party consumers ever need run lifecycle events; Agency's existing lifecycle hooks may already suffice.

## Testing

- **Sources:** unit tests for the parser (`url`, `//subdir`, `?ref=`, ssh vs https vs local, derivation of clone URL from GitHub https); resolver tests against a local fixture repo (sha/tag/branch fetch policies, cache hit behavior, one-level nesting rule, error on bad ref, concurrent-resolution rename race). No network in tests — local bare repos exercise every path.
- **Formats:** `loadInputs` desugars a test directory to the canonical input; `files` resolution relative to the inputs file; id defaulting; the `--inputs <dir>` disambiguation rule including the mixed-directory error.
- **Seeding:** closure files land at project-relative paths; test files land at root; collision errors; overlay applies last and cannot escape the workdir; unseeded-read warning appears in the record for an errored run.
- **Layout:** `readEvalRun` reads both old and new layouts; `eval grade` writes `verifier-2/` on re-grade and respects `-o`; `eval judge` works on new-layout runs.
- **Optimizer:** existing optimizer suites pass with workdirs now closure-sized; overlay candidates still produce distinct workdirs per candidate.
- **Size regression guard:** an integration test asserts a seeded workdir for a fixture agent (entry + two imports, one small fixture dir) stays under **1 MB** — the property this whole design exists to buy. The number is deliberately in the spec so the plan does not invent one.

## Migration and compatibility

- Old run directories remain readable (`readEvalRun` dual-layout) for judging and grading until that support is manually removed; they are not migrated.
- The existing `--inputs <dir>` form (loose `*.json` files) keeps working; the heavy test-directory form is additive, and mixing the two in one directory is an error.
- `working_dir` on inputs: deprecation warning pointing at `files`; removed in a later change.
- Suites with no `files` fields behave identically to today except the workdir contains the agent closure instead of the whole project — the one observable difference is an agent that read undeclared project files, which now fails (see failure modes) and previously worked by accident.
- The optimizer's public seams (`RunInput`, `EvalRunInputResult`) do not change shape; only the contents of workdirs and the run directory layout change.
