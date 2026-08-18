# Re-review: run directory and annotations implementation plan

**Plan:** `2026-08-18-run-directory-and-annotations.md`  
**Verdict:** The revision resolves the first review's phase-ordering, atomic
rename, trace-digest, and score-revision findings. Three correctness issues
remain; Findings 1 and 2 should be fixed before implementation.

The prior objection to storing harness observations as `run` annotations is
withdrawn and is not part of this review.

## Resolved from the first review

- Task 3.4 now keeps `labelingHost` and `datasetWriter` until the old label CLI
  is replaced.
- Task 4.1 makes `task` → `input` an atomic migration and includes a
  completeness search and broad verification.
- Trace digests now canonicalize parsed envelopes, and conflict detection is
  correctly limited to `mergeStatelog`, where the two streams are separate.
- Score rows now carry a grading-pass id, and machine annotator ids include a
  revision hash.

## 1. Checklist folding currently merges different humans' answers

Task 2.3 defines effective checklist state as:

```ts
checklists: Record<string /*checklist*/, Record<string /*questionId*/, boolean>>
```

That key omits the annotator. If Alice answers `q1: true` and Bob later answers
`q1: false` against the same checklist, the fold produces one answer—Bob's—and
Alice's judgement disappears from effective state. This contradicts the
annotation rule that named annotators never merge and prevents later agreement
measurement.

Key checklist folds by `(traceId, checklist, annotator.kind, annotator.id)`, as
the current label store does. Add a test with two humans answering the same
question differently and assert that both effective judgements survive.

## 2. A crashed grading pass can become the effective hybrid of two passes

`gradeSuite` mints a random `passId`, then appends one score row at a time. The
same id makes a retry *inside the same process* idempotent, but after a process
crash the CLI cannot recover that random id. More importantly, the fold chooses
the latest row independently per grader.

Example:

1. Pass A writes scores `quality=0.8` and `speed=0.7`.
2. Pass B writes `quality=0.2`, then crashes before writing `speed`.
3. The effective fold becomes `quality=0.2` from B plus `speed=0.7` from A.

That combination was never a completed grading pass, yet it can drive the
reported objective and optimizer.

Give a pass a completion boundary. The simplest append-only shape is a
`grade-pass` completion row written after all of that pass's scores; readers
ignore score rows whose pass has no completion row and fold the latest complete
pass. Alternatively append the whole pass as one annotation row. Add a
crash-after-first-grader test proving an incomplete pass never changes the
effective scorecard.

## 3. Ignoring a torn final line is unsafe unless writers repair it before appending

Tasks 2.1 and 2.3 ignore a final line without `\n`, but `mergeStatelog` and
`appendAnnotation` then append directly to the file. If the file ends with:

```text
{"v":1,"id":"ann_par
```

the next JSON row is attached to those bytes. The torn line becomes a malformed
middle line and the newly written row is lost with it.

Under the writer lock, truncate the file back to its last newline before every
append (and `fsync` the repair), or refuse writes until the user repairs it.
Ignoring is fine for readers; it is not sufficient for writers. Test both
annotation and statelog append after a torn suffix.

## Smaller plan corrections

- Task 3.4 says Task 5.2 will delete `labelingHost.ts` and `datasetWriter.ts`,
  but Task 5.2's delete list does not include them. Add them there with their
  tests.
- A grader id hashes only the entry module file. If grader modules can import
  local helpers, editing a helper changes behavior without changing identity.
  Hash the grader's local closure, or explicitly constrain grader identity to a
  self-contained module and document that limitation.
- Task 4.2 deletes `prepareInput`, which currently allocates and seeds each
  test's workdir, but does not name its replacement staging lifecycle. Specify
  that each test runs in a temporary directory outside the final run directory,
  is copied to `workdir/<traceId>/`, and is removed afterward; otherwise an
  implementer can accidentally preserve the old `inputs/<id>/` tree.

After the checklist key and grading-pass completion contract are corrected,
the plan is ready to execute. The torn-tail rule should be fixed in the same
core phase because it affects both append-only files.
