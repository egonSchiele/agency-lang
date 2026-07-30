# Graders for `agency eval`

**Status:** design, awaiting review
**Date:** 2026-07-29
**Follows:** PR #726 (removed the pairwise optimize loop; eval output now defaults to the node's return value)

---

## Background

### What an eval framework is for

You use an eval framework to find out how good your agent is. That means three things: run the program, look at what it produced, and turn that into a number. The number matters because a number can be compared. If today's run scores 0.71 and last week's scored 0.62, you improved. If you cannot produce a number, you cannot answer the only question you actually have.

Agency has all three of those capabilities today. It just does not have them in the same place.

### What `agency eval run` does today

`agency eval run` takes an agent and a list of inputs, runs the agent once per input, and writes out a directory of artifacts:

```bash
agency eval run --agent agent.agency --inputs inputs.json
# Run abc123 completed: 3/3 inputs ok
```

The words "3/3 inputs ok" mean three processes started and three processes exited without crashing. Nothing looked at what the agent produced. There is no grader concept anywhere in `lib/cli/eval/run.ts` — the word "grade" does not appear in the file.

Each run produces this on disk:

```text
runs/<run-id>/
  config.json
  summary.json
  inputs/<input-id>/
    input.json          the input spec that was used
    statelog.jsonl      the raw event trace
    eval-record.json    the normalized trace, including what the agent output
    workdir/            the isolated directory the agent ran in
    error.txt           only when the input failed
```

That is a good set of artifacts. Everything needed to score a run is already sitting there. Nothing scores it.

### What `agency optimize` does today

`agency optimize` rewrites declarations you have marked with the `optimize` modifier, searching for values that make the agent score better. To do that, it has to score things — so it has a complete grading system.

You write graders in a TypeScript module:

```ts
// graders.ts
import { grader, ExactMatch, LlmJudge } from "agency-lang/optimize";

export default [
  new ExactMatch({ mustPass: true }),
  grader(({ output }) => output.length < 500, { name: "concise" }),
  new LlmJudge({ name: "quality", weight: 0.5 }),
];
```

```bash
agency optimize agent.agency --inputs inputs.json --graders graders.ts
```

That works today, and the machinery behind it is good:

- `BaseGrader` handles k-sample repetition, aggregation, `mustPass` gating, weighting, thresholds, and restricting a grader to a subset of inputs.
- `Scorecard` turns per-input grades into the 0-to-1 number, with `objective()`, `gatesPassed()`, `inputScores()`, and `gatedObjective()`.
- Built-in graders cover exact match, substring containment, string similarity, and an LLM judge; `grader(fn)` wraps any plain function.
- `loadGradingModule` loads a user's TypeScript file with esbuild and normalizes whatever it default-exports.

### Where those two facts collide

The grading system lives at `lib/optimize/grading/`:

```text
lib/optimize/grading/
  baseGrader.ts        what a grader is
  functionGrader.ts    grader(fn) and the public Grader union
  scorecard.ts         per-input grades into one number
  aggregate.ts         k-sample aggregation
  grade.ts             scalar() / binary() constructors
  getPath.ts           JSON-path lookup into an input
  agencyRunner.ts      runs a judge .agency file
  types.ts             Grade, Score, GraderOptions, AgentRun, GraderInput
  graders/
    builtinGraders.ts  ExactMatch, Contains, Similarity
    llmJudge.ts        the LLM judge
    humanGrader.ts     ask a person
```

Nothing in that list has anything to do with optimizing. It is a general-purpose "score an agent run" library that happens to live inside the optimizer's directory. The optimizer is simply the only thing that ever needed it.

The consequence is that for `agency eval` to score anything, it would have to import upward from `optimize` — the wrong direction. The stated architecture is that the optimizer sits **on top of** the eval framework: eval knows how to run and score agents, and the optimizer adds target discovery, source mutation, and a search loop on top. Grading sitting under `optimize/` inverts that.

### How the optimizer already uses eval

