# safeBash: a command after `cd x && a;` gets narrow questions

Date: 2026-11-22. Status: built on the branch `adit/safebash-cd-ends-line`.

## The problem

The model often writes a line in this shape: move into a folder, run something, then look at the result.

```
cd packages/agency-lang && pnpm run agency probe.agency > /tmp/probe.out 2>&1; tail -5 /tmp/probe.out
```

safeBash asks the broad `std::bash` question for this line, which shows the whole text and can only be approved as a whole. The reason it gives is:

> a command after `;` follows a `cd`, and its directory depends on whether the `cd` worked

In `~/.agency-agent/perry-log.jsonl`, 15 logged lines still ask the broad question when planned with today's code. Five of them ask it for this reason. All five were answered by hand on 2026-11-22. No other reason accounts for more than two.

## Why the rule exists

Take `cd x && a; b`. Bash reads it as two commands: `cd x && a`, and then `b`. When the `cd` fails, bash skips `a` and still runs `b`, in the folder the line started in.

safeBash asks its questions before anything runs. The question for `b` names a folder: `tail -5 out.txt` asks `std::read` for `x/out.txt`. If `b` might run in the old folder instead, that question could be false, and safeBash never asks a question that could be false. So it asked the broad one.

The same reasoning refuses `cd x && a || b`, where `b` runs after either the `cd` or `a` failed.

## What has changed since the rule was written

The rule dates from when bash ran the whole line as one script. Since #1529 to #1532, safeBash runs a line one step at a time, and it runs each `cd` itself (`runCd`). Before a `cd` moves, `runCd` resolves its folder again. If the folder is gone, or now leads somewhere else, the line stops there with a message. This already happens for a `cd` in any position.

So for `cd x && a; b`, the case the rule protects against cannot happen any more: `b` never runs in the old folder after a `cd` that failed. The refusal is left over from the old design.

`runCd` does not check that the folder can be entered. When the folder exists and cannot be entered, the line moves there, and each later command fails to start in it. No question is false in that case either: each command runs in the folder its question named, or fails there.

One case is still open. A `cd` can be skipped without failing:

```
pnpm build && cd dist && ls; cat out.txt
```

When `pnpm build` fails, bash skips the `cd` and `ls`, and then runs `cat out.txt` in the starting folder. The question that was asked named `dist/out.txt`.

## The proposed rule

**A command runs only in the folder it was planned in. When the line reaches a command and is in a different folder, the line stops there.**

"The folder it was planned in" is the folder safeBash used to write the command's questions. The runner already knows both folders: each step records the folder of its plan (`RunStep.cwd`, `CdStep.cwd`), and the runner tracks the folder the line is in (`StepsState.cwd`).

A `cd` is a command too, so the rule covers it. In `false && cd sub; cd other && ls`, the second `cd` was planned in `sub`, and the line stops before it.

With that check in the runner, the refusal "a command after `;` follows a `cd`" in `classifyAll` is not needed, and it is deleted. Every command after the `cd` is then planned in the new folder, as the commands joined with `&&` already are.

The change removes a special case and adds none. It adds no command list and names no position.

The matching refusal for `||` stays for now. The reason is in "What does not change".

## What the user sees

| Line | Today | After |
| --- | --- | --- |
| `cd lib && ls; ls` | `std::bash` | `std::ls` for `lib`, twice |
| `cd lib && pnpm test > /tmp/out.txt 2>&1; tail -5 /tmp/out.txt` | `std::bash` | `std::exec`, `std::write`, `std::read` |
| `cd lib && pnpm test 2>&1 \| tail -20; echo ---` | `std::bash` | `std::exec` |
| `pnpm build && cd lib && ls; echo finished` | `std::bash` | `std::exec`, `std::ls` |
| `cd lib && ls; cd .. && ls` | `std::bash` | `std::ls`, twice |

The "today" column is what `planFor` returns on main now. The "after" column is what I expect, and each row becomes a test.

The questions themselves are the ones these commands ask anywhere else. No effect is new, and no payload changes shape.

## Where the result differs from bash

Only when a `cd` does not happen. Bash would carry on in the old folder. safeBash stops the line.

