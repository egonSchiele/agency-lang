# Eval Criteria: anchoring the judge with shared grading standards

**Date:** 2026-06-13
**Status:** Design (approved, pending implementation plan)

## Summary

Add an optional, suite-level `criteria` field to the eval system: a list of
plaintext grading standards that anchor the pairwise judge so its verdicts —
and therefore `agency eval optimize`'s improvements — reflect the user's own
standards rather than the judge's unguided taste.

This is purely a *judge-anchoring* feature (DSPy/RAGAS terminology:
"LLM-as-judge with a rubric"). It introduces **no ground truth, no expected
outputs, and no new pointwise eval mode.** The judge stays pairwise; criteria
just sharpen its comparisons.

## Motivation

Today an eval task is a `goal` (plaintext intent) plus `node` + `args`. The
pairwise judge (`judgePairwise.agency`) sees only the goal and two candidate
outputs and picks the better one. There is no way to tell the judge *what the
user considers good or bad*.

Concretely: a user writing a TypeScript refactoring agent wants the judge to
prefer outputs that follow their house style (the standards in
`docs/dev/anti-patterns.md` — prefer pure transformations, never use `any`,
surface errors, objects-not-Maps, etc.). With only a goal of "refactor this,"
the judge might happily prefer a `Map`-based or error-swallowing output, and
`optimize` would then evolve the agent's prompt in the wrong direction.

`criteria` closes that gap: shared standards the judge applies to every output.

### Why this beats "just put the criteria in the agent's prompt yourself"

A criterion describes the **destination** (a property of good output). A prompt
is the **route** (an instruction that *causes* a model to produce that output).
They are not the same text, and the gap between them is what `optimize`
searches:

1. **The criterion says *what*, not *how*.** "Surface errors, don't swallow
   them" as a verbatim instruction makes a model over-correct (try/catch
   everywhere). The optimizer, watching that failure through the judge, can
   discover the better instruction — "let errors propagate by default; only
   catch when you can meaningfully recover" — which encodes the *when* the
   criterion omits. The optimizer watches the model fail; the author does not.
2. **The optimizer optimizes against the judge, and the judge knows more than
   the criteria list** (it also has the goal and a holistic sense of quality).
   So the discovered prompt captures the written criteria *plus* whatever else
   made one output beat another.
3. **Phrasing matters and shorter can beat longer.** Which wording actually
   moves a given model is an empirical search problem; the optimizer prunes and
   tunes where a hand-pasted checklist accumulates.

This is why criteria are **judge-only** (see Non-Goals): handing them to the
mutator would let it win by *pasting the rubric verbatim*, reproducing the
hand-written floor instead of beating it.

## Data model

### Normalization rule (used everywhere)

A **criterion source** is a string:

- If it starts with `@`, the remainder is a **file path**, and the file's
  **entire contents are loaded as one criterion**, verbatim. No splitting on
  lines/headers, no extension-based parsing. `@` means "inline this file's text
  here" and never fans out into multiple criteria.
- Otherwise the string is **inline criterion text**.

Everything normalizes to a resolved `string[]`.

To allow a literal leading `@` in inline text, an escape of `@@` at the start
yields a literal `@` (minor; can be deferred if it complicates v1).

### Task file

`criteria` is a **suite-level** sibling of `tasks` (shared across all tasks in
the suite). It accepts a string *or* an array; array elements may freely mix
inline text and `@path`:

```json
{
  "criteria": [
    "Never use `any`",
    "@./standards.md"
  ],
  "tasks": [
    { "goal": "Refactor this reducer to avoid mutation", "args": { "code": "..." } }
  ]
}
```

- `@path` resolves **relative to the task file's directory** (consistent with
  how `working_dir` already resolves via `path.dirname(filePath)`).
- A bare string (`"criteria": "Never use any"`) is shorthand for a
  one-element array.
- The resolved `string[]` is attached to **each** `EvalTask` during loading
  (denormalized onto tasks; see Implementation).

### Command line

A **repeatable** `--criteria` flag. Each occurrence is a single criterion
source (inline or `@path`); multiple occurrences build the array:

```bash
agency eval optimize main.agency --goal "Refactor for purity" \
  --criteria "Never use \`any\`" \
  --criteria "@./docs/dev/anti-patterns.md"
```

- `@path` resolves **relative to cwd** on the CLI.
- Available on `eval optimize` and `eval judge` (the commands that run a
  judge). **Not** on `eval run` — it has no judge, so criteria would be inert.
- Passing `--criteria` together with `--tasks` is an **error**: `--criteria`
  is the companion to the `--goal` ad-hoc single-task path; `--tasks` files
  carry their own criteria. Erroring avoids an ambiguous append-vs-override
  precedence rule.

## Consumers

### Judge (changed)

Criteria thread into the pairwise judge prompt as explicit grading standards.