This part is already right. After PR #726, `BaseOptimizer` does not have its own agent runner — it calls `evalRunLoadedInputs` from `lib/cli/eval/run.ts` once per input, per candidate. So the run half of the relationship already flows in the correct direction. It is only grading that is misfiled.

### The problem, stated plainly

1. **`agency eval` cannot answer the question it exists to answer.** There is no way to score an eval run. Your only route to a number is to run the optimizer — a hill-climbing search that rewrites your source — when all you wanted was to measure the agent as it stands.

2. **The scoring code is filed under the wrong roof.** It is general-purpose but lives inside `optimize/`, so using it from eval would invert the intended dependency direction.

---

## What we are building

Three things:

1. Move the grading library from `lib/optimize/grading/` to `lib/eval/grading/`.
2. Add one function, `gradeRun`, that turns a run into a score — plus the per-input step it loops over.
3. Give `agency eval` two ways to reach it: score during a run, and score a finished run afterwards.

The optimizer then calls the same shared grading code instead of its own copy, and keeps only what is genuinely about search.

---

## Design

### What moves

| From | To |
|---|---|
| `lib/optimize/grading/**` (all of it) | `lib/eval/grading/**` |
| `lib/optimize/goalJudgeFile.ts` | `lib/eval/grading/goalJudgeFile.ts` |
| `lib/optimize/gradeBreakdown.ts` | `lib/eval/grading/gradeBreakdown.ts` |
| `lib/optimize/gradingModule.ts` | `lib/eval/grading/gradingModule.ts` |

`goalJudgeFile.ts` moves because `llmJudge.ts` imports it — it resolves the bundled goal-judge `.agency` file and provides `ScalarVerdict` and `asJudgeText`.

`gradeBreakdown.ts` moves because eval's scored summary wants the same per-input view that optimize's report already renders.

`gradingModule.ts` moves because it is what turns `--graders foo.ts` into `BaseGrader[]`, and both new eval commands need it. It sits one level above `grading/` today, so "all of `grading/`" would miss it. Nothing in it is optimizer-specific: it esbuild-loads a user module and normalizes the default export through `toGrader`.

Each of these three would otherwise leave the moved library importing upward into `optimize`, which is the exact inversion this change exists to fix.

Everything else under `lib/optimize/` stays where it is.

Everything else under `lib/optimize/` stays where it is.

### The two entry points

Grading already has a natural shape in the current code: score one input, then aggregate across inputs. The design gives that shape a name and moves it somewhere both commands can reach.

```ts
/** What grading needs besides the run itself. */
type GradingContext = {
  graders: BaseGrader[];
  /** Capability to execute a judge .agency file. Built from an AgencyConfig. */
  runAgency: AgencyRunner;
};

/** Score one input. */
function gradeInput(
  input: Input,
  result: EvalRunInputResult,
  ctx: GradingContext,
): Promise<InputGrades>;

/** Score a whole run: the loop, plus the aggregation that already exists. */
function gradeRun(
  run: EvalRunResult | ReadEvalRunResult | string,
  ctx: GradingContext,
): Promise<Scorecard>;
```

The `runAgency` field is not optional plumbing. A class-based grader's entry point is `run({ input, run, runAgency })`, and `LlmJudge` — one of the four built-ins — cannot produce a score without it. Callers build one from the `AgencyConfig` they already hold: the optimizer passes its existing `this.agencyRunner`, and the two eval commands construct `new AgencyRunner(getConfig())`.

**No new approval plumbing is needed for judge runs.** The bundled `goalJudge.agency` raises no interrupts — it makes an LLM call, and LLM calls are not interrupt-gated — and `AgencyRunner` passes no interrupt handlers today. Optimize's judging already works on exactly this path, and `eval grade` uses the same one. (The auto-approval at `lib/cli/eval/run.ts:331` is for the *agent under test*, which is a different code path.) A user who supplies a custom judge `.agency` that reads files or runs commands would need handlers, but that is true of optimize today and is not a regression this spec introduces.

`gradeRun` is `inputs.map(gradeInput)` followed by `new Scorecard(...)`. Neither is a new abstraction: `gradeInput` is the second half of `BaseOptimizer.gradeInput` moved out, and `Scorecard` already exists unchanged.

