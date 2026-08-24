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

There are no `graders.ts` modules here. Each test carries a hidden harness
pair in its `holdout/` directory — a `<name>.agency` importing the saved
`outFile`, and a `<name>.test.json` naming node-by-node expected outputs.
The framework discovers the pair and grades the run's working directory
with `agency test --agency-only --reject '*'` (an `AgencyTestGrader`, one
per pair). Grading is all-or-nothing: the grader is a must-pass gate, so a
test's objective is 1 only when every case passes and 0 otherwise. The
grader's own row in the report still shows the passing fraction and names
each failing case, which is why the stdlib's `evalMain` saves even a
failed run's last draft — the report then says exactly what the draft got
wrong. `holdout/` is
never seeded into the working directory, so the writer cannot code to the
oracle. A pair placed in `files/` instead would be visible to the writer —
useful later for tests about working against a given spec-by-example.

Every harness is verified at authoring time: the reference solution passes
all its cases, and a representative wrong solution fails.

## The tests

- `sum-multiples` — a pure arithmetic loop (sum multiples of 3 or 5 below
  n). The easiest kind of deliverable: one exported def, no state.
- `reverse-digits` — digit manipulation that needs a while loop and
  integer division built by hand (Agency has no C-style `for`, and the
  stdlib has no `floor`), so JS reflexes do not transfer directly.
