# The run directory and annotations: one shape for observing, noting, labeling, grading and optimizing

Date: 2026-08-18
Status: draft for review

## Background: what exists today and why it is confusing

To evaluate an agent in Agency today you meet four on-disk formats and a
vocabulary that changes between them.

1. **The statelog** (`*.jsonl`). One event per line, emitted by every Agency
   process, whether it was started by `agency run`, `agency eval run`, or
   `agency agent`. It is the only record of what an agent actually did.
2. **The eval record** (`eval-record.json`, also written by `agency eval
   extract`). A smaller JSON view of one statelog trace: hoisted inputs and
   outputs, a flat event list, aggregate metrics. Derivable from the statelog in
   about 70 ms.
3. **The eval run directory** (`runs/<id>/`). Written only by `agency eval
   run`: `config.json` (which code and which suite, called "provenance"),
   `summary.json`, and per input an `input.json`, the statelog, the eval
   record, the workdir, and `verifier-N/grading.json` for each grading pass.
4. **The label dataset** (`labels/`). Written only by `agency label ingest`,
   which reads a run directory, a folder of files, a JSON array, or one
   statelog trace, and stores content-hashed *records* with *occurrences*,
   *annotations* against versioned *checklists*, plus a lock and drafts.

Three separate mechanisms exist for "an opinion about a run": grader scores in
`verifier-N/`, human checklist answers in `labels/labels.jsonl`, and free-text
notes, which have no home at all (a prototype, `agency label save`, appended a
`notes.jsonl` to the label dataset).

The consequences, seen in this session:

- Running an agent is coupled to grading it: `agency eval run` refuses a test
  without a `goal` unless you find `--no-grade`.
- A run that went badly cannot be saved for later study, because both grading
  and labeling refuse a failed or unfinished trace. That is exactly the run you
  most want to keep.
- To do anything with an ad-hoc run you must first push it through the right
  converter (`extract`, `ingest --format …`), each with its own flags.
- The words do not line up: `task` means "the input" in evals and "context for
  the labeler" in labeling; `<source>` and `--source` on the same command mean a
  path and a batch name; `input` means a whole test spec inside graders;
  `provenance`, `occurrence`, `verifier`, `corpus`, `record`/`example`/`output`
  are all load-bearing and all opaque.

Other frameworks have the same *number* of concepts (dataset, run, scorer,
trace, human label). The ones people find clear (Inspect, Braintrust) use one
plain word per concept everywhere and one artifact per concept. Inspect's whole
run — samples, transcripts, scores — is one file.

## The design in one paragraph

**The statelog is the run.** Everything else is an optional attachment placed
next to it in a plain directory: the agent's code, the working directory the
agent left behind, and one append-only `annotations.jsonl` that holds every
opinion anyone or anything forms about a trace — a note, a checklist answer, a
grader score, an LLM judgement, or the eval harness's own observation about how
the run ended. One directory shape serves an ad-hoc run, a saved reference run,
and a whole eval; one row shape serves notes, labels and grades. Any tool that
can read a statelog can work on any of them, and nothing requires the run to
have gone through `agency eval run`.

## Three rules

Every decision below follows from these.

1. **One word per concept, the same word in the CLI, the files and the code.**
   Vocabulary is not hidden behind a UI layer; it is made plain instead.
2. **One artifact per concept.** A concept that can be derived is not stored.
3. **Degrade, do not refuse.** A directory with only a statelog is a valid run.
   Each attachment unlocks more; missing ones limit what you can do, never
   whether you can start.

## Vocabulary

| Concept | Word | Replaces |
|---|---|---|
| What the agent did | **statelog** / **trace** (one trace = one thing you judge) | eval record (as a file) |
| One thing to evaluate | **run** = one trace plus its attachments | eval input result, record, example, output |
| A folder holding one or more runs | **run directory** | eval run dir, label dataset, corpus |
| What the agent is given | **input** | task, args |
| What a benchmark case declares | **test** (`id`, `input`, `goal`, `expected`, `files`, `graders`) | eval input, input spec |
| A file or folder of tests | **suite** | inputs, input suite |
| An opinion about a run | **annotation** | grade, label, note, verifier output |
| Who formed the opinion | **annotator** (`human`, `grader`, `judge`, `harness`) | — |
| A structured yes/no rubric | **checklist** | (unchanged) |
| Which code ran | **code** (`entry`, file hashes) | provenance, closure |
| What the agent left on disk | **workdir** | (unchanged) |

Deleted words: task (in evals), args, provenance, occurrence, verifier, corpus,
record, example, output (as a stored thing), ingest.

## The run directory