The union on `gradeRun`'s first parameter mirrors what `judgeSuite` already accepts today, so a run directory path, a loaded run, and an in-memory result are interchangeable. A path is normalized through the existing `readEvalRun`.

Three callers:

| Caller | Call |
|---|---|
| `agency eval run --graders` | `gradeRun(freshResult, graders)` |
| `agency eval grade runs/abc` | `gradeRun("runs/abc", graders)` |
| `BaseOptimizer.evaluate` | `gradeInput(...)` per input |

### What a grader receives

The context a grader function gets today is `{ output, input, judge }`. It gains two fields:

```ts
export type GraderContext = {
  /** The agent's output — the entry node's return value, or what evalOutput() recorded. */
  output: JSON;
  /** The input spec this run was given: args, goal, expected, metadata. */
  input: Input;
  /** The isolated directory the agent ran in. Read files the agent wrote. */
  workdir: string;
  /** The parsed eval record: events, metrics, tool counts, interrupts, cost. */
  record: EvalRecord;
  /** Run the bundled LLM goal judge and get back a 0..1 score plus reasoning. */
  judge: (args: { goal: string; output?: JSON; expected?: JSON }) => Promise<{ score: number; reasoning: string }>;
};
```

Which makes all of this expressible:

```ts
export default [
  // the return value
  grader(({ output }) => output.length < 500, { name: "concise" }),

  // a file the agent wrote
  grader(({ workdir }) =>
    existsSync(join(workdir, "analyze.py")), { name: "wrote-script" }),

  // what it did on the way there
  grader(({ record }) => record.metrics.toolCounts.write > 0, { name: "used-write" }),
  grader(({ record }) => record.metrics.costUsdTotal < 0.05, { name: "cheap" }),
];
```

Both new fields are values already on hand. `record` is parsed from `eval-record.json`, which grading already reads to obtain `output`, so it costs nothing extra. `workdir` is a path that already exists in `EvalRunInputResult.workdirPath`; it is simply not passed through today.

**No curated trace API.** There is deliberately no `trace.calledTool("write")` helper layer. The raw record makes trace-based grading possible immediately; a nicer vocabulary can be layered on later, once there is real usage to tell us which questions people actually ask. Committing to that vocabulary now means guessing, and a wrong guess is a public API to deprecate.

**Class-based graders keep `GraderInput`** (`{ input, run, runAgency }`), extended with the same `workdir` and `record`, so the two forms have equal power. Today the ergonomic function form is the *less* capable one, which is backwards.

### Grading order and failures

`gradeInput` preserves the ordering `BaseOptimizer.gradeInput` uses today: run every `mustPass` gate first, short-circuiting that input the moment one fails, then run the advisory graders. This means a gate failure does not pay for the expensive graders behind it.

Two failure cases, which belong at **different layers**. Getting this wrong would silently change optimizer semantics, so it is worth being precise.

**An input whose agent run errored** scores 0, is marked gate-failed, and is counted rather than skipped. Dropping failures would let a suite raise its average by crashing.

This rule lives in `gradeRun`, **not** in the shared `gradeInput`, because it is new eval-side policy rather than moved code. The optimizer never reaches grading on a failed run: `runInputViaEval` throws first (`baseOptimizer.ts:308-310`), and this spec does not change that. An errored input may not even have an `eval-record.json` to read, so `gradeRun` recognizes it from `result.status === "error"` and short-circuits before assembling a grader context. An implementer should not push this into `gradeInput`.

**Gate semantics for an errored input:** it fails every gate. `InputGrades.gatesPassed` is set `false`, so `Scorecard.gatesPassed()` is false whenever any input errored, and the command exits 2. A crash should not pass a suite. Under `--no-grade` there is no grading block at all and today's exit behavior is preserved exactly.

**An input that produced no output** — the node returned nothing or `null`, and `evalOutput()` was never called — also scores 0, with the reason in its breakdown. Today `gradedOutput` *throws*. Eval needs a suite of mixed results rather than an abort, so this becomes a scored zero. The optimizer loses nothing: `requireBaselineGatesPass` already refuses to optimize a baseline that fails, and a baseline scoring 0 with "no output" in its breakdown is exactly that, with a clearer message than a thrown stack.

