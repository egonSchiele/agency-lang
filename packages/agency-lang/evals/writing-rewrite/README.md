# writing-rewrite: an eval suite for the prose rewriter

Scores `std::agents/writing/rewrite` through its `evalMain` node
(`stdlib/agents/writing/rewrite.agency`). The rewriter runs the writing
reviewer and applies its findings, so the output under test is the
rewritten text.

## Run it

```bash
pnpm run agency eval run \
  stdlib/agents/writing/rewrite.agency:evalMain \
  --suite evals/writing-rewrite \
  --out runs/writing-rewrite

pnpm run agency eval grade runs/writing-rewrite
```

## How it relates to writing-review

Each test here is a copy of a `writing-review` test: the same text,
assignment, editor's notes, and cleaned version. The copies are kept in
step by hand; when a reviewer test changes, change the copy too. Only
tests with a `cleaned.md` are included, plus the two clean-text controls,
because the rewrite graders need a ground-truth text to compare against.

The two suites answer different questions. A rewrite can come out well when
the reviewer missed a point, because the rewriting model fixes it anyway,
and can come out badly when the findings were right, because the rewriter
ignores one or invents a fact. Use the reviewer suite to find which half needs
work. Use this suite to measure what a caller gets.

## Grading

`lib/rewriteGraders.ts` holds the graders and `lib/templates.ts` the judge
prompts. Every test runs `produces-text`, a must-pass check that the output
is non-empty text and not the agent's failure message.

Harvested tests (`harvestedRewriteGraders()`):

- `flaws-fixed`: each bullet in the editor's `notes.md` is put to a judge on
  its own: is that problem gone from the rewrite? Share of points fixed.
- `matches-cuts`: what the editor removed (original versus `cleaned.md`)
  must be absent from the rewrite.
- `faithful`: no fact the original and the assignment lack, and every
  identifier kept.

Control tests (`cleanRewriteGraders()`): `leaves-clean-alone` scores how
little the rewrite changed, and `faithful` runs too.
