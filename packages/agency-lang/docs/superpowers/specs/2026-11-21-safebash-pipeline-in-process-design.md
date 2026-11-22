# safeBash: run a pipeline in process (ADI-261)

Status: draft, waiting for the owner's yes. Nothing is built.

## What this is for

`safeBash` runs a lone `grep` or a lone `cat`, `head`, or `tail` as the
stdlib tool, with no shell. A pipeline never does. This line asks
`std::grep` and then starts bash to run two real programs:

```
grep -rn planFor lib | head -20
```

This design lets that line run with no shell: the stdlib grep runs, and
safeBash keeps the first 20 lines of its text itself.

It is the first step of the direction set on 2026-11-21: safeBash should
run an Agency function for every command it can. A step that runs in
process needs no prediction and no check before it runs, because the
stdlib tool checks its path when it opens it.

**It saves no prompt.** Every line it touches is narrow today and asks
the same question afterwards.

## What I measured first

I collected every shell line the agent ran from the five logs
(`~/.agency-agent/perry-log.jsonl`, `~/perry/log.jsonl`, and the
checkout's three `log*.jsonl`), and the corpus in
`tests/agency/safeBash-corpus.json`. Then I counted the pipelines in
them and the command in each stage.

| | Logs | Corpus |
| --- | --- | --- |
| Distinct lines | 89 | 128 |
| Pipelines in them | 50 | 26 |

The stages after the first `|`:

| Stage | Logs | Corpus |
| --- | --- | --- |
| `head` | 36 | 14 |
| `grep` | 21 | 3 |
| `tail` | 1 | 5 |
| `wc` | 0 | 2 |
| `sort`, `uniq`, `sed`, `awk`, `tee` | 2 | 4 |
| a program (`tv`) | 3 | 0 |

The first stage:

| First stage | Logs | Corpus |
| --- | --- | --- |
| `grep` | 10 | 8 |
| `git` | 10 | 4 |
| `find` | 7 | 3 |
| `ls` | 7 | 1 |
| `cat`, `head` | 5 | 4 |
| a program or another tool | 11 | 6 |

Two things follow.

1. **The ticket asks for eight filters nobody uses.** It lists `sort`,
   `uniq`, `cut`, `nl`, `tac`, `rev`, `tr`, and `wc`, each with a test
   that compares it to the real program. Together they appear 4 times in
   76 pipelines. `head`, `grep`, and `tail` appear 80 times, and the code
   that prints `head` and `tail` exists already.
2. **Most logged pipelines sit inside a longer line.** Only 9 of the 29
   distinct logged lines with a pipe are a lone pipeline. The usual shape
   is several searches joined by `; echo ---;`. So a rule for a lone
   pipeline only, as the ticket has it, would reach almost nothing.

## The rule

A pipeline is one step of a line. That step runs in process when both of
these hold:

- **The first stage is a command that already runs in process on its
  own.** That is a `grep`, `cat`, `head`, `tail`, or `echo` that
  `tryShellFreeStep` accepts today. Nothing about that decision changes.
- **Every later stage is a `head`, a `tail`, or a `grep` that names no
  file**, with flags from the short lists below.

Any other pipeline runs through bash as it does today.

| Line | Today | After |
| --- | --- | --- |
| `grep -rn planFor lib \| head -20` | `std::grep`, bash | `std::grep`, no shell |
| `cat package.json \| grep version` | `std::read`, bash | `std::read`, no shell |
| `head -20 package.json \| tail -5` | `std::read`, bash | `std::read`, no shell |
| `grep -rn a lib \| grep -v test \| head` | `std::grep`, bash | `std::grep`, no shell |
| `grep -rn a src \| head; echo ---; grep -n b x.ts` | `std::grep` twice, bash | the same, no shell |
| `git log --oneline \| head -5` | `std::git::log`, bash | unchanged |
| `find lib -name "*.ts" \| head` | `std::ls`, bash | unchanged |
| `sort package.json \| uniq -c \| head` | `std::read`, bash | unchanged |
| `pnpm build && cat out.txt \| head` | bash | unchanged, waits for ADI-360 |

The fifth row needs one small change. The step runner already runs a
line with no shell when every step is in process (`allInProcess`), and a
pipeline is one step. But the function that splits such a line into
steps (`linksOf`) accepts only simple commands today, so it has to
accept a pipeline as one link.

### The later stages

- **`head` and `tail`:** no flag, `-N`, or `-n N`. These are the counts
  the lone forms accept, printed by `_renderReadView`.
- **`grep`:** one pattern and no file, with any of `-v`, `-i`, `-E`,
  `-F`, and `-w`. The pattern becomes a regular expression through
  `_grepPatternToRegex`, which the lone grep uses. A flag that changes
  the output's shape (`-c`, `-n`, `-o`, `-l`, `-A`, `-B`, `-C`) keeps the
  pipeline on the bash path.

### What the person is asked

Nothing new and nothing different. A pipeline asks its first stage's
question today, and a later stage that names no file asks nothing. Both
stay true. Every question is raised up front in `approvedPlan`, before
anything runs, and the runner raises nothing.

## Where the output can differ from bash

These are the places a person or a model could notice.

- **A failing first stage.** In bash, `cat gone.txt | head` prints the
  error and `head` still exits 0. A missing file is found when the line
  is planned, and that line goes to bash, so nothing changes there. A
  read that fails later (the file was removed after approval) fails the
  step with the read tool's message and status 1.
- **Exit status.** It is the last stage's, as in bash: 0 after `head` or
  `tail`, and 1 after a `grep` that matched no line.
- **A grep that skips folders.** The stdlib grep skips ignored folders
  such as `node_modules` and says so in a note. A lone `grep -rn x .`
  already works this way. The same search followed by `| head` runs real
  grep today, which searches `node_modules`. After this change the two
  spellings agree. The note is printed after the last stage, so `| head`
  cannot cut it off.

## How it is built

- **One new execution kind** beside echo, write, grep, and read:

  ```
  export type PipeExec = {
    kind: "pipe";
    first: EchoExec | GrepExec | ReadExec;
    filters: TextFilter[]
  }

  export type TextFilter =
    | { kind: "view"; view: ReadView }
    | { kind: "match"; pattern: string; flags: string; invert: boolean }
  ```

  `ReadView` is the existing type, so `head` and `tail` reuse
  `_renderReadView` with no change.
- **One new function for the grep stage**, `_filterLines(text, filter)`
  in `lib/stdlib/grepDialect.ts`, beside the pattern translation it
  uses.
- **`printStep` gains one arm.** It prints the first stage with the code
  that prints it alone, then applies each filter to the text.
- **`tryShellFreeStep` is tried on a pipeline's first stage**, and the
  later stages go through one new function that returns a filter or
  "not this path".

The ticket's own list of gates stays as written, except the two this
design changes: the pipeline need not be the whole line, and the filter
list is three commands.

## Tests

- **Parity with the real programs**, in the style of
  `shellFreeReadMatchesRealTools`: each row runs the line in process and
  under real bash and compares the text and the exit status. It covers
  `head` and `tail` with each count spelling, `grep` with each flag, a
  pattern that matches nothing, an empty first stage, and a file with no
  final newline.
- **No shell starts** for the three lines in the ticket that this design
  keeps, and for the `; echo ---;` line above.
- **Each line in the "unchanged" rows still plans as it does today.**
- **A rejected question runs nothing**, as for a lone grep.

## Not in this design

- **A bash first stage with an in-process later stage**
  (`git log | head -5`). The ticket lists it as done-when. A shell
  starts for `git` either way, so handing its text to an in-process
  `head` removes nothing. I recommend dropping it.
- **`sort`, `uniq`, `cut`, `nl`, `tac`, `rev`, `tr`, `wc`.** 4 uses in 76
  pipelines. Each needs its own comparison with the real program, and
  `sort` depends on the locale.
- **A mixed line** (`pnpm build && cat out.txt | head`). That is ADI-360.

## Two decisions for the owner

1. **`2>/dev/null` on the first stage.** 4 of the 10 logged pipelines
   this rule could reach are written
   `grep -rn x lib 2>/dev/null | head`. A lone grep with any redirect is
   not in process today, so those 4 stay on the bash path unless the
   rule accepts this one redirect. I recommend accepting it, for the
   lone grep as well: an in-process grep that succeeds prints nothing to
   stderr, so the redirect changes nothing. The one difference is that a
   read failing after approval shows its message where bash would have
   hidden it.
2. **What comes after this.** The first stage is `find` or `ls` in 18 of
   the 76 pipelines and `git` in 14. The stdlib has `ls` and `glob`
   tools. Moving `ls` and `find` in process would reach more logged
   lines than the eight filters would, so I would do that next and leave
   the filters until a log shows them.
