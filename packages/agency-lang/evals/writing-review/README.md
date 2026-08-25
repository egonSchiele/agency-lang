# writing-review: an eval suite for prose reviewers

Evals for a prose reviewer. We want clear and readable prose!

## Run it

```bash
pnpm run agency eval run \
  stdlib/agents/writing/review.agency:evalMain \
  --suite evals/writing-review \
  --out runs/writing-review

pnpm run agency eval grade runs/writing-review
```

## How its set up

Each input has an assignment and a source file:

```
{ "assignment": string, "sourceFile": string }
```

The story we are giving is that the assignment was given to an agent, and the source file contains the text that the agent wrote. The review agent now needs to review the text in the source file.

## Grading

Each test carries a one-liner `graders.ts` that uses the helpers in the shared library in `lib/reviewGraders.ts`.

The grader that matters most is `recommends-cuts`. Most bad technical prose is not badly phrased; it says things the reader did not need. A reviewer that only fixes sentences leaves that problem in place, so this grader compares the original with the editor's version in `graderFiles/cleaned.md` and checks whether the findings call for the same cuts. A test with a `cleaned.md` gets it automatically through `harvestedGraders()`; a planted test can add it by hand, as `overloaded-paragraph` does.