```
<dir>/
  statelog.jsonl        # required. any number of traces
  annotations.jsonl     # created by the first annotation
  code/<closureHash>/   # optional: one copy per code VERSION, named by the
    <files relative to the entry's directory>   #   hash the trace recorded
  workdir/<traceId>/    # optional: filesystem snapshot for that trace
  .lock                 # writer lock, present only while a writer is open
  checklists/<name>/    # optional: versioned checklist snapshots (see below)
    1.json  2.json  current.json
```

Rules:

- **`statelog.jsonl` may hold many traces.** A directory with one trace is an
  ad-hoc run; with fifty it is an eval or a reference set. Nothing else changes
  shape between the two. `agency runs add` merges by trace id: it computes a
  canonical digest of each incoming trace's events, skips a trace whose digest
  is already present, and **refuses** a trace whose id is present with a
  different digest (two different event streams claiming one id would make
  every workdir and annotation keyed on that id ambiguous).
- **Code is stored by version, not by trace.** `code/<closureHash>/` holds one
  copy of the closure for every distinct hash the directory's traces recorded
  at `agentStart`. Fifty tests of one agent store its code once; a v1/v2
  comparison stores two trees; `optimize` picks the tree a trace names. `runs
  add --code` hashes the complete closure it is given, compares it against
  the trace's recorded hash, and refuses on mismatch or an incomplete tree — a
  warning is too weak, because optimizing the wrong program is silent.
- **Everything is keyed by trace id.** Annotations, workdirs and (via the
  statelog, below) code and inputs all name the trace. Trace id is the identity
  of "a run"; a resumed trace is still one run.
- **There is no `run.json`, `summary.json`, `config.json` or `input.json`.**
  Everything they held is either in the statelog (input, cost, duration,
  outcome, and — with the change below — code identity), derivable from it, or
  is an annotation.
- **There is no `eval-record.json` on disk.** The eval record stays as an
  in-memory type that graders and judges receive; it is computed from the trace
  when needed.
- **A run directory is a plain folder.** Copying or moving it is fine, and
  readers never need a lock. `cat`-ing two statelogs together produces a file
  that is *readable* but not *validated*: readers drop byte-identical duplicate
  lines silently and make no other promise — once two streams sharing an id are
  interleaved there is no boundary left to compare, so a conflict cannot be
  detected after the fact. `agency runs add` is the merge path that checks
  this before writing (existing and incoming traces are still separate there);
  `cat` is a shortcut you use when you know the inputs are disjoint. The
  per-trace digest is over the canonicalized parsed events in order, so key
  order in the JSON does not matter.

### What the statelog must additionally record

Two facts are not in the stream today and cannot be recovered afterwards. Both
become fields on the existing `agentStart` event, so every launcher (`agency
run`, `agency eval run`, `agency agent`) records them the same way:

- **Code identity**: the entry file path and the closure's `{file, sha256}`
  list (the list `config.json` computes today). Lets a later `code/` attachment
  be checked against what actually ran, and lets `optimize` attribute
  annotations to a version.
- **Input**: what the entry node was given. Already present as `args` for
  `agency run`; `agency agent` records `args: {}` and the task is only
  recoverable as "the first user message". Record it explicitly.

Everything else needed — cost, duration, tool calls, retries, output — is
already there. "How it ended" is best-effort: a trace with an `agentEnd` is
known-finished; one without is *unknown*, which tools show and never treat as a
reason to refuse.

## Annotations

One append-only JSONL file. Every row:

```jsonc
{
  "v": 1,
  "id": "ann_<hash>",            // sha256 of (traceId, annotator, kind, payload,
                                 //   sessionId-or-null): the same opinion always
                                 //   has the same id, so a retry rewrites, never doubles
  "traceId": "MXEjJo…",
  "createdAt": "2026-08-18T00:19:08Z",
  "annotator": { "kind": "human" | "grader" | "judge" | "harness", "id": "adit" },
  "kind": "note" | "checklist" | "score" | "run",
  // then one payload, by kind:
}
```

Payloads:

- **`note`** — `{ "text": "took 40 min and $5; wanted ≤5 min, ≤$1" }`.
  The lightest possible annotation. This is the "save this run with my
  thoughts" case that had no home.
- **`checklist`** — `{ "checklist": "news-quality", "version": 3,
  "hash": "sha256:…", "answers": { "q_a1": true, "q_b2": false },
  "note": "" }`. One row per sign-off. Answers are folded per question in
  append order, exactly as today, so soft-deleting and restoring a question
  keeps its earlier answer.
- **`score`** — `{ "passId": "pass_…", "name": "cheap", "score": { "kind":
  "binary", "pass": true } | { "kind": "scalar", "value": 0.7 }, "weight": 1,
  "mustPass": false, "feedback": "…", "gradersModule": "/abs/graders.ts" }`.
  One row per grader per trace per grading pass; `passId` is minted once per
  `agency eval grade` invocation and is part of the row's identity, so a replay
  inside one pass converges on one row and a second pass always adds rows even
  when the score is unchanged. `agency eval grade` appends; it never rewrites.
  The objective for a directory is computed from rows, not stored.
