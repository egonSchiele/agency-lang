# agency-review: an eval suite for Agency code reviewers

The first suite aimed at one stdlib agent rather than the whole agency
agent: a reviewer has one input and one structured output, so it can be
scored cheaply and its failures point at one thing.

The suite describes the job. It does not name an agent. A reviewer is
scored on it through an eval entry node with the contract below; the
stdlib's `agencyReviewAgent` carries one (`evalMain` in
`stdlib/agents/agency/review.agency`), and any other implementation
supplies its own.

## Run it

```bash
pnpm run agency eval run \
  stdlib/agents/agency/review.agency:evalMain \
  --suite evals/agency-review \
  --out runs/agency-review

pnpm run agency eval grade runs/agency-review
```

Add `--trials 3` to get means with error bars. To compare a second
implementation, point the first command at its `file.agency:node`.

## The contract

Every test gives the reviewer the assignment some code was written for and
the file holding that code, and expects findings back.

Input, the entry node's single parameter (`ReviewEvalInput` in the stdlib):

```
{ "assignment": string, "sourceFile": string }
```

`assignment` is what the code under review was asked to do (so it often
reads "Write an Agency program that…"); the reviewer judges the code
against it. `sourceFile` names a file the test seeds into the working
directory from its `files/` directory, so planted sources are ordinary
`.agency` files you can open and typecheck directly.

Output, the entry node's return value. This is the stdlib's `Feedback`
shape (`std::agents/lib/feedback`):

```
[{ "error": boolean, "feedback": string }, ...]
```

`error: true` means "this code does not accomplish the task". Anything
else is advisory.

## Grading

Each test directory carries its own `graders.ts`, picked up automatically
beside `test.json`, so a test states what it expects in code next to the
input it gives. The pattern so far:

- a deterministic verdict check (`rejects` / `no-false-positive`): an
  `error: true` finding exists for a planted bug, and none for clean code.
  No model is consulted, so re-grading it is free;
- an LLM-judged **names-the-bug** on bug tests: some error finding
  describes the planted problem, not just *a* problem;
- where the first run showed invented complaints, an LLM-judged
  **no-invented-errors**: every error finding is real;
- **concise**: at most 5 findings.

No grader is a `mustPass` gate: a wrong verdict costs that grader's share
of the score while the others still run, so a reviewer that improves at
naming bugs or cutting noise shows it even while its verdict is still
wrong, instead of pinning at 0.

## The tests

Every planted source typechecks clean. That is the point: these are the
bugs a reviewer that only runs the typechecker cannot see.

- `fib-off-by-one` (bug): `fib(0)` returns 1.
- `fib-correct` (clean): a correct `fib`; measures false positives.
- `ungated-delete` (bug, Agency-specific): the task says the deletion must
  be left to the caller's handler; the code does `remove(file) with approve`.

## Adding a test

Make a directory with a `test.json` (`description`, `tags`, `files`,
`input`), the planted source under `files/`, and a `graders.ts` beside it.
Typecheck the planted source first (`agency typecheck <file>`); a source
that fails to typecheck tests the typechecker, not the reviewer.
