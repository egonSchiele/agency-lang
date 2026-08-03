# Labeling agent outputs: building a dataset of human judgements

> **Revision 2** (2026-08-03), after review in
> `2026-08-02-eval-labeling-design-REVIEW.md`. The interaction design is
> unchanged. The persistence model is substantially rewritten: identities are
> now explicit, checklist revisions are immutable snapshots, the annotation fold
> is per-question rather than per-row, output capture is defined against the
> real eval-record contract, and sign-off has a commit protocol.

## Background: why this exists at all

The eval framework can already tell you whether an agent produced the right
file, the right number, or a passing test. Everything in `evals/smoke` and
`evals/terminal-bench-mini` works that way: a grader reads the workdir, checks
something exact, and returns pass or fail. That covers a real and important
class of task, and it is the class terminal-bench is built from.

It does not cover the tasks the owner actually relies on day to day. "Get me
today's news" has no exact answer. Neither does "write this in my style", or
"review this code well". For those, the only thing that says whether the agent
did well is a person looking at the output and forming an opinion. There is no
file to stat and no string to compare.

The obvious response — have a human grade every run — does not scale, and more
importantly it is not what practitioners actually do. The research (Shreya
Shankar and Ian Arawjo's "Who Validates the Validators?", and Hamel Husain and
Shreya Shankar's evals guide) describes a different loop. A person labels a
modest number of outputs by hand. Those labels become the calibration data for
an automated judge. The judge is then measured against the labels, per
criterion, and only the criteria it handles well get automated. Human effort is
front-loaded — on the order of 100 outputs to start and 10–20 a week after —
rather than perpetual.

That reframes what we are building. **The human is not grading the agent. The
human is producing training data for a grader.** The distinction matters for
storage, for what metadata we keep, and for what the artifact is worth: a score
for one run expires the moment the agent changes, but the pairing of "this
output, and what a person thought of it" stays useful forever, across every
future agent.

Two findings shape the design and are worth stating up front because they are
counter-intuitive.

**Criteria drift.** The Shankar/Arawjo paper documents a catch-22: to grade
outputs you need to have externalised your criteria, but grading is how you
discover your criteria. Their study participants kept refining their standards
as they graded, and went back to change earlier grades. A rubric written in
advance is close to worthless. The tool therefore has to make changing your
mind cheap and has to record that you changed it.

**Subjective style is the hardest case for automation.** WritingPreferenceBench
measured judges on subjective writing preference with objective quality held
constant: standard reward models scored 52.7% and zero-shot LLM judges 53.9% —
coin flips. Judges that reasoned explicitly before answering scored 81.8%. So
some criteria will automate and some will not, and which is which cannot be
guessed. It has to be measured. That measurement is a later stage, but it is
the reason this stage exists.

## What has already been decided, and by whom

A prototype was built on branch `adit/proto-eval-label` (worktree
`worktree-label-prototype`) and driven by the owner over several rounds. The
following are settled by use, not by argument, and the review confirmed they
should stand:

- **A checklist of binary questions, not a single score.** The owner rejected
  pure pass/fail because it gives an agent no gradient — a run that improves but
  still fails looks identical to one that did not improve. A 1–5 scale was
  offered and passed over in favour of several yes/no questions, which give both
  a gradient (fraction answered yes) and a diagnosis (which specific question
  flipped). Practitioner guidance favours binary for each individual judgement;
  the checklist keeps that while recovering the gradient.
- **Space toggles a checkbox.** Not y/n/u. Unticked is the resting state, so
  "this failed" and "I skipped it" cost the same keystrokes.
- **`enter` signs an item off** and moves to the next. Confirmed as feeling
  right rather than a chore. This is the only thing that distinguishes "I looked
  and it failed" from "I never looked".
- **Questions can be added mid-session and soft-deleted.** Deleting keeps every
  answer already recorded against the question, so undeleting restores the work.
  Neither direction can cost labels.
- **Arrow keys for navigation, vim keys for scrolling.** Cmd+arrow is not
  bindable; terminals do not transmit the Cmd modifier.
- **Markdown syntax highlighting**, with a guard that falls back to plain text
  if rendering loses content.

## The problem this spec solves

The prototype answered its question. What it does not have is anywhere durable
to put the result:

1. **Labels live inside a run directory.** Run directories are disposable. The
   labelled dataset must outlive any particular run, and deleting `runs/` must
   not destroy it.
2. **The checklist is a hardcoded constant.** There is no way to start a
   labelling session over a different corpus with different questions.
3. **A label is written as though it belongs to a test case.** It does not. It
   belongs to one *output occurrence*. The same input run twice produces two
   outputs needing two verdicts, and both are worth keeping.
4. **There is no history.** Relabelling overwrites. That destroys the single
   most useful signal for a person whose criteria are still moving: the ability
   to distinguish "the agent got worse" from "I got pickier".

## Identities

Every durable reference in the store is one of these. They are immutable and
never reused. Getting this list wrong is how the dataset silently stops meaning
what it says, so it is stated before the formats.

| Identity | What it names | Rule |
|---|---|---|
| `outputId` | One captured **occurrence**: a specific output from a specific run and input | Stable across recapture of the same source; a different run is always a different occurrence, even if the bytes match |
| `contentHash` | The **content**: canonical hash of `(task, value)` together | For deduplication, search and duplicate warnings only. Never an identity |
| `checklistId` | A checklist **lineage** over time | The `name` is display metadata, not identity |
| `checklistVersion` + `checklistHash` | One immutable **revision** of a checklist | Every revision is a full snapshot |
| `questionId` | One question's **meaning** | Changing text or meaning requires a new id. Reuse is forbidden |
| `annotationId` | One sign-off event | Generated before the write, so a retried commit is idempotent |
| `annotatorKind` + `annotatorId` | Who judged | `human`/`llm`/`code` plus a specific person, or a specific judge configuration *and revision* |

**Why occurrence rather than content.** The first draft hashed output text and
merged identical text into one entry. The review showed that contradicts the
problem statement: two runs of the same input are supposed to yield two
retained outputs. Text alone is also insufficient — `"Looks good"` is a
different example under "Review this patch" than under "Write a release
announcement", `Input.task` is `string | Record<string, any>` and not always a
string (`lib/eval/runTypes.ts:19`), and an output value may be structured JSON
rather than text. Keeping only the first occurrence's provenance would also
make the dataset unable to answer whether repeated outputs correlate with a
model or agent revision.

## Design

### The store

Three concerns, outside `runs/`, because traces expire and datasets must not.
Industry practice is consistent: LangSmith defaults trace retention to three
days and documents adding data to a dataset as the way to keep it — datasets
persist indefinitely even after the source trace is deleted, and they hold
*copies* rather than pointers.

```text
<store>/
  manifest.json           # store schema versions
  outputs.jsonl           # the corpus: copied outputs, append-only
  labels.jsonl            # human annotations, append-only
  machine-labels.jsonl    # judge annotations, append-only (written later, by stage 3)
  checklists/<checklistId>/<version>.json    # immutable revision snapshots
  checklists/<checklistId>/current.json      # pointer to the newest revision
  drafts/<sessionId>.json # in-progress sessions, rewritten in place
```

### Corpus rows

```jsonc
{ "schemaVersion": 1,
  "outputId": "out_9f3c1a2b",
  "contentHash": "sha256:4e1d…",
  "capturedAt": "2026-08-02T04:50:17Z",
  "input": { "inputId": "top-stories", "task": "What are the top news stories today?" },
  "value": "Here are today's top stories…",
  "provenance": { "runId": "proto-news", "runStartedAtMs": 1785645017340,
                  "agent": { "kind": "file", "entry": "news.agency", "node": "main",
                             "files": { "news.agency": "sha256:…" } },
                  "models": ["gpt-4o"] } }
```

`value` is the raw JSON value. `text` is stored **only when the text projection
differs from `value`** — that is, for non-string outputs. This is a deliberate
departure from the review's example, which stored both unconditionally: for
string outputs, which are the common case, that doubles the largest field for
no benefit. Storing it only when it differs keeps the guarantee the review was
protecting — the label applies to exactly what was displayed, even if the
projection changes later — at half the cost.

Agent provenance is copied from `config.json`'s `provenance.agent`, not from
`agentLabel`, which the codebase documents as a display label
(`lib/eval/runTypes.ts`). Per-input `models` and `startedAtMs` come from record
metrics, not from `config.json`'s run-level `startedAt`.

### Capture policy

The prototype's `String(last.value)` is wrong: for an object it stores
`"[object Object]"`, which merges unrelated structured outputs into one
meaningless string. This exact bug appeared during prototyping.

Capture uses the existing reader, `selectFinalResponse`
(`lib/eval/judge/selectFinalResponse.ts`), whose projection rule is already
correct — strings pass through, everything else is `JSON.stringify`ed — rather
than a second ad-hoc one. Rules:

1. Capture only inputs that `readEvalRun` reports as `ok`, with a readable
   record and a present final output.
2. Failed, missing and no-output inputs are **skipped and reported**, with a
   per-input reason. `"(no output recorded)"` must never become corpus content.
   A successful filesystem-oriented run legitimately has no output value; a
   failed run may have a salvaged record that grading deliberately refuses to
   treat as a result, and capture refuses it for the same reason.
3. A `truncated: true` output is **rejected in v1** with an actionable message
   naming the input and suggesting a larger
   `STATELOG_EVAL_MAX_VALUE_BYTES`. Labelling a truncation and calling it a
   judgement of the output would silently poison the dataset.
4. Recapturing the same run/input pair is idempotent — same `outputId`, no new
   row.

### Checklist revisions are immutable snapshots

A single mutable file with an incrementing integer cannot reconstruct what
version 3 contained once version 4 exists — which questions were live, what the
weights were, whether a question was deleted and restored. Annotations
reference a version, so that reconstruction is required for any later agreement
measurement to reproduce the rubric the human actually used.

Every revision is a complete snapshot at
`checklists/<checklistId>/<version>.json`:

```jsonc
{ "schemaVersion": 1, "checklistId": "cl_news_quality", "name": "news-quality",
  "version": 3, "createdAt": "2026-08-02T19:02:11Z",
  "parentVersion": 2, "hash": "sha256:71ab…",
  "questions": [
    { "id": "q_accurate",    "text": "Is the information accurate?",          "weight": 3, "deleted": false },
    { "id": "q_right_day",   "text": "Is it actually today's news?",          "weight": 2, "deleted": false },
    { "id": "q_top_stories", "text": "Did it get the genuinely top stories?", "weight": 2, "deleted": false },
    { "id": "q_length",      "text": "Is the length right?",                  "weight": 1, "deleted": false },
    { "id": "q_sourced",     "text": "Are claims attributed to a source?",    "weight": 1, "deleted": true } ] }
```

Adding a question, deleting one, restoring one, **or changing a weight** each
create a new revision. Editing a question's text is still forbidden; it would
change what past answers meant. Weights must be finite and positive.

`a` in the TUI prompts for text only and assigns weight 1 — the smaller v1
interaction. Weights are edited by hand in the checklist file, which creates a
revision like any other change.

### Annotations

```jsonc
{ "schemaVersion": 1,
  "annotationId": "ann_5c0e77",
  "outputId": "out_9f3c1a2b",
  "annotatorKind": "human", "annotatorId": "adit",
  "checklistId": "cl_news_quality", "checklistVersion": 3, "checklistHash": "sha256:71ab…",
  "createdAt": "2026-08-02T19:14:02Z",
  "activeMs": 41200,
  "coveredQuestionIds": ["q_accurate", "q_right_day", "q_top_stories", "q_length"],
  "answers": { "q_accurate": true, "q_right_day": true,
               "q_top_stories": false, "q_length": false },
  "note": "missed the EU AI story" }
```

`coveredQuestionIds` is mandatory, and `answers` carries an explicit boolean for
every covered question. **A missing answer means "not judged", never `false`.**

`activeMs` is interaction time accumulated in the draft, not wall time since the
session opened — a session paused overnight would otherwise report a lead time
of days. Named `activeMs` rather than `leadTimeMs` so the semantics are legible
without reading this document.

### The fold: effective answers, per question

The first draft said the reader takes the latest annotation per output. The
review showed that breaks the soft-delete guarantee: answer `q_sourced` under
version 1, delete it in version 2 and re-sign-off, restore it in version 3, and
the version-2 row — which covers only live questions — replaces the version-1
row and the old answer is gone. The design promises undeleting restores prior
work, so the fold must be per question.

- The fold key is **`(outputId, checklistId, annotatorKind, annotatorId)`**.
  Folding on `annotatorKind` alone would merge every human, and later every LLM
  judge regardless of prompt, model or revision.
- For each question, the **effective answer** is the newest annotation from that
  annotator that *covered* that question.
- An item is **stale** when any currently live question has no effective covered
  answer.
- Restoring a question id restores its prior effective answer, because the
  earlier annotation that covered it is still in the log.

### Scoring

A stale item's score is **`null`**, surfaced as "needs review" — not a number.
Treating uncovered questions as failures would report a confident low score for
an item nobody has finished judging. Once every live question has an effective
answer, the score is the weighted fraction of `true` answers over live
questions. With no live questions the score is `null`, not zero.

### Drafts and the commit protocol

Sign-off now touches several files: it appends an annotation, may append a
corpus row, may create a checklist revision, and updates the draft. Order
matters, and the failure modes are real even with one annotator — nothing stops
two terminals being opened.

- **A lock.** An exclusive writer lock on the store, taken for the session,
  failing with a clear message naming the holder. Not multi-annotator support;
  just refusing to interleave two writers.
- **Capture before label.** Corpus rows are written before any annotation can
  reference them, so an annotation never points at a missing row.
- **Idempotent commit.** `annotationId` is generated *before* the write. The
  complete pending annotation is placed in the atomically rewritten draft, then
  appended to `labels.jsonl`, then marked complete in the draft. A crash at any
  point is resolved on resume by retrying the same id, which is a no-op if the
  append already landed.
- **Strict validation on startup.** Unique ids; annotations referencing known
  outputs, checklist revisions and question ids; complete covered answers; valid
  weights. A durable human dataset must fail loudly rather than use the tolerant
  warn-and-continue policy grading uses (`lib/eval/readRun.ts`), which exists
  because grading runs after agents have already been paid for. One malformed
  trailing line — the signature of a crash mid-append — is reported with a
  specific repair instruction; the store never appends after a malformed line.

The draft is keyed by **`outputId`**, and is bound to the ordered list of source
output ids plus the checklist id and revision and the annotator id. Keying by
`inputId` would let a draft resumed against a different run attach answers to
different outputs. Derived scores are not persisted in the draft.

**Write amplification.** The draft is rewritten in place per keystroke and is
bounded by *session* size, so it stays cheap regardless of dataset size —
measured at 0.24 ms for the current corpus but 8.9 ms at 1000 items when one
file held everything. `labels.jsonl` is appended once per sign-off, which is
O(1) forever.

Reading is the only thing that scales with dataset size, and human labels are
small: twenty a week for ten years is roughly 10,000 lines, a few megabytes,
small enough to commit to git with clean append-only diffs. Judge annotations
are a different matter — a judge scores every output on every run, thousands a
week — which is why they get their own file. Judge output is derived,
regenerable and disposable, and must not bury the human labels it is measured
against.

### Command and configuration

```
agency eval label <source> --checklist <file> [--store <dir>] [--annotator <id>]
```

`<source>` is a run directory in v1.

`eval.labelStore` does not exist today; the plan must add it to both
`AgencyConfig` and `AgencyConfigSchema` in `lib/config.ts` (which currently
declares `eval.runsDir` at lines 100 and 419 and nothing else). A relative path
resolves from the **invoking working directory**, matching how `runsDir` is
resolved in `runSuite` (`path.resolve` against `process.cwd()`). Default
`labels/`.

## What is deliberately not in v1

- **No judges.** Nothing generates or runs an LLM judge. That is stage 2.
- **No agreement measurement.** Comparing a judge to human labels is stage 3 and
  is the subject of the follow-up prototype.
- **No multi-annotator support.** The schema carries `annotatorId` so it is not
  foreclosed, but there is one annotator, no reconciliation, no inter-annotator
  agreement, no assignment. Practitioner guidance for small teams is explicitly
  to appoint one person as "benevolent dictator" and avoid annotation conflicts
  entirely. The store lock is integrity protection, not collaboration.
- **No active learning.** Items are labelled in corpus order, not by judge
  uncertainty. There is no judge yet to be uncertain.
- **No pairwise comparison.** The research favours pairwise over absolute
  scoring for reliability, but it needs two outputs per item and a different
  interaction. Noted under Overall idea.
- **No editing a question's text.** Add, delete and restore only.
- **No compaction.** Human-scale logs do not need it.

## Fast follow

Ordered by how much they unblock.

1. **Stage 3 — `agency eval align`, plus the library functions behind it.** Run
   the checklist's judges over labelled outputs, write their verdicts into
   `machine-labels.jsonl` with `annotatorKind: "llm"` and an `annotatorId`
   identifying that judge configuration and revision, and print per-question
   agreement split into "catches the good ones" and "catches the bad ones". Raw
   agreement is not enough: if 19 of 20 outputs really are today's news, a judge
   that always says yes agrees 95% of the time and has learned nothing. The two
   rates separately expose that. Highest-information next step, because stages
   4–6 all assume you know which questions are automatable and right now nobody
   does. LangChain shipped the equivalent as a product feature ("Align Evals"),
   which is evidence it deserves tooling rather than hand-rolling.
2. **Stage 2 — checklist revision to graders.** Generate a `graders.ts` from a
   checklist revision, one grader per live question, weights carried over.
   Prompts must instruct the judge to reason before answering — that is the
   53.9% versus 81.8% gap, not a stylistic preference. Generated as a starting
   point to hand-tune, not a black box.
3. **Sources beyond a run directory.** Label across many runs at once; label a
   saved dataset; re-label a filtered slice ("everything I scored below 0.5").
4. **Truncated and structured output handling beyond rejection.** v1 refuses
   truncated outputs; a later version could label them explicitly as
   truncations. Structured outputs may deserve a better display than
   `JSON.stringify`.
5. **Stage 4 — calibration.** Feed disagreements back as few-shot examples in a
   judge's prompt and re-measure. Cheap, and only worth doing for questions that
   stage 3 says are close.
6. **Undo for sign-off.** A mis-toggle is fixed by toggling back; a mis-signed
   item has no undo beyond navigating back and re-signing.
7. **Question text editing via supersession.** Not editing in place: a new id
   that records which question it replaces, so history stays interpretable.

## Overall idea

The six stages this is the first of:

1. **Label** until you stop discovering new questions. Tool built here. The
   signal for "enough" is not a count — it is that you stop reaching for `a`.
2. **Turn questions into judges.** Mechanical.
3. **Measure each judge against your labels, per question.** Produces a decision
   per criterion: automate, calibrate and retry, or keep human. This is the step
   that answers empirically whether a given piece of taste can be automated at
   all.
4. **Calibrate the near-misses** with your own disagreements as worked examples.
5. **Wire validated judges into the objective.** They become ordinary graders;
   `eval optimize` can then improve the agent against them. Needs no new
   framework machinery.
6. **Keep it honest.** The judge scores new runs; you label only where it is
   least confident or where two judges disagree. That is both the maintenance
   loop and the drift detector — falling agreement means either the agent
   changed or you did.

Two hazards to carry forward:

**Do not build judges while criteria are still moving.** Calibrating against a
standard still being formed means redoing it. Stage 1 has to actually finish.

**Once a judge is the optimizer's objective, hold back labels it never saw.**
The optimizer improves the judge's score whether or not it improves the output;
reported cases include models emitting junk markup to game a judge. A
validation split shares the judge's blind spots, so a small human test set kept
out of calibration entirely is the only thing that catches it. The repo's own
optimizer work already recorded a reward-hacking finding, so this is not
hypothetical.

**Longer term, not committed:** pairwise judging against a pinned reference run,
which is the more reliable protocol and would give `agency eval judge` — today a
command whose verdict feeds nothing — a reason to exist.

## Open questions

- Default store location. `labels/` at the project root is the obvious answer
  and makes it git-committable, but it is a new top-level directory.
- Should `outputs.jsonl` cap stored value size? A pathological agent could emit
  megabytes. A cap keeps the corpus reviewable but means the labelled artifact
  is not quite what the agent produced — the same objection that makes v1 reject
  truncated outputs.
- Should `contentHash` collisions across different tasks warn at capture time,
  or only surface in later analysis?
- Does an annotation ever need to record *why* an answer changed on relabel, or
  is the note plus timestamp enough to reconstruct that later?
