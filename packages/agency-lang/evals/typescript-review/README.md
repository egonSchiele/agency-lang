# typescript-review: an eval suite for TypeScript code reviewers

The sibling of `evals/agency-review`, aimed at `typescriptReviewAgent`: a
reviewer of TypeScript readability and architecture, judged on whether it
catches planted problems without inventing findings on clean code.

The suite describes the job. It does not name an agent. A reviewer is
scored on it through an eval entry node with the contract below; the
stdlib's `typescriptReviewAgent` carries one (`evalMain` in
`stdlib/agents/typescript/review.agency`), and any other implementation
supplies its own.

## Run it

```bash
pnpm run agency eval run \
  stdlib/agents/typescript/review.agency:evalMain \
  --suite evals/typescript-review \
  --out runs/typescript-review

pnpm run agency eval grade runs/typescript-review
```

## The contract

Input, the entry node's single parameter (`ReviewEvalInput` in the stdlib
module):

```
{ "assignment": string, "sourceFile": string }
```

`assignment` is what the code under review was asked to do. `sourceFile`
names a file the test seeds into the working directory from its `files/`
directory. Output is the stdlib `Feedback` shape: `error: true` marks a
problem the change should not merge with, anything else is advisory.

## Grading

Each test carries a one-liner `graders.ts` over the shared library in
`lib/reviewGraders.ts`. A planted test's ground truth is the author's
written `reason` for what is wrong; its graders check that an error
finding exists (`rejects`), that some finding names the planted problem
(`names-the-flaw`), and that no error finding objects to reasonable code
or to something a compiler or linter would catch (`no-invented-errors`).
A clean test checks the reviewer rejects nothing (`rejects-nothing`).
Both kinds judge advisory findings for usefulness (`advisory-useful`),
passing vacuously when there are none.

## Growing the suite

The plan is harvested tests: a before/after pair from a real review round,
where "before" is the code as pushed, "after" is the code following review,
and the review comment is the `reason`. A harvested test is just a planted
test whose reason and source came from history instead of being authored.
