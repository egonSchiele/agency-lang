# smoke

Small, cheap, deterministic eval tests. These are not a benchmark. Where
`terminal-bench-mini` asks whether an agent is *good*, this suite asks whether
anything is *working* — so that when a run goes red, you can tell in about a
minute whether the problem is your change or the harness.

They live in their own directory for a practical reason: `--inputs <dir>` runs
everything in the directory, and mixing a two-cent canary with an eighteen-minute
discriminator means you can never run just the fast set.

Every test grades itself with the `graders.ts` beside its `test.json`, so no
suite-level grader is named anywhere. Running and grading are two commands:
`eval run` writes a run directory and prints its path, and `eval grade` scores
it.

```bash
# the whole suite
agency eval run --agent path/to/agent.agency:main --inputs evals/smoke
agency eval grade runs/<run-id>        # the path eval run printed

# one test
agency eval run --agent path/to/agent.agency:main --inputs evals/smoke/hello-file
agency eval grade runs/<run-id>
```

## The ladder

Each test proves one thing the previous one could not.

| Test | Proves | Grading |
|---|---|---|
| `hello-file` | The pipe is alive end to end: workdir seeding, the tool loop, the statelog, record extraction, file grading. | `out.txt` is exactly `hello world`. |
| `csv-total` | The test's **fixture reaches the agent**. `hello-file` never opens `files/`, so it cannot catch a seeding regression. | `answer.txt` is the total of the CSV's `amount` column. |
| `find-the-needle` | The search tools work, and the agent looks instead of guessing. | `answer.txt` is the path of the one file containing the marker. |
| `fix-failing-test` | The **edit → run → verify** loop. The grader runs the suite itself rather than believing a claim of success. | `node test.cjs` exits 0, with `test.cjs` unmodified. |

`fix-failing-test` is the one that fails for a reason worth caring about: it
targets the dominant non-capability failure from the terminal-bench reliability
analysis — writing a change and never running it. The seeded bug is a
`[...numbers].sort()` with no comparator, so `median([10, 2, 33, 4])` returns
17.5 instead of 7. Two of seven cases fail; a numeric comparator fixes all of
them.

## Reference solutions

Every test ships a `solution.agency` that produces the right answer with **no
LLM**. Running and then grading one must score 1.000:

```bash
agency eval run --agent evals/smoke/csv-total/solution.agency:main \
  --inputs evals/smoke/csv-total --run-id csv-solution
agency eval grade runs/csv-solution
```

That makes "is the harness broken or is the agent broken?" one free run apart —
the same role terminal-bench's `solution/solve.sh` plays. `csv-total`'s solution
deliberately reads and sums the seeded CSV rather than writing a known constant,
because the seeding is the property that test exists to check.

## Notes for anyone adding a test here

**Keep it deterministic and grader-checkable.** Nothing in this suite should
need an LLM judge. If a test needs a judge to grade it, it belongs in
`terminal-bench-mini` or a suite of its own.

**Fixture scripts must use `.cjs`.** This package is `"type": "module"`
(`package.json:93`), and Node resolves a `.js` file's module system by walking
*up* to the nearest `package.json` — which, for a workdir nested under this
repo, is this one. A `.js` fixture using `require` would break in a way that has
nothing to do with the agent.

**Pin fixture facts with a tripwire grader.** `csv-total` and `find-the-needle`
each carry a `fixture-is-consistent` gate that checks the seeded files still say
what the grader expects. Without it, editing a fixture and forgetting the
constant makes every run fail as though the agent had done badly.

**A failed `mustPass` gate short-circuits the graders after it** (verified:
`grading.json`'s `graders` list is truncated at the failed gate). Order gates
cheapest-first, and put anything expensive last.