### The two commands

```bash
# everyday path: run and score in one go
agency eval run --agent a.agency --inputs in.json --graders g.ts

# iterate on the grader against fixed outputs, no agent runs
agency eval grade runs/abc --graders g.ts
```

The second exists because developing a grader means iterating on the *grader*, not on the agent. Agent runs cost money, take time, and are non-deterministic — if grading were welded to running, every grader tweak would re-run the suite and change the thing being measured underneath you. `eval grade` reads the agent's outputs from disk and never re-executes the agent.

To be precise about the cost, since it is the whole point of the command: for `ExactMatch`, `Contains`, `Similarity`, and function graders that do not call `ctx.judge`, `eval grade` makes no network calls at all — it is free and deterministic. For `LlmJudge`, or a function grader that calls `ctx.judge(...)`, the judge itself still makes live LLM calls on every invocation, so re-grading costs money and can vary run to run. Even then it is far cheaper than re-running the agents, and the thing being judged is held fixed, which is the property that matters when you are tuning a grader.

Both print the same block, which is `gradeBreakdown` rendered:

```text
3/3 inputs ok
objective  0.71
  exact-match   2/3 pass
  concise       0.85
  cheap         pass    (gate)
```

**Declaring graders** mirrors optimize exactly: a `--graders <file.ts>` flag, or `eval.graders` in `agency.json`. The module is loaded by the existing `loadGradingModule`.

**With no `--graders`, both commands default to the bundled goal judge** — `[new LlmJudge({ name: "goal" })]` — which is exactly what `agency optimize` already defaults to (`lib/cli/eval/optimize.ts:177-179`). This removes an asymmetry that would otherwise be baffling: the same input suite, with `goal` on every input, scored by one command and ignored by the other. It also means `agency eval run` produces a number out of the box, with no grading module to write.

`eval run` already *requires* `goal` on every input, so the default judge always has something to grade.

**`--no-grade` skips grading entirely.** The default judge makes an LLM call per input, so without an opt-out there would be no way to execute a suite without paying for judging — a capability `eval run` has today. `--no-grade` preserves it, and is the flag to reach for in CI when you only want to know that the agent ran.

**`goal` becomes optional** on an input when a grading module is supplied. `loadInputs` already takes a `requireGoal` option for exactly this reason; the optimize CLI already passes `false` when `--graders` is given. `eval run` does the same.

### Output artifacts

`summary.json` gains one optional key:

```jsonc
{
  "runId": "...", "agent": "...", "inputs": [...],
  "okCount": 3, "errorCount": 0,
  "grading": {                        // absent only under --no-grade
    "graders": ["exact-match", "concise", "cheap"],
    "objective": 0.71,
    "gatesPassed": true,
    "perInput": [ /* InputBreakdown[] */ ]
  }
}
```

Because grading now defaults on, `grading` is normally present — it is absent only under `--no-grade`. The compatibility guarantee is therefore about *addition*, not absence: every key `summary.json` has today keeps its name, position, and meaning, so an existing consumer reading `runId`, `inputs`, `okCount`, or `errorCount` is unaffected either way.

`agency eval grade` is **non-destructive**. It writes `grading.json` into the run directory (or `-o <path>`) and never rewrites `summary.json`. The run keeps the score it was born with; re-grades sit beside it. Re-grading twice overwrites `grading.json` unless `-o` is given, which is the right default for the tight iteration loop the command exists to serve.

There is a known tension here: a score lives inside `summary.json` when it came from `eval run`, and in a sibling `grading.json` when it came from `eval grade`. Two homes for the same kind of value. The deeper cause is that `summary.json` implicitly ties one run to one grade, when a run can be graded many times. Deliberately left as-is for now; it belongs with the run-directory layout rework, which is a separate design.

### Exit codes

