# Review: labeling agent outputs

Review of `2026-08-02-eval-labeling-design.md`, 2026-08-03.

## Verdict

**Revise the persistence model before planning implementation.** The interaction
design is convincing: binary questions plus explicit sign-off, soft deletion,
staleness after criteria additions, and a draft separate from completed labels
all survived actual use. Those decisions should stand.

The durable data model does not yet preserve the things the spec says are
valuable. In particular, text-only identity merges outputs that had different
tasks, overwriting a checklist file destroys the old checklist versions, and
the proposed latest-row fold loses answers when a question is deleted and later
restored. The first three findings below need design changes. Findings 4 and 5
need explicit policies so implementation does not make data-loss decisions by
accident.

I checked the proposal against the current run artifacts and readers in
`lib/eval/readRun.ts`, `lib/eval/runTypes.ts`, `lib/eval/runArtifacts.ts`,
`lib/eval/types.ts`, `lib/eval/grading/gradeRun.ts`, `lib/eval/judge/selectFinalResponse.ts`,
and `lib/config.ts`. I also checked the prototype's `labelSession.ts` and TUI on
`adit/proto-eval-label`.

## 1. Blocking: text hashes are not output identities

The problem statement says that a label belongs to one output and that two runs
of the same input produce two outputs worth retaining. The design then makes
`outputId` a hash of text and says identical text from different runs collapses
to one entry. Those are incompatible identity rules.

Text alone is also insufficient even if deduplication is wanted. The judgement
depends on what the agent was asked:

- `"Looks good"` is not the same example under “Review this patch” and “Write a
  release announcement.”
- “Is it actually today's news?” depends on the task and capture time.
- `Input.task` is `string | Record<string, any>`, not always a string.
- The output value may be structured JSON, not text.

Keeping only the first provenance row makes this worse. Later occurrences
disappear, so the dataset cannot answer whether two agents emitted the same
thing or whether repeated outputs correlate with a model or agent revision.

**Recommendation:** separate occurrence identity from content identity.

```jsonc
{
  "schemaVersion": 1,
  "outputId": "out:<stable occurrence id>",
  "contentHash": "sha256:<canonical task + output hash>",
  "input": { "task": "What are today's top stories?" },
  "value": "Here are today's top stories…",
  "text": "Here are today's top stories…",
  "capturedAt": "2026-08-02T04:50:17Z",
  "provenance": { "runId": "proto-news", "inputId": "top-stories" }
}
```

`outputId` should identify a captured run/input/output occurrence. `contentHash`
can support deduplication, searching, and duplicate warnings without erasing
occurrences. Recapturing the same source run must be idempotent, while capturing
a different run must retain a separate occurrence even when its bytes match.

If the intended dataset unit is instead a unique `(task, output)` pair, state
that explicitly and hash the canonical pair. A hash of display text alone is
not a sound choice under either interpretation.

## 2. Blocking: an incremented mutable file is not checklist history

The checklist records `version: 3`, and annotations record that integer, but the
TUI rewrites the one checklist file. After version 4 exists, nothing reconstructs
version 3:

- which questions were live;
- which questions were deleted;
- what each weight was;
- whether a question was deleted, restored, and deleted again.

Keeping every question in the current file preserves its definition, but not
the state of the checklist at each version. That means a historical annotation
cannot be interpreted exactly, and later agreement measurements cannot reproduce
the rubric the human used.

**Recommendation:** store an immutable full snapshot for every revision. Either
of these layouts works:

```text
checklists/news-quality/1.json
checklists/news-quality/2.json
checklists/news-quality/3.json
checklists/news-quality/current.json
```

or one append-only `checklists.jsonl` row containing the complete snapshot for
each revision. An annotation should carry `checklistId`, `checklistVersion`, and
`checklistHash`. The name is display metadata, not sufficient identity.

Question IDs must be immutable and never reused. Changing a question's text or
meaning requires a new ID. Changing a weight also creates a new checklist
revision; the spec currently prohibits text edits but says nothing about weight
edits.

## 3. Blocking: “latest annotation wins” loses restored answers

The proposed reader takes the latest row per
`(outputId, checklist, annotator)`. That breaks the soft-delete guarantee.

For example:

1. Version 1 has `accurate` and `sourced`; the annotator answers both.
2. Version 2 deletes `sourced`; the annotator signs the output off again.
3. Version 3 restores `sourced`.

If the version-2 row contains only live questions and replaces the effective
version-1 row, the old `sourced` answer vanishes. The item becomes stale even
though the design promises that undeleting restores all prior work. The current
annotation example also omits the `coveredQuestionIds` that the Staleness
section says sign-off records.

**Recommendation:** define the effective label per question, not per annotation
row.

- Every sign-off records `coveredQuestionIds`.
- `answers` contains an explicit boolean for every covered question.
- A missing answer means “not judged,” never `false`.
- For each question, the effective answer is the newest annotation from that
  annotator that covered that question.
- An item is stale if any currently live question has no effective covered
  answer.
- Restoring the same immutable question ID restores its prior effective answer.

This keeps item-level append-only annotations while preserving the useful
answer history. It also defines scoring: a stale item's current score should be
`null` or visibly “needs review,” rather than treating missing answers as failed
criteria. Once all live questions are covered, compute the weighted score from
their effective answers.

The fold key must also include the actual annotator identity. The spec defines
`annotator: "human"` and `annotatorId: "adit"` but folds only on `annotator`.
That would merge all humans. It would later merge every LLM judge regardless of
prompt, model, or revision. Use
`(outputId, checklistId, annotatorKind, annotatorId)`; a machine
`annotatorId` should identify one judge configuration and revision.

