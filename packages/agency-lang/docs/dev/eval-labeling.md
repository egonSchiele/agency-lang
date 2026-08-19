# Labeling a group of runs

`agency label <path…> --checklist <file> [--annotator <id>]` opens every run
the paths name (run directories, or directories of run directories, walked
by `findRunDirectories` like every other command over runs) on an interactive
screen and lets a person answer a checklist of yes/no questions about each
one. Each sign-off appends one `checklist` row to *that run's*
`annotations.jsonl`. It is registered twice, as `agency label` and
`agency eval label`, following the same dual registration `optimize` uses.

There is no separate label store. The **group** (one directory of run
directories; `docs/dev/run-directory.md`) is the store: each run's
`statelog.jsonl` is one thing to judge, each run's `annotations.jsonl` is
where its judgements go, and the group's `checklists/` folder holds the
questions and the in-progress drafts. A single run directory on its own is a
group of one: its parent is the group. All the runs of one session must share
that parent. This page is about the parts that are easy to get wrong: what
identifies what, which order writes happen in, which locks exist, and why
validation here is stricter than in grading.

## Where things live

```text
<group>/
  checklists/<checklistId>/
    1.json, 2.json, ...             immutable revisions
    current.json                    pointer to the newest revision
    .publish.lock                   held only while a revision is being published
    drafts/<sessionId>.json         one session's in-progress state
    drafts/<sessionId>.lock         held by that session while it is open
  <run>/
    statelog.jsonl                  the run's one trace (one item per run)
    annotations.jsonl               its checklist rows land here, beside scores
    .lock                           the run's writer lock, held around each append
```

A run copied out of its group (`cp -r`) keeps its checklist rows; without the
group's lineage the question texts are unknown, which readers
(`humanFeedbackFor`) treat as "no texts", not as an error.

## Layering

```text
CLI (lib/cli/eval/label.ts)  -> resolveLabelingGroup -> controller -> label store -> run-directory modules
TUI (labelTui.ts)            -> pure render helpers
controller (controller.ts)   -> pure session reducer and selectors (session.ts)
store (labelStore.ts)        -> recordChecklistRow, checklist.ts, draft.ts, lock.ts
```

- `lib/eval/label/group.ts` `resolveLabelingGroup(paths)` is the whole
  discovery rule, run once by the CLI: walk the paths, drop aliases of one
  physical directory (`uniqueRunDirectories`), require one common parent,
  read each run, skip runs that wrote no trace, refuse two physical
  directories carrying the same trace id (the session is keyed by trace id,
  so a sign-off could land in the wrong directory), and derive the fields the
  screen shows (`input`, `output`, or `last_message` when no output was
  recorded, via `traceText.ts`). The result, a `LabelingGroup` of
  `LabelingRun {dir, traceId, snapshot, fields}`, is the one value the
  controller and store are given; nothing downstream correlates paths with
  snapshots again.
- `lib/runDirectory/labelStore.ts` is the facade: everything a session may do
  to the group and nothing more. It exposes no file paths, no mutable rows and
  no unrestricted append. It reads this annotator's folded answers out of each
  run's snapshot, loads and saves the session's draft, prepares and publishes
  checklist revisions in the group, and appends checklist rows to the run that
  holds the trace, through `recordChecklistRow`. Its one mutable cache is the
  runs' snapshots, replaced by the mutation's post-write read after each append.
- `lib/eval/label/controller.ts` is the one imperative owner of the sign-off
  order. It sees only the store facade.
- `lib/eval/label/session.ts` is a pure reducer over items, answers, notes and
  staged question edits. `judgement.ts` turns folded answers into a status and a
  score.
- `labelTui.ts` imports none of `draft`, `checklist`, `lock` or the store.

## Identities

- **Trace id** identifies an item. It is whatever the statelog says; the
  labeling code puts no shape on it. There is no content-derived record id any
  more: two traces with byte-identical output are two items, because they are
  two runs.
- **Checklist id** (`cl_…`) identifies a lineage of questions; a **revision** is
  `(checklistId, version, hash)`. **Question id** (`q_…`) is allocated once and
  never reused, so an answer keeps meaning across revisions.
- **Session id** is the hash of `(traceIds in order, checklistId, annotator)`.
  Order is part of it: the cursor is an index, so resuming against the same
  runs listed in another order would put the person in front of a different
  trace than their position implies. A draft may only be resumed against exactly its session
  (`assertDraftMatches` in `draft.ts` is defence in depth for that).
- **Annotation id** is the run directory's deterministic id: the hash of the
  row's content, which for a checklist row is
  `{traceId, annotator, sessionId, checklist, version, hash, answers, note, activeMs}`.
  A retried append of the same judgement lands on the same id and is a replay.
- **Annotator** is the run directory's `{kind, id}`; the CLI records humans
  (`--annotator`, else `$USER`, else the OS account, else `"human"`).

## The checklist row

```json
{ "v": 1, "id": "ann_…", "traceId": "…", "createdAt": "…",
  "annotator": { "kind": "human", "id": "adit" }, "sessionId": "session_…",
  "kind": "checklist", "checklist": "cl_…", "version": 2, "hash": "sha256:…",
  "answers": { "q_a": true, "q_b": false }, "note": "", "activeMs": 4200 }
```

A sign-off answers **every live question** of the revision it was made
against, writing an untouched box as explicit `false`: you looked at it and
moved on. So the set of keys in `answers` is the set of questions covered; a
missing key means "not judged", never "no".