```
pnpm build && cd dist && ls; cat out.txt
```

If `pnpm build` fails:

- **Bash** prints the build's error, then runs `cat out.txt` in the starting folder.
- **safeBash** prints the build's error, then stops with a sentence like this:

> Stopped before `cat out.txt`: it was planned to run in /repo/dist, and the line is still in /repo, because the `cd` before it did not run. `pnpm build` already ran. Run the rest as a new command if you still want it.

I think this is what the writer of the line wants. A command written to run in `dist` is not useful in the folder above it, and it could do harm there.

When every `cd` in the line happens, the line runs exactly as bash runs it.

The stop applies to any command, including one that does not care about its folder. `pnpm build && cd dist && ls; echo finished` stops before `echo finished` when the build fails. Exempting such commands would be a second rule, and the build's failure is already in the output.

A stop is reported as a failure of the line, and the output of the steps that ran is kept, as with the stop safeBash already has.

## What does not change

- **`||` after a `cd`**, as in `cd lib && ls || echo no`. The same rule would make it narrow, but the refusal would have to stay for a group inside a pipeline, such as `(cd lib && ls || echo no) | head`: bash runs that pipeline in one step, so the runner cannot stop in the middle of the group. That would leave a refusal with a condition on it. No logged line uses `||` after a `cd`, so it waits until one does.
- **A `cd` on either side of `||`**, as in `cd lib || echo no` and `test -d out || cd lib; ls`. It stays broad for the reason it is broad today: a `cd` there is treated as a plain builtin, which `execEffects` refuses.
- **A group inside a pipeline that bash runs.** `(cd lib && ls) | head` is narrow today and stays narrow. `(cd lib && ls; ls) | head` is broad today, because the bash parser rejects a `;` inside parentheses. This change relies on that: if the parser is fixed, such a group needs its own rule first. A test pins it.
- **A shell that cannot start in the line's folder.** After `cd x &&` the line carries on, as bash would, and after a `cd` on its own line it stops (`CdStep.guarded`). Both stay as they are.
- **Parentheses.** A `cd` inside a group still ends at the closing parenthesis. A stop inside a group stops the whole line, as it does today.
- **Jobs.** A job runs one command, or a `cd` and one command. A line with more steps asks the broad question as a job, as today.
- **`cd` to a folder that does not exist when the line is planned**, `cd -`, `cd $VAR`, and `cd` alone. All broad, as today.

## Interrupts and safety

- **Everything is still asked up front.** `approvedPlan` raises every question of the line before the first step runs. The runner raises nothing, and this change adds no raise. No handler is skipped or bypassed.
- **No question can be false when its command runs.** That is the property the old refusals protected. The new check protects it at the moment it matters: just before each command.
- **The check covers commands safeBash runs itself.** A step bash runs is already planned again before it starts, and that check compares folders (`folderChange`). A step safeBash runs itself, such as `cat out.txt`, is not planned again, and its folder was fixed when the line was planned. Without the new check it would read `dist/out.txt` after a skipped `cd`. That read was approved, so it is not a hole, but it is not what the line says. The new check stops it.
- **`rm` after a `cd`.** An `rm` is checked twice. The refuse wall in `planLine` judges it from the line's starting folder. `removeEffects` judges it again from the folder `classify` gives it, which follows the `cd`, and a target it would refuse from there gets no `std::remove`: the line asks `std::bash`. So `cd .. && ls; rm -rf proj`, run from `proj`, asks the broad question. It does today as well, because of the `;` refusal, so the outcome is the same before and after. A test pins it by planning the line only. No test runs a delete.

## The code

All of it is in `stdlib/safeBash.agency`. No type changes, so what the exported `planFor` returns keeps its shape.

