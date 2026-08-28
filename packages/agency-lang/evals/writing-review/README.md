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

## How it's set up

Each input has an assignment and a source file:

```
{ "assignment": string, "sourceFile": string }
```

The story we are giving is that the assignment was given to an agent, and the source file contains the text that the agent wrote. The review agent now needs to review the text in the source file.

## Grading

Each test carries a one-liner `graders.ts` that uses the helpers in the shared library in `lib/reviewGraders.ts`.

The grader that matters most is `recommends-cuts`. Most bad technical prose is not badly phrased; it says things the reader did not need. A reviewer that only fixes sentences leaves that problem in place, so this grader compares the original with the editor's version in `graderFiles/cleaned.md` and checks whether the findings call for the same cuts. A test with a `cleaned.md` gets it automatically through `harvestedGraders()`; a planted test can add it by hand, as `overloaded-paragraph` does.

The reviewer is three LLM passes run in parallel: the main pass (misreadings and sentence-level fixes, `review.agency`), a cuts pass that only says what the reader does not need (`cutsPrompt`), and a tics pass (`ticsPrompt`), all in `stdlib/agents/writing/review.agency`. `recommends-cuts` is what the cuts pass exists for.

The `tics-*` tests, and the older tic tests `also-answers-to`, `costs-no-parse`, and `correction-before-checking`, plant verbal tics from the reviewer's tics pass. Tics are always advisory, and a cut is advisory unless a whole piece or section should go, so `harvestedGraders()` has no `rejects` grader; the editor's points are the ground truth. `rejects` stays on the planted-flaw tests. `tics-control` is plain prose on the same kind of subject; a reviewer that flags every colon or "only" fails its `rejects-nothing` grader.

The `comment-*` tests are doc comments harvested from a real pull request, with the owner's rewrite and notes: a sentence that stops short or lands its verb abruptly, and a sentence that holds its only signpost until the last word.

`names-the-flaws` reads `graderFiles/notes.md` one point at a time: each top-level bullet (`- ...`) is one editor's point, and notes with no bullets count as a single point. Write one point per bullet, and say why a passage should go, not just that it should. The judge is asked about each point separately, so it cannot pad the list with the reviewer's own findings, which it did when asked to enumerate the points itself.