## Effective answers

The fold is the run directory's `foldAnnotations`: per checklist row, keyed by
`checklist:annotator.kind:annotator.id`, answers merged **per question in
append order**, note = the latest row's note. Taking the whole newest row would
break soft delete: judge a question, delete it, sign off again covering only
the live questions, then restore it, and the earlier answer would vanish.
Folding per question keeps it, because the row that covered it is still in the
append-only log.

Append order decides, not `createdAt`; timestamps tie at second resolution.
Every key component matters: folding on annotator kind alone would merge every
human. An item is **stale** when a live question has no effective answer, and a
stale item scores `null`, never `0`.

## Checklist publication

`staged → pending in draft → immutable snapshot → current advanced → draft rebound → pending cleared`

Every revision is a complete immutable snapshot at
`checklists/<checklistId>/<version>.json`, with `current.json` as a small
pointer rather than a second copy. Annotations name a version, so later
agreement measurement has to reproduce the exact rubric a person used.

An external checklist file resolves to one of four outcomes:

- **current**: unchanged; nothing to do.
- **publish**: a legal change against current: add a question, soft-delete one,
  restore one, or change a weight.
- **refresh-definition**: the file is behind current but unedited, so it is
  brought up to date.
- **refusal**: the file is behind current *and* edited. Publishing it would
  discard whatever landed in between.

Illegal at any time: changing a question's text under the same id, removing a
question, a non-positive weight, or claiming a version ahead of the store.

## The sign-off commit protocol

Sign-off touches several files, so the order is owned by `controller.ts` alone.

1. Flush and persist accumulated timing, without marking reviewed or advancing.
2. If questions are staged, save the complete pending revision in the draft.
3. Publish the revision (immutable file, then current pointer, then the
   external definition), one store operation.
4. Rebind the draft to the new version and clear the pending revision.
5. Build the complete checklist row against that durable revision.
6. Save the row as the draft's `pendingAnnotation` **before** appending it.
7. Append (or replay) through the store.
8. Reduce `annotationCommitted`: mark reviewed, advance, reset this trace's
   timer for a later relabel.
9. Save the post-commit draft.

Every step is idempotent, so reopening after a crash at any boundary converges
on exactly one row and one revision. Recovery runs the same operations in the
same order (`recoverChecklist`, `recoverAnnotation`); there are no separate
recovery writers. `controller.test.ts` crashes at every named boundary
(`ControllerFaultPoint`) and reopens.

A `current` pointer that lags the newest revision is a warning, not an error:
it is exactly what a crash between the rename and the pointer update leaves,
and validation runs before recovery, so refusing to open would make that state
unrepairable.

## Why validation is strict here

Grading reads a run directory tolerantly: a malformed annotation row is
skipped with a warning, because the runs have already been paid for. The label
store is the opposite case, so `openLabelStore` fails on: a broken or edited
revision chain, a `current` pointer naming a revision that does not exist or
whose hash does not match, a checklist row that names a missing revision or a
mismatched hash, or an answer for a question that revision does not define.
The same grounding is repeated at the moment of writing: `recordChecklistRow`
(`mutations.ts`) checks, under the run's lock and immediately before the
append, that the run holds the row's trace, that the group has the revision
the row names with the hash it records, and that every answer names a question
that revision defines. Open-time validation is diagnostics; the mutation is
the guarantee, so no caller can skip publish-before-append.

## The locks

There is no lock on the group as a whole (a session-long lock would lock every
other annotator out of every run). Three narrow ones, all the same owned-file
primitive (`acquireOwnedFileLock` in `lib/runDirectory/lock.ts`: created with
`wx`, released only at the exact path acquired and only when the ownership
token inside is still ours):

- **One per session draft**, `drafts/<sessionId>.lock`, held from
  `openLabelStore` to `close()`. A second process cannot resume and mutate the
  same draft; another annotator, or another checklist, opens beside it.
- **One per lineage publication**, `.publish.lock`, held only while a revision
  is written. Two sessions that both prepared "the next version" cannot both
  win: the loser's `assertParentStillMatches` fails inside the lock and the
  lineage is untouched; it reconciles against the published lineage on its
  next prepare.
- **The run's writer lock**, taken by `recordChecklistRow` around each append
  and released after it, so `eval grade` or `runs add` on that run between
  two sign-offs is not blocked.

The run's `notes.md` is under none of these: a person edits it with any
editor at any time, and readers sample it best-effort (see
`docs/dev/run-directory.md`).

A stale lock is never taken over automatically; it is reported with the
holder's pid, and removing it is a person's decision. Every lock is released
when opening fails, when a dispatch fails, and on close; the store is the only
owner, and the controller only calls `store.close()`, which is idempotent.

## Active time

`activeMs` is interaction time accumulated across dispatches, not wall time
since the session opened. Only elapsed milliseconds are persisted, never a
monotonic anchor, so a paused session's downtime cannot be counted. It is
recorded on the checklist row.

## What is deliberately not here

- No content-derived record ids, no occurrences, no ingest, no manifest, no
  `eval.dataset` config. There was no migration from the old label store; that
  was decided when the run-directory arc started (see
  `docs/superpowers/specs/2026-08-18-run-directory-and-annotations-design.md`).
- No agreement measurement between annotators yet; the rows carry everything it
  needs (annotator, revision, per-question answers).
