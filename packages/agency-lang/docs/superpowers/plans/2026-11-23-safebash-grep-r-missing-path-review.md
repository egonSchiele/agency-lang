# Architecture review: `grep -r` of a missing file

Reviews `docs/superpowers/plans/2026-11-23-safebash-grep-r-missing-path.md`. Nothing in the plan has been changed by this review. Finding 1 needs the owner's answer.

## Major features and API

The plan changes which interrupt a line raises: `std::grep` in place of `std::bash`. That is the language's most important feature, and the change is deliberate.

The plan's safety argument is that the runner plans each step again before it runs. I checked that it holds for every way a line runs:

- Every step that bash runs goes through `checkedStep` in `runBashStep` (`stdlib/safeBash.agency:7576`), including a line of one step.
- A background job has no runner, and its one step gets the same check at launch (the comment at line 7544, `jobLaunch`).

No exported name or type changes.

## Finding 1: a line that builds a folder and then greps it gets worse (owner's call)

The plan lists one known behavior, with `mkdir -p out && grep -rn x out`. That example understates it. This one is more likely:

```bash
pnpm build && grep -rn "createRun" dist | head
```

Run it in a fresh worktree, where `dist` does not exist yet.

| | Today | After the plan |
|---|---|---|
| Questions | one `std::bash` for the line | `std::exec` for `pnpm build`, `std::grep` for a file named `dist` |
| What runs | the build, then the grep | the build, then the line stops before the grep |
| What the model does next | reads the matches | runs the grep again as its own line |

The line stops because the plan guessed `dist` would be a file, and after the build it is a folder. The stop is safe. The cost is one more model turn, after a build that may have taken minutes.

There are three ways to treat it:

1. **Accept it.** The plan removes three prompts in a session like the trace. A build followed by a `grep -r` of a folder the build creates, in a tree where that folder is missing, is rarer than a grep of a mistyped file name.
2. **Keep the strict lookup when an earlier command in the line could have created the path.** The first command of a line, or a command after only reads, would get the new rule. That needs the line state to record whether anything before it wrote or ran a program. The dev doc says the plan deliberately does not predict what earlier commands did to the disk, and leaves that to the check before each step, so this goes against that design.
3. **Guess a folder under `-r`.** Then the build line runs whole. But a build line whose output is a file would stop instead, and the prompt for the trace's lines would say "search the folder `lib/runtime/run.ts`", which reads oddly for a file.

I recommend the first. The second is the precise fix and costs new state in the classifier for a rare line.

Outcome: the owner chose the first on 2026-11-23. The plan now records it with the `pnpm build` example, and keeps the end-to-end test as the record of the accepted stop.

## Effort and impact

| Part | Effort | Impact | Must-do? |
|---|---|---|---|
| The change to `readGrep` | about 3 lines | 3 of the 15 broad questions in the trace | Yes |
| `grepRNamesAMissingFile`, plan-level rows | small | pins the rule | Yes |
| `aGrepOfAPathThatBecameAFolderStops`, an end-to-end run | small, one shell run in CI | pins finding 1's stop | Optional |
| Doc update, two paragraphs | small | keeps the dev doc true | Yes |

The end-to-end node is optional. The stop itself is already tested by `aChangedPlanStopsTheLine` and `aChangedFolderStopsTheLine`. The new node adds only the pairing of that stop with a grep. I would keep it if the owner accepts finding 1, since it is then the record of an accepted behavior, and drop it otherwise.

Documentation and CI cost are in proportion: two paragraphs in a 2,700-line doc, and one or two test nodes.

## The 80/20 check

The change is already the small version: three lines for three of the four missing-path prompts. The fourth, a missing file in a missing folder, is left out on purpose.

## Reuse and concepts

Nothing is added. The plan removes a special case: grep with `-r` no longer has its own rule for a missing path, and uses `missingPath` like a grep without `-r` and like the read family. That is one fewer thing to learn.

## Tying concepts together

After the plan, grep's handling of a missing path is tied to `missingPath`. A later change to that rule, such as allowing a missing parent folder, will reach `grep -r` too. That is the right tie, because the reasoning is the same for both.
