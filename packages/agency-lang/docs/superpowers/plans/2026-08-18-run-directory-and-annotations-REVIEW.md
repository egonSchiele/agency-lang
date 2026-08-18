# Review: run directory and annotations implementation plan

**Plan:** `2026-08-18-run-directory-and-annotations.md`  
**Verdict:** Strong decomposition, but four sequencing/contract issues must be
fixed before execution. Finding 5 should also be settled now because it changes
the annotation identity written in Phase 2.

## 1. Phase 3 deletes services that the still-live label CLI requires

Task 3.4 deletes `labelingHost.ts` and `datasetWriter.ts` at lines 385–393, but
the replacement label flow does not land until Task 5.2. Today
`lib/cli/eval/label.ts` imports `createLabelingHost`, and
`lib/cli/eval/ingest.ts` imports `datasetWriter`. The Phase 3 PR therefore
cannot typecheck, and `agency label` / `agency label ingest` would be broken for
the whole Phase 3→5 interval.

Task 3.4 should remove only the viewer hook and its use of those services.
Keep `labelingHost` and `datasetWriter` until Task 5.2 removes the old CLI flow,
or move all labeling replacement work into the same phase. Every phase is
supposed to be independently shippable, so knowingly broken intermediate PRs
are not an option.

## 2. Task 4.1's `task` → `input` change is much larger than its file list

Task 4.1 changes `Input` into `Test` with an `input` field, then retains
`type Input = Test` temporarily. A type alias preserves the type's name; it
does not preserve the removed `.task` property. There are current `.task`
consumers in `runSuite.ts`, `runAgent.ts`, `subprocess.ts`, the optimizer,
reflection feedback, fixtures, and many tests. Task 4.1's stated edits therefore
cannot pass the phase typecheck.

Choose one atomic boundary:

- migrate the field and all consumers in Task 4.1; or
- make the loader normalize user-facing `input` into a temporary internal
  shape that still has `task`, then migrate the internal type in a later task.

The first option better satisfies the plan's vocabulary goal. In either case,
list the affected production files and add a repository search confirming that
eval-specific `.task` accesses are gone before committing.

## 3. The trace reader cannot implement the promised post-`cat` conflict detection

Task 2.1 groups every line with the same `trace_id` into one trace. Once two
statelogs have been concatenated, there is no boundary saying “the second copy
of trace A starts here.” Multiple lines with trace A are also the normal shape
of one trace. The self-review's proposed test that a “conflicting duplicate id”
is detected by `readTraces` therefore has no implementable rule.

There is a second mismatch: the spec calls for a canonical event digest, while
Task 2.1 hashes raw lines. Re-serializing the same JSON with a different object
key order would then produce a conflict even though the events are equal.

Keep conflict detection at `mergeStatelog`, where existing and incoming traces
are still separate and can be compared. Digest canonicalized parsed envelopes
in event order. Do not promise that an arbitrary `cat` result can distinguish
two conflicting streams unless the statelog format first gains a trace boundary
or sequence identity that makes that distinction possible.

## 4. Deterministic score ids erase grading passes and merge edited graders

The id in lines 17–18 hashes the complete payload but no grading-pass identity.
Task 4.3 consequently says an identical re-grade appends nothing. That
contradicts “one row per grader per grading pass” and makes it impossible to
observe that a second pass occurred when its score happened to be unchanged.

The annotator ids are also too weak: a module path does not identify a grader
revision. Editing `graders.ts` in place leaves the same annotator id, so its new
score silently supersedes the old grader's score. Likewise,
`goal-judge:<model>` omits the prompt/config revision that the spec says must be
part of judge identity.

Add a grading-pass id to score rows and their identity, and identify machine
annotators by configuration/content revision (for example module closure hash,
or model + prompt hash). Keep the deterministic id for crash replay by deriving
it from `(passId, traceId, annotator, graderName, payload)`. Add tests for:

1. replaying the same row in one pass → no duplicate;
2. running a second pass with the same result → a second row;
3. editing a grader at the same path → a distinct annotator identity.