## 4. Must specify: current eval outputs are not necessarily complete text

The prototype calls `String(last.value)`. For an object, that stores and shows
`"[object Object]"`, merging unrelated structured outputs. The production eval
contract is broader:

- `EvalValue.value` is `unknown` after JSON round-tripping.
- The extractor can truncate large values and marks them with
  `truncated: true`.
- A successful filesystem-oriented run can legitimately have no output value.
- A failed run can have a salvaged eval record, but grading deliberately does
  not treat that record as a successful output.
- `readEvalRun` distinguishes `ok`, `failed`, and `missing` inputs.

The label command needs one explicit capture policy. I recommend v1 do this:

1. Use the existing final-response selection semantics rather than duplicating
   an ad hoc “last output” reader.
2. Capture only an `ok` input with a readable record and a present final output.
3. Report failed, missing, and no-output inputs as skipped. Never turn
   `"(no output recorded)"` into corpus content.
4. Store the raw JSON value and the deterministic text projection used by the
   TUI. `selectFinalResponse` already uses the sensible rule: strings stay
   strings; other values use `JSON.stringify`.
5. Reject truncated outputs in v1 with an actionable message. Alternatively,
   persist `truncated: true` prominently and state that the label applies only
   to the copied truncation, not the original output.

The provenance example also does not match the artifacts exactly.
`config.json` has a run-level ISO `startedAt`; per-input `startedAtMs` and
`models` live in record/summary metrics. `agentLabel` is explicitly a display
label, while reproducibility data lives in `config.json.provenance.agent`.
Copy the latter if agent provenance matters.

## 5. Must specify: sign-off spans multiple files without a commit protocol

The prototype atomically replaces one draft file. The proposed version updates
the draft, appends `labels.jsonl`, may append `outputs.jsonl`, and can create a
new checklist revision. The order now matters:

- append the annotation, then crash before advancing the draft: resume may
  append a duplicate that looks like an intentional relabel;
- advance the draft, then crash before appending: a completed judgement is
  lost;
- start two sessions: both can append the same output or create the same next
  checklist version;
- crash during an append: a malformed final JSONL row can corrupt the next
  append too.

“No multi-annotator support” does not prevent the owner from accidentally
opening two terminals. The store needs a minimal integrity protocol even in v1.

**Recommendation:**

- Take an exclusive store/checklist writer lock and fail clearly when another
  labeling session owns it.
- Give every annotation an `annotationId` generated before sign-off.
- Put a complete pending annotation in the atomically rewritten draft, append
  that same ID, then mark the pending commit complete. Resume retries the same
  ID idempotently.
- Capture outputs before labels so an annotation never references a missing
  corpus row.
- Validate JSONL strictly on startup. Define recovery for one malformed final
  line; do not silently skip malformed human data or append after it.

The draft must be keyed by `outputId`, not `inputId`, and bound to the ordered
source output IDs, checklist ID/revision, and annotator ID. Otherwise resuming a
draft against another run with the same input IDs can attach answers to changed
outputs. Derived scores do not need to be persisted in the draft.

## 6. Smaller design gaps

### The config field does not exist yet

The command says `--store` falls back to `eval.labelStore`, but `AgencyConfig`
and `AgencyConfigSchema` do not declare that field. The implementation plan must
add it to both. The spec should also say whether a relative path is resolved
from the invocation's working directory, like the current `runsDir`, or from the
directory containing `agency.json`.

### Adding a weighted question has no interaction

The prototype adds question text only, while the production checklist requires
a weight. Decide whether `a` asks for both text and weight or assigns a default
weight of 1. A default is the smaller v1 interaction. Also define that weights
must be finite and positive and what the score is when there are no live
questions.

### Long-lived rows need schema versions and strict validation

These files are intended to outlive runs and compiler revisions. Add
`schemaVersion` to corpus, annotation, and checklist records, or add a store
manifest that versions each file format. Validate unique IDs, annotation-to-output
references, annotation-to-checklist-version references, known question IDs,
complete covered answers, and valid weights. A durable human dataset should fail
loudly on corruption rather than use the tolerant “warn and continue” policy
that grading uses after an expensive run.

### Define time semantics

`leadTimeMs` needs a rule across resume. Wall time since first opening can become
days after a paused session; active interaction time is more meaningful but
requires the draft to accumulate it. Either is acceptable if recorded honestly.

## What is already right

- Separating copied outputs from annotations is the correct durable boundary.
- Separating drafts from completed annotations is the right write-amplification
  fix and makes sign-off meaningful.
- Append-only human history is worth preserving and should remain the core
  storage rule.
- Recording covered question IDs rather than a count is necessary for exact
  staleness.
- Soft deletion is the correct operation for criteria drift.
- Keeping high-volume machine annotations out of the human-label file preserves
  the value and reviewability of the human dataset.
- Deferring judges, agreement measurement, active learning, and pairwise UI
  keeps v1 focused.

## Suggested revision order

1. Define immutable identities for an output occurrence, checklist lineage and
   revision, question, annotation, and annotator.
2. Replace the mutable checklist version with immutable revision snapshots.
3. Specify the per-question fold, staleness, and stale-score semantics.
4. Specify source eligibility and structured/truncated output handling against
   the current eval record contract.
5. Add the minimal lock and crash-recovery protocol.
6. Update the JSON examples; after that, the implementation plan can derive
   directly from the formats instead of inventing their semantics.

I did not independently audit the external research numbers or vendor retention
claims. This review covers whether the proposed Agency design preserves its own
stated data and composes with the current eval artifacts.
