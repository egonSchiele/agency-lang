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
beside `test.json` — a one-liner over the shared library in
`lib/reviewGraders.ts`, so the judge prompts live once and improve for
every test at once. The graders:

- **`rejects` / `no-false-positive`** (deterministic): an `error: true`
  finding exists for a planted bug, and none for clean code. No model is
  consulted, so re-grading it is free.
- **`names-the-bug`** (judged, bug tests): some error finding identifies
  the planted problem. Ground truth is the test's data — the mutation
  diff plus the author's one-sentence reason (`mutantGraders`), or the
  reason alone for hand-planted bugs (`plantedBugGraders`) — never
  free-floating prose.
- **`no-invented-errors`** (judged, bug tests): every error finding is
  the planted problem or genuinely real, judged against the source plus
  the same ground truth.
- **`agency-true`** (judged, every test): every claim the findings make
  about Agency syntax, semantics, or idiom is true of Agency, judged
  against the facts card in `lib/agencyFacts.ts` — the shared, versioned
  statement of what JS-trained models get wrong about Agency. This is
  where "use `===`" costs points, on error and advisory findings alike.
- **`advisory-useful`** (judged, every test): advisory findings are
  accurate, non-generic pointers — performance, idiom, robustness — for
  this code and assignment. Advice is welcome, not demanded: a review
  with no advisory findings passes vacuously.

There is no findings-count metric: noise is graded by quality
(`advisory-useful`), not volume. No grader is a `mustPass` gate: a wrong
verdict costs that grader's share of the score while the others still
run, so improvement shows up incrementally instead of pinning at 0.

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