- **`run`** — written by the eval harness (`annotator.kind: "harness"`) for
  each trace it launched: `{ "test": { "id": "fizzbuzz", "input": …, "goal":
  …, "expected": …, "graders": "/abs/graders.ts" }, "suite": { "source": "…",
  "sha": "…" }, "ended": "ok" | "error" | "timeout" | "cost-cap" | "killed",
  "flags": { … } }`. This is what `config.json`, `summary.json` and
  `input.json` were for, reduced to one row per run, and it is the only place
  the harness's privileged knowledge ("I killed it at the cost cap") lives.

Rules:

- **Append-only, order decides.** Later rows about the same trace supersede
  earlier ones per `(kind, annotator, name/checklist/question)`; timestamps are
  informational. Because order is semantic, **writers are serialized** (below).
- **Durability.** Every append is a whole line followed by `fsync`; a reader
  treats a final line without a newline as a torn write and ignores it.
- **Annotators are named by revision**, so two humans, two grader modules, or
  two judge configurations never merge: a human is `$USER`; a grader module is
  `<path>@<sha256 of the file>`; the goal judge is `goal-judge:<model>@<sha256
  of its prompt template>`. Editing `graders.ts` in place is therefore a new
  annotator, and its rows sit beside the old ones rather than superseding them.
- **Reading is tolerant, writing is strict.** A malformed row is skipped with a
  warning on read; a writer validates before append. This is the label store's
  strictness applied only where a mistake is cheap to catch.
- **No `outputs.jsonl`, no `occurrences.jsonl`.** The output is in the trace;
  which source produced a trace is `annotator`/`run` metadata. Content-hash
  dedup ("v1 and v2 produced identical text, judge once") becomes an analysis
  step over annotations rather than a storage identity. Named loss, accepted.

### The writer lock and crash recovery

Kept from the label store, re-homed as run-directory infrastructure:

- **One writer at a time** per directory: `.lock` with the holder's pid, taken
  by `note`, `eval grade`, `label`, `runs add`, and the eval harness; released
  on exit; a stale lock is reported (pid, whether the process still exists)
  and never stolen automatically. Readers (`logs`, `runs list`) take no lock.
  Concurrency is rare today (one person, sequential commands), but two
  terminals running `label` is precisely the case that produced the current
  lock, and concurrent evals are a wanted feature; the cost of keeping it is
  small.
- **Single-row appends** (`note`, `score`, `run`) need nothing more: the id is
  deterministic, so a crash before the write loses nothing and a retry after
  the write finds its row already present.
- **Checklist sign-off** is still a multi-file commit (publish a revision, then
  append the answer row). It keeps the current draft with its `pendingAnnotation`
  and the same ordered, idempotent protocol, stored at
  `checklists/<name>/draft.json`, so a crash at any boundary replays to exactly
  one revision and one row. This is the only place a draft exists.

### Checklists

Unchanged in substance, relocated: `checklists/<name>/<version>.json` inside the
run directory, each version an immutable snapshot, `current.json` a pointer.
The publication rules (add, soft-delete, restore, reweight; never change text
under the same id; refuse a stale edited file) carry over as they are. A
directory is therefore self-contained: runs, rubric, and answers travel
together.

## Commands

### Removed

- `agency eval extract` — the eval record is no longer a file.
- `agency label ingest` and its four `--format`s — there is nothing to ingest;
  tools read run directories.
- `agency eval optimize` — keep only `agency optimize`.
- The log viewer's `l` key (#848) — replaced by the trace-extract primitive
  below. Its supporting pieces (`labelTrace`, `datasetWriter`, `labelingHost`,
  the `statelog` occurrence origin) go with it.
- The label store's manifest and version gate, `outputs.jsonl` and
  `occurrences.jsonl`. (Its lock and the checklist draft are kept, re-homed —
  see "The writer lock and crash recovery".)
- `agency label save` / `saved` (the prototype from this session).

### New

- **`agency logs extract <log> --trace <id> [-o <file>]`** — copy one trace's
  lines out of a statelog, to a file or stdout. Also a viewer key. A trace
  slice is itself a valid statelog, so this is the one primitive that turns
  "a run I noticed in a big log" into "a run I can attach things to". With a
  single-trace log, `--trace` defaults to that trace.
- **`agency runs add <dir> [--statelog <file>…] [--code <entry>] [--workdir <path> --trace <id>] [--annotations <file>]`** — assemble or extend a
  run directory, under the writer lock. Idempotent: an identical attachment is
  a no-op, a differing one is refused without `--replace`. Statelogs merge by
  per-trace digest (skip identical, refuse conflicting). `--code` hashes the
  complete closure, stores it under `code/<closureHash>/`, and refuses when it
  does not match the hash a trace recorded or when a closure file is missing.
  Adding a workdir later records when the snapshot was taken, since it may
  postdate the run. (Command name is a proposal.)
