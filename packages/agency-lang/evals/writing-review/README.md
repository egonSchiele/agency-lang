# writing-review: an eval suite for prose reviewers

The prose sibling of `evals/typescript-review`: a reviewer of writing
readability, judged on whether it catches text that loses its reader
without inventing findings on clear prose.

The suite describes the job. It does not name an agent. A reviewer is
scored on it through an eval entry node with the contract below; the
stdlib's `writingReviewAgent` carries one (`evalMain` in
`stdlib/agents/writing/review.agency`), and any other implementation
supplies its own.

## Run it

```bash
pnpm run agency eval run \
  stdlib/agents/writing/review.agency:evalMain \
  --suite evals/writing-review \
  --out runs/writing-review

pnpm run agency eval grade runs/writing-review
```

## The contract

Input, the entry node's single parameter (`WritingReviewEvalInput` in the stdlib
module):

```
{ "assignment": string, "sourceFile": string }
```

`assignment` says who the text is for and what it must get across.
`sourceFile` names a file the test seeds into the working directory from
its `files/` directory. Output is the stdlib `Feedback` shape:
`error: true` marks a passage the reader will misread or lose, anything
else is advisory polish.

## Grading

Each test carries a one-liner `graders.ts` over the shared library in
`lib/reviewGraders.ts`. A planted test's ground truth is the author's
written `reason` for what makes the text hard to follow; its graders check
that an error finding exists (`rejects`), that the findings point at the
planted passages (`names-the-flaw`), and that no error finding objects to
clear prose or a matter of taste (`no-invented-errors`). A clean test
checks the reviewer rejects nothing (`rejects-nothing`). Both kinds judge
advisory findings for usefulness (`advisory-useful`), passing vacuously
when there are none.

## Growing the suite

Harvested tests: a before/after pair from a real editing round, where
"before" is the text as first written, "after" is the text after feedback,
and the editing note is the `reason`. A harvested test is just a planted
test whose reason and text came from history instead of being authored.
