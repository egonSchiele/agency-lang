# Custom graders, validation sets, and optimize DX

Date: 2026-06-18
Status: Approved design, ready for implementation planning

## Background

The `agency optimize` command (CLI path: `evalOptimize` → `BaseOptimizer` → a
registered optimizer such as `greedy`/`gepa`) searches for better values of
`optimize`-annotated targets in an agent, scored by a set of graders.

Today the only grading the user can reach is a single hardcoded `LlmJudge`,
fed by a `goal` string that the CLI maps from each task into `metadata.goal`.
This produced a concrete failure: optimizing `"What is the area of ${country}?"`
toward the goal of returning capitals, the optimizer never changed "area" to
"capital." Instead it appended an answer key to the prompt
(`"… Brazil (for Brasília), India (for New Delhi), Japan (for Tokyo) …"`), the
agent echoed those city names inside a still-area-framed answer, and the soft
LLM judge gave rising partial credit. The objective climbed to 0.767 without
the task ever being solved — a gameable proxy metric, amplified by a tiny task
set (answers enumerable) and by grading on the same tasks being optimized
(no held-out set).

Three root causes, three fixes:

1. **The grading surface is "configuration over composition."** Users must
   learn a magic task shape (`goal` → `metadata.goal` → `LlmJudge.goalPath`)
   with no feedback about whether they wired it correctly, and in exchange they
   get *less* power than writing code. They can't pick a different grader
   (e.g. exact-match against a known capital), can't compose graders, and build
   no reusable knowledge. Fix: make composition the real path — users write
   TypeScript that defines grading.
2. **No held-out validation set.** A prompt that memorizes train answers scores
   just as well as one that generalizes. Fix: a validation set; train drives
   search, validation picks the champion.
3. **The run is opaque.** A user can't tell whether the judge even read the
   goal correctly without digging through a flat pile of run files. Fix: echo
   the resolved setup, fail fast on misconfiguration, and surface a per-task
   grade breakdown plus a headline report.

## Goals

- Let users define grading in TypeScript by composing built-in graders or
  writing plain metric functions, with tasks of any shape.
- Keep a dead-simple default (`--goal` + `--tasks`) for the trivial case.
- Add a validation set so overfitting/reward-hacking is caught and visible.
- Make a run legible: resolved setup echoed up front, fail-fast on
  misconfiguration, per-task grade breakdown, and a headline `report.md`.

## Non-goals

- The `loop.ts`/`artifacts.ts` optimize path used by `lib/stdlib/agencyEval.ts`
  (agency-callable optimize). This work targets the CLI/`BaseOptimizer` path.
- The broader `EvalTask`/`Input` nomenclature cleanup (tracked separately).
- New CLI ergonomics beyond the flags listed below. The TS path is where DX
  investment goes; the CLI stays a thin on-ramp.

## Design

### 1. Configuration surface

Canonical home is an `eval.optimize` section in `agency.json`:

```jsonc
{
  "eval": {
    "optimize": {
      "goal": "Return the capital of the given country.",
      "graders": "./grading.ts",
      "validation": { "tasks": "./validation-tasks.json" }
      // or: "validation": { "split": 0.3 }
    }
  }
}
```

CLI flags map onto the same config and override it. The previously
mutually-exclusive `--goal` and `--tasks` become **combinable**: `--goal` sets
the overall goal, `--tasks` provides the per-task data.

| Flag | Meaning |
| --- | --- |
| `--goal <string>` | Overall goal, applied to every task (default grader only). |
| `--tasks <file>` | Per-task data file. |
| `--graders <file>` | Path to a TS grading module. |
| `--validation-tasks <file>` | Held-out validation tasks. |
| `--validation-split <ratio>` | Seeded split of the train tasks (used only if `--validation-tasks` absent). |

### 2. Custom grader module (the core)

A grading module is a TypeScript file loaded by the CLI:
**esbuild-transpile the file to a temp `.js`, then `await import()` it** — the
same CLI-layer pattern already used to load compiled user agents in
`serve.ts`/`debug.ts`/`coverage.ts`. (The "no dynamic imports" rule governs
generated/runtime code, not the CLI loading user artifacts.)

The module **default-exports one grader or an array of graders.** A "grader" is
any of four forms:

```ts
import { grader, ExactMatch, LlmJudge, type Grader } from "agency-lang/optimize";

// (a) a metric function: ctx = { output, task, judge }
//     `task` is the raw task object you authored — any shape, no magic keys.
const exact: Grader = ({ output, task }) =>
  output === task.expectedCapital ? 1 : 0;          // number (0..1), boolean, or {score, feedback}

// (b) a wrapped function carrying policy
const gate = grader(exact, { mustPass: true, name: "capital-exact" });

// (c) a built-in instance (declarative)
const judge = new LlmJudge({ goal: "Return the capital.", weight: 0.5, samples: 3 });

// (d) a BaseGrader subclass (full custom behavior + state) — rare escape hatch

export default [gate, judge];   // or `export default exact` for the simple case
```