- `0` — every input ran and no `mustPass` gate failed.
- `2` — a `mustPass` gate failed, or inputs errored under `--no-continue-on-error` (the code that path already uses).

One failure code, with the printed output saying which case it was. A `mustPass` grader is therefore the assertion mechanism, and everything else is a measurement you track over time. No separate `--min-objective` threshold flag: it would be a second, overlapping pass/fail mechanism, and a single aggregate bar cannot say which aspect regressed.

### How the optimizer consumes it

`BaseOptimizer` keeps its run loop, its per-`(workspace, input)` cache **policy**, and its caching of runs rather than grades. The grading logic currently inlined in `BaseOptimizer.gradeInput` is deleted and replaced by a call to the shared `gradeInput`. The optimizer continues to run inputs one at a time and build its own `Scorecard`.

**But one type has to grow, and pretending otherwise would be wrong.** Today the run step returns `AgentRun = { output, recordPath }` (`baseOptimizer.ts:312-313`) and discards `workdirPath` at that exact boundary. That is what `EvalCache` stores. If graders are to receive `workdir` and `record`, the cached value can no longer be `AgentRun`.

The fix is to move work *out* of the run step rather than adding to it:

| | Today | After |
|---|---|---|
| `RunInput` seam returns | `AgentRun` (`{ output, recordPath }`) | `EvalRunInputResult` |
| `EvalCache` stores | `AgentRun` | `EvalRunInputResult` |
| Who reads the record | `runInputViaEval` | `gradeInput` |
| Grader-facing `AgentRun` | `{ output, recordPath }` | `{ output, recordPath, workdir, record }` |

`runInputViaEval` currently reads `eval-record.json` and calls `gradedOutput` itself; both move into `gradeInput`, so the run step just returns the result it already has in hand and gets simpler. `AgentRun` becomes a value the *grading* step constructs, and grows additively — `recordPath` stays alongside the parsed `record`, so a user's class-based grader reading `run.recordPath` keeps working.

Two knock-on effects the implementer must handle, neither optional:

- Every optimizer test that injects the `runInput` seam returns the new shape.
- `docs/dev/writing-optimizers.md` documents that seam as returning `{ output, recordPath }` (line 245) and must be updated.

Everything that stays in `lib/optimize/` after this:

- `targets.ts` — discovering `optimize`-marked declarations
- `sourceMutator.ts` — applying proposed edits
- `baseOptimizer.ts` — the search scaffolding (`proposeValidMutation`, `pickValidationChampion`, `finishPointwise`, `isMaxObjective`, `requireBaselineGatesPass`)
- `optimizers/` — greedy, gepa, example
- `mutator.ts`, `gepaReflect.ts`, `reflectionFeedback.ts` — proposing mutations
- `workspace.ts` — writeback
- `evalCache.ts` — same policy and key; its stored value type becomes `EvalRunInputResult`

That is the set of things that are about *search* rather than *scoring*.

`reflectionFeedback.ts` stays in optimize on purpose: it renders per-input feedback for the mutator prompt, which is part of proposing a change, not part of measuring one.

`gradeBreakdown.ts` moves to the eval layer, because eval's scored summary wants the same per-input view that optimize's report does.

### Public API

Today a grading module imports from `agency-lang/optimize`. After this, someone writing graders for eval should not have to import from `optimize`. So:

- `agency-lang/eval` becomes the home for `grader`, `ExactMatch`, `Contains`, `Similarity`, `LlmJudge`, `BaseGrader`, `Grade`, `Score`, `GraderOptions`, `Input`, `scalar`, `binary`, `goalJudgeFile`, `Scorecard`, and `breakdown`.
- `agency-lang/optimize` re-exports all of them, so every existing grading module keeps working with no edit.
- `agency-lang/optimize` keeps its optimizer-only exports (`BaseOptimizer`, `BaseOptimizerConfig`, `OptimizeTargetSet`, `proposeMutation`, `defaultPreview`, `fileMap`, `renderReflectionFeedback`, `splitInputs`).

This needs a new `exports` entry in `package.json` alongside the existing `./optimize` one.

---

## Not in scope