1. **`classifyAll`:** delete the refusal. A command that ends in another folder may be followed by more commands.
2. **One helper, called from `runOneStep` and from `runCd`:** before a step runs, compare `state.cwd` with the step's `cwd`. If they differ, stop the line with the sentence above, through the existing `stopBefore`. In `runOneStep` it covers a step bash runs and a step safeBash runs itself. In `runCd` it runs before the folder is resolved again; without it, a relative `cd` after a skipped one would stop with "that folder now leads to…", which tells the model the disk changed when it did not. The two strings come from the same place (the plan's folder, and the folder `runCd` moved to), so they can be compared as text.
3. **Comments that describe the old rule:**
   - `classifyAnd`: "`;` and `||` after it are refused by `classifyAll` and `classifyOr`". Only `||` stays.
   - `classifyAll`: the comment on the refusal goes with it.
   - `tests/agency/safeBash.agency`: the comment over `cdOnItsOwnLineStaysStrict`, which ends with "and `cd x && a; b`", and the comment that says "After `;` or `||` the directory depends on whether the `cd` worked".

`classifyOr` does not change.

## Tests

In `tests/agency/safeBash.agency`, planning only:

- The rows of the table above, each with its outcome and effect names.
- `cdOnItsOwnLineStaysStrict` has two rows that move from broad to narrow: `cd grep-fixtures && ls; cat one.txt`, and the row where a later command moves again and is not last. They move to the test of narrow `cd` lines.
- `cdAnywhereElseIsBroad` does not change. It holds `cd grep-fixtures || ls` and `ls || cd grep-fixtures && ls`.
- `cd lib && ls || echo no` stays broad.
- `(cd lib && ls; ls) | head` stays broad. It passes today because the parser rejects it, and it fails on the day the parser is fixed, which is when the group needs a rule.
- `cd .. && ls; rm -rf <the starting folder's name>` asks `std::bash`, with no `std::remove`.

In `tests/agency/safeBashSteps.agency`, running:

- `cd sub && ls; ls` prints both listings of `sub`, and matches real bash.
- `false && cd sub; cat one.txt` stops before `cat`, prints nothing from `sub`, and its message has the new sentence ("planned to run in … and the line is still in …"). This is the step safeBash runs itself.
- `false && cd sub; ls | wc -l` stops with the same sentence. This is the step bash runs. The existing `folderChange` check would also stop this line, with "that folder now leads to…", so the test asserts the new sentence and fails without the new check. The test also plans the line and checks that the step's `inProcess` is null, so it cannot quietly become a second copy of the `cat` test if `wc` moves in process.
- `false && cd sub; cd other && ls` stops before the second `cd`, with the new sentence.
- `(false && cd sub && ls); ls` prints the listing of the starting folder.
- `false && cd sub && ls; echo finished` stops before the `echo`.
- A line run from `.`, from a relative folder, and from a folder reached through a link does not stop.

In `tests/agency/safeBash-corpus.json`, two new rows for the logged shapes: the line with `> /tmp/out.txt 2>&1; tail -5 /tmp/out.txt`, and the line with `2>&1 | tail -20; echo ---`. No existing row changes.

## Docs

The `cd` section of `docs/dev/stdlib/safe-bash.md` is rewritten around the new rule. It loses the paragraph that explains the `;` refusal and gains the rule and the stop. The section should end up shorter.

That section also says that after `;` or a newline "safeBash adds a guard that ends the script". Nothing runs that guard. The rewritten section says the runner stops the line, and presents the guard only as text that appears in the log record.

## Two things settled by the architecture review

1. **The stop keeps its label.** The existing stop ends with the line `[stopped: the plan changed]`, and its failure has the type `planChanged`. For a skipped `cd` the plan did not change, but `lib/stdlib/agentToolTrace.ts` matches that exact line to show the call as stopped. A second label would need a second pattern there and a second failure type, for a rare case. The sentence above the label says what happened.
2. **`cdOrExit` is left alone.** A `cd` on its own line is rewritten as `cd '/abs' || exit 1` in the line's rebuilt text. Nothing runs that text: it is read only by the log record and by tests, and the runner runs each `cd` itself. Removing it touches several tests and is a separate cleanup.

## Size

Half a day: the change is one deletion and one check that runs in two places, and most of the time is tests and the doc. One pull request.

## What comes after

Once this lands, the first example line asks three narrow questions: `std::exec` for `pnpm run agency`, `std::write` for `/tmp/probe.out`, and `std::read` for the same file. The owner's saved policy approves neither of the first two. That is the next piece of work, on the recommended policy, and it is not part of this spec.