- **`agency note <dir> --trace <id> <text>`** — append a `note` annotation.
  With a single-trace directory, `--trace` defaults.
- **`agency runs list <dir>`** — one line per trace: id, input preview, cost,
  duration, ended, latest score, note preview, labeled or not. The browsing
  view for a reference set. (May fold into `agency logs`.)

### Changed

- **`agency eval run --agent … --suite <file|dir|git>`** — runs the suite and
  writes a run directory (statelog with one trace per test, `code/`,
  `workdir/<traceId>/`, and one `run` annotation per trace). **It never
  grades.** No `goal` is required to run.
- **`agency eval grade <dir> [--graders <file>]`** — reads the directory,
  computes eval records from traces, appends `score` annotations, prints the
  objective. Grader precedence unchanged: flag > test's own > `eval.graders`
  config > goal judge (which needs the test's `goal`, and says so per test if
  missing). Grader callbacks receive `({ output, test, workdir, record, judge })`
  — `test` replaces `input`, and `test.input` is what the agent was given.
- **`agency label <dir> --checklist <file>`** — walks the directory's traces
  and appends `checklist` annotations. Same TUI, same keys, same sign-off
  protocol; it reads a run directory instead of a private store.
- **`agency optimize`** — reads `code/` (or the live agent) plus annotations of
  every kind for reflection: scores as today, and notes and checklist answers as
  additional feedback text.
- **`agency logs <dir>`** — the viewer opens a run directory directly and shows
  annotations beside the trace.
- **`agency run --capture-workdir`** (or a config flag) — snapshot the working
  directory into a run directory at the end of an ordinary run, for people who
  know in advance they may want it.

## The workflows, end to end

**I ran something ad hoc and want to keep it with a thought.**
`agency logs extract log.jsonl --trace MXEjJo -o refs/ficalc/statelog.jsonl`
then `agency note refs/ficalc "took 40 min and $5; wanted ≤5 min, ≤$1"`. Later:
`agency runs add refs/ficalc --code lib/agents/agency-agent/agent.agency`. It
is now a run directory like any other: viewable, gradable, labelable.

**I have several runs and a rubric.** Put their traces in one directory (`runs
add` or plain `cat`), then `agency label <dir> --checklist news.json`.

**I want a benchmark.** Write a suite of tests; `agency eval run --agent a.agency
--suite evals/ --run-id v3` writes `runs/v3/`; `agency eval grade runs/v3`
appends scores. Re-grade any time; every pass is more rows, nothing is
overwritten. A `mustPass` failure still exits 2, so it still works in CI.

**I want to compare v1 and v2.** Grade or label both directories; the
comparison reads annotations. Identical outputs across the two are found by
hashing at that point, if wanted.

**I want to improve the agent.** `agency optimize` over a directory that has
scores, notes, or labels — all three are feedback.

## What this removes

Roughly: the eval record writer and reader as a disk format; `extract`; the
whole `lib/eval/label/load/` tree; the label store's ids/occurrences/corpus/
lock/draft/manifest modules; `config.json`/`summary.json`/`input.json`/
`verifier-N/` writers and their tolerant readers; the `l` key and its three
service modules; and the docs for each. What stays: the statelog, the eval
record *type* and extractor, the graders and judge, the checklist publication
rules and the labeling TUI, the optimizer, and the eval harness's execution core.

## Migration

A clean break, deliberately. Old `runs/` directories hold their statelogs and
could be re-assembled with `runs add`; old `labels/` directories hold copies of
outputs and answers but **not** the traces, so their labels cannot be attached
to a run and are not carried forward. The language has few users and little
labeled data today, so no compatibility layer or migration is built.

## Open questions

1. **Command namespace.** `agency runs add/list`, `agency note`, and `agency
   logs extract` are proposals; the family may want one root (`agency runs
   …`).
2. **Where the run annotation's `test` lives when the suite is huge.** Inlining
   the test spec per row is simple and self-contained; a suite with large
   `expected` values would bloat the file. Cap or reference by id + suite sha
   if it bites.
3. **Judge annotations at volume.** A judge that scores every trace on every
   pass will outnumber human rows. Same file, or `annotations/<annotator>.jsonl`
   per annotator? Start with one file; split only if a real directory gets
   unwieldy.
4. **Multi-trace `agency agent` sessions.** One trace = one run is the rule; a
   long session that spawns sub-agents already nests them under one trace, so
   this holds, but check against a real session before building.

## Out of scope

Agreement measurement between judges and humans, active learning, pairwise
labeling UI, editing a trace or an annotation in place, and any statelog server
integration. Each becomes easier on this shape, none is needed to ship it.
