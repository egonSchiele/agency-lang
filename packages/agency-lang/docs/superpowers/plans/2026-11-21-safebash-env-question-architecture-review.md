# Architecture review: safeBash asks `std::env` for a variable

Reviewed: `docs/superpowers/plans/2026-11-21-safebash-env-question.md` and its spec.

## Summary

The plan would work, but it is larger than the problem. I measured how often a real line echoes an environment variable, which I should have done before writing the spec, and the answer is never. So the work only closes a leak, and there is a way to close the same leak in about five lines by giving `echo` the rule `printf` already has. I recommend that way. The details are under "The 80/20 rule".

## What I measured

- **The corpus** (`tests/agency/safeBash-corpus.json`, 128 lines taken from real use): one line echoes an environment variable, and it is the row that was added to record this very gap (`git status && echo $GITHUB_TOKEN`). One other line echoes `$?`, which the plan leaves alone.
- **The logs** (`~/.agency-agent/perry-log.jsonl`, `~/perry/log.jsonl`, and the checkout's `log*.jsonl`): no `echo` or `printf` line with a variable in it.

The search of the logs was a text match, so it could miss an unusual spelling. It would not miss `echo $HOME`.

## Major features and API

The plan touches three things that many users rely on.

1. **The `recommended` policy.** It gains a rule that approves `std::env` for ten names. That rule also answers the `env` tool, so `env("HOME")` stops asking under `recommended`. The owner approved this. It is still a change to the default behaviour of every agent session, made to support lines that do not occur.
2. **The exported effect set `SafeBashEffects`.** It gains `std::env`. A user function that calls `safeBash` and writes `raises <SafeBashEffects>` is unaffected. One that lists its effects by name is not: `stdlib/workflow.agency` does this near line 1286, and the plan already expects to edit it. Any program outside this repository that lists the effects by name would get the same compiler message after it upgrades.
3. **What `std::env` means.** Today it means "the `env` tool is about to read this variable". Under the plan it would also mean "a shell is about to expand this variable". A handler that approves `std::env` because it trusts the `env` tool's own checks would now be approving a shell expansion too. The two are the same read, so I think this is acceptable, but it is a widening of an existing effect.

## Effort and impact

| Task | Effort | Impact | Must do? |
| --- | --- | --- | --- |
| 1. The classifier adds `std::env` | about half a day | closes the leak | the leak must be closed; this way of closing it is optional |
| 2. `recommended` approves ten names | one to two hours | removes a prompt from lines that do not occur | optional |
| 3. Documentation | one hour | needed for whatever is built | yes |

Task 2 is the one to drop. It adds a list of "names that hold no secret" to the default policy, and someone has to decide for each new name whether it belongs. Nothing in the logs would use it.

## The 80/20 rule

The goal is that a narrow line cannot print an environment variable with no question.

`printf` already meets that goal. `printfWordsFit` refuses any argument that is not literal, apart from `$?`, so the line has no rule and asks `std::bash`:

```
git status && printf '%s' $GITHUB_TOKEN     # asks std::bash today
```

`echo` can use the same check. In `verbEffects`, the `echo` arm would fail with "an `echo` word is not literal" when one of its words does not pass `knownOrExitStatus`, which is the function `printf` uses. The result:

| Line | Today | Plan as written | The short way |
| --- | --- | --- | --- |
| `git status && echo $GITHUB_TOKEN` | `std::git::status` (the leak) | `std::git::status`, `std::env` | `std::bash` |
| `echo $HOME` | `std::bash` | `std::env`, approved | `std::bash` (unchanged) |
| `pnpm test; echo "home: $HOME"` | `std::exec` (the leak) | `std::exec`, `std::env`, approved | `std::bash` |
| `pnpm test; echo "exit=$?"` | `std::exec` | unchanged | unchanged |
| `git status; echo $RANDOM` | `std::git::status` | unchanged | `std::bash` |

The short way is about five lines of code, one test node, and a paragraph of documentation. It adds no effect to `SafeBashEffects`, no arm to `raiseOne`, no list of names to the policy, and no second meaning for `std::env`. It also makes `echo` and `printf` follow one rule, where the plan as written leaves them with two: `echo $X` would ask `std::env` and `printf '%s' $X` would ask `std::bash`.

What the short way gives up is the exact question. `git status && echo $HOME` would ask `std::bash` for the whole line, where the plan would ask nothing under `recommended`. The logs say this costs nobody a prompt today.

It also fits the direction the owner set on 2026-11-21: where a prediction is hard, ask the broad question, and move commands in process one at a time. When an `echo` with a variable later runs in process (ADI-360), it would call the `env` tool, and the `env` tool raises `std::env` itself. The exact question then arrives with no code in `safeBash` to raise it.

**Recommendation:** build the short way now, and leave the `std::env` question to arrive with in-process `echo`. This reverses a decision the owner approved on my earlier recommendation, so it needs the owner's yes.

## Reusing code

If the plan is built as written, two things should change first.

1. **A fourth walk over the same word shapes.** `variableNames` would walk `variable`, `doubleQuoted`, and `interpolatedVariable` words. `knownOrExitStatus`, `variableIn` with `firstVariableIn`, and `isLiteralWord` already walk them. The plan says to "share the walk if that comes out shorter", which leaves it to chance. It should say: write one function that returns every variable name in a word, and rewrite `variableIn` on top of it.
2. **A third list of special variable names.** `COMPUTED_VARIABLES` would sit beside `EXIT_STATUS` (`?`) and `SHELL_STATE_VARIABLES` (`_`, `OLDPWD`, and four more). Three lists that each answer "is this name special" is one too many to keep straight. The short way adds none.

`lib/compiler/splice/runGenerator.ts` has a list of variable names, `CHILD_ENV_ALLOWED`. It answers a different question (what a child process needs in order to start), and it should not be shared with a policy rule. A change to one must not change the other.

## Concepts

The plan adds one concept a user has to learn: "`recommended` trusts these ten variable names". The short way adds none; it extends a rule the user already meets with `printf`.

## Documentation and tests

Sized correctly for either choice. The plan's three run tests are worth keeping only if the plan is built as written; the short way needs one planner node and no run test, because no new question is raised.
