# Review: run directory and annotations design

**Spec:** `2026-08-18-run-directory-and-annotations-design.md`  
**Verdict:** The unification is compelling, but the durability and identity
contracts need revision before implementation. Findings 1–3 are blockers.

## What works

The central separation is good: running should not imply grading, and graders
should derive their input from a captured trace rather than require an
`eval-record.json`. A directory that remains useful with only a statelog is also
a much better ad-hoc workflow. The common annotation vocabulary is simpler than
separate note, label, and grade stores.

## Findings

### 1. Removing the lock and drafts loses the crash-safety the spec says remains

Lines 153 and 255–257 claim that generating an annotation id before append
makes retries idempotent and that the current sign-off protocol remains. It
does not remain if the draft is removed at line 221. After a crash, the newly
generated id exists only in memory; retrying generates another id. More
importantly, checklist publication and annotation append are still a multi-file
commit. The current `pendingAnnotation` draft is what lets recovery replay the
same row after a crash at any boundary.

Removing the lock also permits two label, grade, or note processes to append
and publish checklists concurrently. A single `write` to an append-open file is
not a complete cross-platform transaction protocol, and checklist publication
still updates several files. Append order is semantic in this design, so the
writer order must be serialized.

Keep a writer lock and the durable pending-row recovery mechanism (they may be
run-directory infrastructure rather than “label store” concepts). Readers do
not need the lock. Specify durable append (`fsync`) as the current label store
does.

Note: how likely is it that two processes will be editing concurrently? We don't have concurrently running evals yet ... though it would be nice to have those.

### 2. The migration claim is false, and the new lifecycle can destroy the only copy of human work

Lines 302–305 say old `labels/` directories are regenerable from traces and
that every one contains a statelog. They do not: the current dataset stores
`outputs.jsonl`, `occurrences.jsonl`, and `labels.jsonl`, not source statelogs.

This is completely fine, however. There is not a lot of existing data that needs to be kept around, and this language does not have a lot of users right now, so this is a good time to make a clean breaking change. No need to deprecate or add support for backwards compatibility.

### 3. One `code/` tree cannot represent the multi-version directory the spec allows

The directory has one `code/` tree (lines 100–101), while the statelog may hold
arbitrarily merged traces (lines 109–115), including the v1/v2 comparison at
lines 283–285. Two traces can identify different closures with the same
relative paths. The second attachment then either overwrites the first or
cannot be added, and `optimize` cannot select the code that produced a trace.

Store code by identity, for example `code/<closureHash>/...`, and have each
trace's start event name that closure hash. Deduplicate equal closures. The
attachment command must validate the complete closure and refuse an incomplete
or mismatched tree; a warning is too weak because optimization would target the
wrong program.

Would it make more sense to store closure hashes, or to store different copies of the code for each trace? What are the pros and cons of each?

### 4. “Plain `cat`” conflicts with trace-id identity and idempotent merge

Lines 111–112 promise no duplicate trace, but lines 123–125 and 275–276 say
plain concatenation is a valid merge. `cat` cannot reject a duplicate trace id
or detect two different event streams using the same id. Once present, all
workdirs and annotations keyed only by trace id become ambiguous.

Either weaken `cat` to “syntactically readable but requires validation,” or
define reader behavior for duplicate identical and duplicate conflicting
traces. `agency runs add` should be the safe merge path and should compare a
canonical digest per trace before appending.