Each of these came up while designing and is deliberately excluded, to keep this change reviewable. Several are worth doing; they are follow-ups, not omissions.

- **Anything about workdirs.** How they are copied, how large they are, how long they are retained, whether they are pruned. Graders receive the `workdir` path, which is a path to a directory that already exists and already persists — no mechanism changes.
- **The optimizer's caching policy.** What is cached (runs, not grades), the `(workspace, input)` key, and when it is consulted are all unchanged. `gradeRun` and `gradeInput` have no cache awareness. The stored *value type* does change from `AgentRun` to `EvalRunInputResult` — see "How the optimizer consumes it" — but that is a consequence of moving record-reading into the grading step, not a change of caching behavior.
- **Replacing the parent-scorecard lookup in GEPA.** GEPA currently re-evaluates a parent on a minibatch and relies on cache hits, when it could filter the parent's existing `Scorecard` instead — a pattern it already uses in `focus()` for reflection feedback. A separate optimizer cleanup.
- **The optimizer's per-iteration artifact tree.** Source snapshots per iteration, rendered mutation diffs, and the missing mapping from an iteration to its `agent-runs/<ws-key>/` directory. That is about understanding a search, not about scoring.
- **A curated trace API.** No `trace.calledTool()` / `trace.cost()` helper layer. The raw `record` makes it possible; the vocabulary waits for real usage.
- **`agency eval judge`.** Untouched. It stays a standalone pairwise comparison of two finished runs, which answers a different question ("did B beat A") and needs no graders to do it.

---

## Testing

- **Unit, `gradeInput`:** gate short-circuits before advisory graders run; a no-output input scores 0 with a reason; weighting and binary-to-scalar conversion match today's `Scorecard` behavior.
- **Unit, `gradeRun`:** the three input forms (in-memory result, loaded run, directory path) produce identical scorecards for the same run.
- **Unit, `gradeRun` on a failed input:** an input with `status: "error"` scores 0 and is marked gate-failed — including the on-disk case where the run directory has an `error.txt` and **no** `eval-record.json`, which is what `eval grade` on a partially failed run actually encounters.
- **Unit, grader context:** a function grader receives a `workdir` that exists and a `record` whose `metrics` match the eval record on disk.
- **Integration, `eval run`:** grades with the default goal judge when no `--graders` is given; writes a `grading` key in `summary.json`; omits it under `--no-grade`; exits 2 when a `mustPass` grader fails, and when an input errored with graders configured.
- **Integration, `eval grade`:** re-scores a run directory produced by a previous `eval run` with no agent execution, writes `grading.json`, and leaves `summary.json` byte-identical.
- **Regression, optimizer:** the existing `greedyReflective` and `gepa` suites pass, proving the shared `gradeInput` is behavior-preserving.
- **Regression, public API:** a grading module importing from `agency-lang/optimize` still loads and runs.

Existing optimizer tests are the safety net for the move — but they will need real edits, not just import-path rewrites. Every test that injects the `runInput` seam returns `{ output, recordPath }` today and must return an `EvalRunInputResult` instead. Expect that churn; a failing expectation there is the seam change, not a botched move. What should pass untouched is the *assertions* about accept/reject counts, objectives, and champion selection.

---

## Migration and compatibility

- Existing grading modules importing from `agency-lang/optimize` keep working via re-export. No user edit required.
- **`agency eval run` now makes LLM calls by default.** Grading defaults to the bundled goal judge, so a suite that used to cost nothing beyond the agent runs now also pays for one judge call per input. This is the intended behavior change — it is what makes the command able to answer its own question — but it is a cost change, and `--no-grade` restores the old behavior exactly.
- `summary.json` gains a `grading` key by default; under `--no-grade` it is byte-identical to today. Every pre-existing key keeps its name and meaning either way.
- `agency optimize` behavior is unchanged, except that an input producing no output now scores 0 instead of throwing.
- No changes to input suite files. `goal` becomes optional rather than newly required.
- Internal only: the `RunInput` seam and `EvalCache` value type change shape. This affects optimizer tests and `docs/dev/writing-optimizers.md`, not users.