- `lib/agents/judgePairwise.agency`: add a `criteria` parameter (rendered
  string, default `""`) and incorporate it into the prompt as the standards the
  judge must apply when comparing the two responses.
- `lib/eval/judge/pairwise.ts` (`judgePair` / `runPairwiseJudge`) and
  `lib/eval/judge/suite.ts` (`judgeSuite`): accept and pass criteria through
  from the task to the judge call.
- When a task has no criteria, the rendered value is empty and judge behavior
  is identical to today (backward compatible).

### Mutator (deliberately unchanged)

The mutator (`lib/optimize/mutator.ts`, `lib/agents/mutatePrompt.agency`) does
**not** receive criteria. This is a load-bearing non-change, not an oversight:
fencing criteria off to the judge forces the mutator to *discover the
instruction* from the judge's behavioral feedback (`lossReasons` already flow
into mutation history) rather than *copy the rubric*. Any future change that
wires criteria into the mutator must justify itself against the value
proposition above.

## Non-goals (v1)

- **No separate `examples` field.** Good/bad examples are the same kind of
  judge-only signal as criteria (showing vs telling) and can be written inline
  within a criterion string (e.g. ``"Prefer pure transforms, e.g. `arr.reduce(...)` not `arr.forEach(x => mutate)`"``). A
  dedicated few-shot/whole-output exemplar surface is deferred until a concrete
  use case demands it.
- **No per-criterion pass/fail reporting.** The judge returns its existing
  holistic verdict; it does not report which individual criterion failed.
- **No per-task criteria.** Criteria are suite-level only. (Per-task criteria
  with a merge rule is a possible future extension.)
- **No Direction-2 reference grading.** No expected outputs, labels, graders,
  or accuracy metrics. The judge stays pairwise/comparative.
- **Not reviving `rubric`.** The loader's existing `rubric` guard rejects a
  legacy field name (an *alternative to* `goal`); it is unrelated to the
  additive, shared `criteria` introduced here and stays as-is.

## Implementation touch points

| Area | File(s) | Change |
| --- | --- | --- |
| Type | `lib/eval/runTypes.ts` | Add `criteria?: string[]` to `EvalTask` (resolved, post-normalization). |
| Loader | `lib/eval/loadTasks.ts` (+ `.test.ts`) | Parse suite-level `criteria` (string \| array), resolve `@path` relative to file dir, load file contents, attach resolved `string[]` to each task. Extend `taskFromGoal` to accept resolved criteria for the CLI path. |
| CLI | `scripts/agency.ts`, `lib/cli/eval/optimize.ts`, `lib/cli/evalJudge.ts` | Add repeatable `--criteria` flag; resolve `@path` relative to cwd; error when combined with `--tasks`; wire into `taskFromGoal`. |
| Judge | `lib/eval/judge/pairwise.ts`, `lib/eval/judge/suite.ts`, `lib/agents/judgePairwise.agency` | Add `criteria` param; render the array into the judge prompt; pass through from task. Run `make` to rebuild stdlib. |
| Docs | eval task-file / CLI reference under `docs/site/` | Document the `criteria` field, the `@path` convention, and the flag. |
| Tests | `lib/eval/loadTasks.test.ts`, judge tests | Loader: string/array forms, `@path` resolution, mixed elements, `--criteria` + `--tasks` error. Judge: criteria reach the prompt (mockable via per-agent scoped LLM mocks). |

### On attaching criteria to tasks

The loader currently returns `EvalTask[]` (no suite wrapper object). The
minimal-blast-radius approach is to **denormalize** the resolved suite-level
`criteria` onto each `EvalTask` so downstream consumers (`judgeSuite` →
`judgePair`) read `task.criteria` without any new plumbing. An alternative —
returning a `{ criteria, tasks }` suite object — is "more correct" but changes
the loader's return type and touches every caller; deferred unless the plan
finds a reason to prefer it.

## Backward compatibility

`criteria` is optional everywhere. Existing task files and CLI invocations are
unaffected; when criteria are absent the judge prompt's criteria section is
empty and behavior is byte-for-byte today's behavior.

## Worked example

A TypeScript refactoring agent optimized against the project's anti-patterns:

```json
{
  "criteria": [
    "Prefer pure, immutable transformations (map/reduce/filter) over loops that mutate external state",
    "Never use `any`; introduce precise types instead",
    "Surface errors; never swallow them in an empty catch",
    "@./docs/dev/anti-patterns.md"
  ],
  "tasks": [
    { "goal": "Refactor this reducer to avoid mutation", "args": { "code": "..." } },
    { "goal": "Replace the any types here", "args": { "code": "..." } }
  ]
}
```

`optimize` mutates the agent's `optimize const systemPrompt`, the judge scores
each candidate against these shared criteria, and the prompt converges toward
producing code that satisfies the standards — discovering effective
*instructions*, not merely restating the criteria.
