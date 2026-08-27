# agency-coding: an eval suite for Agency code writers

The companion to `evals/agency-review`: that suite scores an agent that
reads Agency code, this one scores an agent that writes it. The two feed
each other — a program this suite's agent writes badly is a candidate test
for the reviewer suite, with its oracle already attached.

The suite describes the job. It does not name an agent. A writer is scored
on it through an eval entry node with the contract below; the stdlib's
`agencyCodingAgent` carries one (`evalMain` in
`stdlib/agents/agency/coding.agency`), and any other implementation
supplies its own.

## Run it

```bash
pnpm run agency eval run \
  stdlib/agents/agency/coding.agency:evalMain \
  --suite evals/agency-coding \
  --out runs/agency-coding

pnpm run agency eval grade runs/agency-coding
```

Add `--trials 3` to get means with error bars. To compare a second
implementation, point the first command at its `file.agency:node`.

## The contract

Every test gives the writer an assignment and a filename, and expects the
finished program saved under that name in the working directory.

Input, the entry node's single parameter (`CodingEvalInput` in the stdlib):

```
{ "assignment": string, "outFile": string }
```

`assignment` is what the program should do, including the shape of the
deliverable (a module exporting a named def, or a runnable program with a
`node main`) — everything agent-specific stays out of the contract, so any
writer can be scored on the same suite. `outFile` is where the entry node
must save the source it produces — grading happens against that file, not
against the node's return value.

## Grading

A test about what the code does carries a hidden harness
pair in its `holdout/` directory — a `<name>.agency` importing the saved
`outFile`, and a `<name>.test.json` naming node-by-node expected outputs.
The framework discovers the pair and grades the run's working directory
with `agency test --agency-only --reject '*'` (an `AgencyTestGrader`, one
per pair). The score is the passing fraction, so partial progress counts;
a test can set `"harnessMustPass": true` to make the harness a gate
instead. The grader's row names each failing case, which is why the
stdlib's `evalMain` saves even a failed run's last draft — the report then
says exactly what the draft got wrong. A judge can sit beside a holdout
(`named-config-params` does this) to say in words what the failing cases
only show as an error. `holdout/` is
never seeded into the working directory, so the writer cannot code to the
oracle. A pair placed in `files/` instead would be visible to the writer —
useful later for tests about working against a given spec-by-example.

Every harness is verified at authoring time: the reference solution passes
all its cases, and a representative wrong solution fails.

A test about *how* the code is written (idiomatic Agency rather than a
JavaScript habit) uses a rubric judge instead: its `graders.ts` calls
`idiomJudge` from `lib/idiomJudge.ts` with a standard naming the idioms
and a reference solution the judge can compare against. Such a test may
have no harness at all. Only `files/` is seeded into the writer's working
directory.

Every test also carries `formatted` from `lib/formatted.ts`, at weight
0.2: the saved file must match what the Agency formatter would produce
from it. The writer has the stdlib `format` tool for this. A test that
has only a harness gets a `graders.ts` holding just this grader; the
harness graders are added alongside it.

## The tests

Each `test.json` carries one tag, `easy`, `medium`, or `hard`, and nothing
else; tags are for choosing a subset to run.

- `sum-multiples` — a pure arithmetic loop (sum multiples of 3 or 5 below
  n). The easiest kind of deliverable: one exported def, no state.
- `reverse-digits` — digit manipulation that needs a while loop and
  integer division built by hand (Agency has no C-style `for`, and the
  stdlib has no `floor`), so JS reflexes do not transfer directly.
- `uses-match` — wrap a call to a seeded `foo` (which raises `std::read`,
  `std::write`, or `std::email`) in a handler that decides each effect
  differently. Judged: one `match` on `data.effect` with a guard arm for
  the conditional write, no if-chain on the effect name, bare `reject()`,
  and a `match` to unwrap the Result.
- `handler-chain` — raise a named interrupt (`raise notes::archive(...)`,
  `raises <notes::archive>`), call it under an inner handler that approves
  inside an outer handler that rejects for large counts, and say in a doc
  comment what happens when they disagree. Judged on the raise and handle
  syntax and on knowing the rule: every handler in the chain runs, and any
  reject wins.
- `docstrings-unasked` — a to-do list module whose three exported defs
  will be given to an `llm` call as tools. The assignment never mentions
  docstrings. Judged: every exported def has one, it reads as a tool
  description (when to call it, what to pass), and it is short.
- `named-config-params` — a catalog search over a seeded `records.agency`
  with four settings (limit, offset, order, includeArchived). The holdout
  passes settings by name and binds them with `search.partial(...)`, so an
  options-object solution fails four of five cases with "Unknown named
  argument".
- `no-js-array-methods` — filter, sort, map, and fold over a list of orders.
  The assignment says nothing about how. Judged: list comprehensions and
  stdlib block-taking functions, never a JavaScript array method with a
  callback (`.filter(\o -> ...)` typechecks and crashes at run time).
- `restrict-with-partial` — `deleteFiles(paths, dryRun = true)` over a
  seeded `logs/` directory. The holdout locks each parameter with
  `.partial()` and checks a dry run leaves the files alone; the judge checks
  the default is the safe value and the delete is left for the caller to
  approve.
- `loop-forms` — a one-expression map, a multi-statement map, and an
  early-exit search over orders. The assignment says nothing about loops.
  Judged: comprehension, then inline block, then full block, and a plain
  loop only for the early exit.
- `static-globals` — a rate table two functions share, and a per-run
  history, nothing said about static. Judged: the table is `static const`, the history is a plain
  global, neither is exported.
- `interrupt-before-danger` — post a comment through a seeded stub that
  cannot unsend. The holdout rejects everything and checks nothing was
  sent; the judge checks a named interrupt is raised first, declared with
  `raises`, and left to the caller.
- `destructive-markers` — a price lookup and a card charge over a seeded
  stub. Judged: `idempotent` on the lookup, a `destructive { }` region
  around the charge, the interrupt outside the region.
- `concurrency-forms` — all results, the first result, and two independent
  refreshes over slow stubs. Judged: `fork`, `race`, `parallel`.
- `stdlib-knowledge` — group, distinct, count, and a number range over file
  entries. Judged: `groupBy`, `unique`, `count`, `range`, and `extname`
  from std::path instead of hand-written versions.
- `guards` — summarize documents with a slow stub, one of which must time
  out alone. The holdout checks the slow one yields "timed out" and the
  rest finish; the judge checks a per-call `guard(time: 500ms)` read with
  `match`.
- `module-basics` — use a seeded `greet` and write `greetAll` for other
  files to call, with neither `import` nor `export` named. The holdout catches the two module mistakes seen most: no `export`, and
  `./greeting` without `.agency`.
- `result-handling` — sum amounts from a seeded `parseAmount` that returns
  a Result, stopping at the first failure. The holdout checks both branches
  and that the message survives; the judge checks the Result was narrowed,
  not unwrapped.
- `program-shape` — a `node main(numbers: string)` program that sums a
  comma-separated list, prints, and returns. The holdout imports the node
  and calls it with and without numbers.
- `effect-payload-types` (weight 0.6) — the `handler-chain` raise again,
  judged on declaring the payload with an `effect` block.
- `derived-tool-names` (weight 0.6) — two `.partial()` copies of one
  function as separate tools. Judged: `.rename()` and `.describe()` on each.
- `docstrings-knows-how` (weight 0.8) — the to-do module with descriptions
  asked for. Judged: docstring inside the body, an `@param` line per
  parameter, short.