- A bare function answers "how do I score this?" (the metric). The
  wrapper/instance answers "…and what role does that score play?" — the policy
  knobs `BaseGrader` already provides: `mustPass` (hard gate; failure
  short-circuits advisory graders for that input), `threshold`, `weight`,
  `inputScope` (`{tag}`/`{ids}`), `samples` (k-repeat + aggregate, for noisy
  LLM judges), `name`.
- Functions are adapted into a single-grade `BaseGrader` internally, so
  everything downstream — `Scorecard`, gating, weighting, reporting — is
  unchanged. A single grader is just an array of one.
- `judge({ goal, output })` in `ctx` runs the bundled goal judge agent so users
  get LLM grading from inside a function without instantiating `LlmJudge`.

**Raw task preservation.** Today the task→`Input` mapping keeps only
`task_id`/`goal`/`args`/`node` and drops extra keys. This work preserves the
full authored task object end-to-end and hands it to graders as `ctx.task`.
`args` (and optional `node`) still drive the agent run; every other field is
freeform and grader-defined.

### 3. Default behavior (no grader file)

When no grading module is configured, fall back to today's single built-in
`LlmJudge`, fed by `--goal`/`eval.optimize.goal` (applied to every task) or a
per-task `goal` field. This subsumes the "overall goal + per-task goals"
feature: overall goal = `--goal`; per-task goal = a `goal` field the default
judge reads. Anything fancier → write a grading module.

### 4. Validation set

- **Provisioning:** `--validation-tasks <file>` if given; otherwise the
  optional seeded `--validation-split <ratio>`; otherwise no validation set.
  Both are also expressible under `eval.optimize.validation`.
- **Role:** search and candidate acceptance run on the **train** tasks. The
  champion written back is the one with the best **validation** objective. Each
  iteration's report shows train-vs-validation objective side by side, so
  divergence (train climbing while validation stays flat = overfitting /
  reward-hacking) is visible at a glance.
- When no validation set exists, behavior matches today (champion chosen by
  train objective), and the report says validation was not configured.

### 5. DX / run-directory overhaul

Targets the `BaseOptimizer` + `reporter.ts` path (the live CLI path), not the
`loop.ts`/`artifacts.ts` stdlib path.

1. **Startup echo (console).** Before optimizing, print the resolved grading
   setup — which graders are active, what each reads — and the first resolved
   task's relevant fields. Answers "is it wired right?" immediately.
2. **Eager fail-fast validation.** Dry-check the grader setup against the first
   task before the run: a `matchOn` that doesn't resolve, a grading module that
   doesn't export a valid shape, a judge file that won't compile. Fail with a
   clear message naming the grader and the fix, not a mid-run stack trace.
3. **Per-task grade breakdown.** For each scored candidate, write a readable
   record: per task, the agent output plus each grader's score and feedback.
   This is the artifact that makes reward-hacking obvious ("judge scored 0.7
   because the city name appears; output is still area-framed").
4. **Headline `report.md`.** One file to open: resolved setup, per-iteration
   train-vs-validation objective + decision + rationale, and the champion's
   per-task breakdown. Keep `summary.json` as the machine-readable sibling.
   Move the raw per-iteration files under an `iterations/` subdirectory so the
   run-dir top level is just `report.md`, `summary.json`, `champion/`,
   `iterations/`.

## Build order

1. **Grader module** — esbuild loader, the four export forms + `grader()`
   wrapper, the public `agency-lang/optimize` surface, raw-task preservation,
   and the default-fallback wiring.
2. **DX / run-dir** — startup echo, eager validation, per-task grade breakdown,
   `report.md` + layout tidy. (Depends on grader output existing.)
3. **Validation set** — provisioning (file + split), train-drives-search /
   val-picks-champion role, train-vs-val reporting.

Graders come first because the breakdown, report, and validation reporting all
consume grader output.

## Testing

- Unit: the function→`BaseGrader` adapter; `grader()` wrapper policy
  pass-through; the esbuild load + export-shape validation (valid forms accepted,
  bad shapes rejected with clear errors); raw-task preservation through the
  mapping; train/val split determinism under a seed; champion selection by val
  objective.
- Integration: `agency optimize` with a grading module that exact-matches a
  per-task `expectedCapital`, confirming the area-prompt is correctly scored
  low and the optimizer is pushed toward changing "area" → "capital".
- Avoid extra LLM calls; verify judge wiring with the deterministic LLM mock
  where possible, reserving a single real e2e run for confidence.

## Open questions for the plan

- Exact public export path/name (`agency-lang/optimize`) and how it resolves
  from a user's project.
- Whether `--validation-split` splits before or after any task shuffling, and
  the seed source.
- Whether the startup echo and `report.md` should also render in the existing
  `reporter` verbosity tiers or be unconditional artifacts.
