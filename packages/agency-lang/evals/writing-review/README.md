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

`names-the-flaws` reads `graderFiles/notes.md` one point at a time: each top-level bullet (`- ...`) is one editor's point, and notes with no bullets count as a single point. Write one point per bullet, and say why a passage should go, not just that it should. The judge is asked about each point separately, so it cannot pad the list with the reviewer's own findings, which it did when asked to enumerate the points itself.

## Beemo tests

The `beemo-*` tests come from [toloka/beemo](https://huggingface.co/datasets/toloka/beemo): an LLM's answer to a prompt (`files/text.md`) and a professional editor's edit of it (`graderFiles/cleaned.md`). The prompt is the assignment. The editor's notes are ours, written from the diff, since Beemo records the edit but not the reasoning. We strip the `[INST] ... [/INST]` prompt echo that some model outputs begin with; it is a chat-template artifact, not prose. Expert edits are MIT-licensed; the prompts come from No Robots (CC-BY-NC-4.0).
