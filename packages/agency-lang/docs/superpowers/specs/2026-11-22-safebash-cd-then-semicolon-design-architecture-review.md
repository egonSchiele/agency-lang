# Architecture review: a command after `cd x && a;` gets narrow questions

Date: 2026-11-22. This reviews the spec beside it, `2026-11-22-safebash-cd-then-semicolon-design.md`.

**Verdict:** the core of the spec is sound and small. Two of its four code changes should be cut, because neither has a logged use and each costs something. One test is missing. Both "small decisions" can be settled from the code.

## What the change touches

`safeBash` is the shell tool of `agency agent`, so it is one of the most used functions in the package. The change is deliberate and narrow: a class of lines moves from the broad `std::bash` question to the narrow questions their commands ask elsewhere. No effect is added and no payload changes shape.

One consequence is worth saying out loud. A line that asked `std::bash` always reached a person, because the recommended policy does not approve that question. After the change, the same line asks narrow questions, and the policy may approve all of them. So some lines that stopped for a person will now run with no prompt. That is the goal, and each narrow question is true when its command runs, but it is the change a reader of the pull request should look at hardest.

The exported `planFor` returns the same types as before, as long as finding 2 below is taken.

## Effort and impact

| Part of the spec | Effort | Impact | Keep? |
| --- | --- | --- | --- |
| Delete the `;` refusal in `classifyAll` | one deletion | 5 of the 15 logged broad lines | yes |
| The folder check in `runOneStep` | about five lines | makes the deletion safe for a skipped `cd` | yes |
| Relax the `\|\|` refusal in `classifyOr` | small, but adds a condition | no logged line | **cut** |
| Delete `guarded` and `missingFolderStops` | small | none for a user | **cut** |

## Findings

### 1. Cut the `||` half

`cd x && a || b` appears in no logged line. All five logged lines use `;`.

Relaxing it is what forces the one carve-out in the spec: the refusal has to stay when `line.byBash` is true, because bash runs a group inside a pipeline whole and the runner cannot stop in the middle of it. That leaves a refusal with a condition on it, which is the kind of rule we said safeBash should not collect.

Without the `||` half, `classifyOr` is not touched, and the spec needs no carve-out at all: `classifyAll` only ever sees the top-level list, which the runner always steps through.

The cost is that `cd lib && ls || echo no` stays broad. If a log shows it later, it can be added then, with the carve-out weighed against real use.

### 2. Cut the deletion of `guarded` and `missingFolderStops`

The spec says the new rule makes these unnecessary. They are not needed for the rule, but removing them is a separate behaviour change: today, when a shell cannot start in a folder after `cd x &&`, the line carries on as bash would, and after the change it would stop. That case needs a folder that exists and cannot be entered, so no user will notice either way.

What it does cost: `CdStep` is an exported type, and `planFor` is exported. #1535 and #1539 already changed the shape `planFor` returns. A third change in a week, for a flag nobody is hurt by, is not worth it.

### 3. A missing test: a `;` inside a group that bash runs

The spec relies on a `;` list never appearing inside a group in a pipeline, as in `(cd lib && ls; ls) | head`. Today that holds only because the bash parser rejects a `;` inside parentheses, which is a known gap in the parser and not a safeBash rule. If the parser is fixed, that line could get narrow questions while bash runs the group whole, and a failed `cd` inside it would let `ls` run in the old folder.

Add a planning test that `(cd lib && ls; ls) | head` asks the broad question. It passes today for the wrong reason, and it will fail on the day the parser is fixed, which is when someone needs to look.

### 4. The stop's label is not a decision

The spec offers a second label for the stop. `lib/stdlib/agentToolTrace.ts` matches the exact line `[stopped: the plan changed]` to show a call as stopped. A second label would need a second pattern there, a second failure type, and a second paragraph in the dev doc, all for a case that needs a failed command in front of a `cd`. Reuse the existing stop. The sentence above the label says what happened.

### 5. `cdOrExit` is confirmed dead at run time, and stays out of this change

The spec was unsure. I checked: the rebuilt text of a stepped line (`execution.command`) is read only by the log record in `planRecord` and by tests. Nothing runs it. Each bash step runs the text `checkedStep` rebuilds, and each `cd` is run by `runCd`. So the `cd '/abs' || exit 1` guard is never run by bash, and `guardEndsTheScript` tests a string no code path produces for bash.

Removing it touches several tests that read the rebuilt text, and it has nothing to do with this rule. It should be its own small cleanup.

### 6. A line that ends in `; echo ---` stops too

The model often ends a line with a marker, as in `pnpm build && cd dist && ls; echo finished`. When the build fails, the `cd` is skipped, and the line stops before `echo finished`, though an `echo` does not care which folder it is in.

I would leave this alone. Exempting commands whose plan names no folder would be a second rule. The build's failure is already in the output, and the stop's sentence is accurate. It should be a row in the tests so the behaviour is on record.

## The 80/20 question

The cheapest version is to delete the one refusal and add nothing. For a step bash runs, the existing folder check (`folderChange`) would already stop the line after a skipped `cd`, with a misleading sentence ("that folder now leads to…"). For a step safeBash runs itself, nothing would stop it, and `cat out.txt` would read the file in the folder the `cd` never entered.

The check in `runOneStep` is about five lines and closes both, so the spec's version is the right size. With findings 1 and 2 taken, the whole change is one deletion and one check.

## Reuse

Nothing is added that already exists. The check uses `RunStep.cwd` and `StepsState.cwd`, the stop uses `stopBefore` and `stopMessage`, and no type is added.

The new check overlaps `folderChange` for a step bash runs. They are not the same check and should stay separate: `folderChange` compares real paths, to catch a folder swapped for a link under the same name, and the new check compares the planned folder with the folder the line is in.

## Concepts

One concept is added for a reader of the code: "the folder a step was planned in". It is already a field. For a user and for the model, nothing is new: the stop is the stop they already see.

## Proportion

- **Dev doc:** the `cd` section should get shorter. It loses the explanation of the `;` refusal and gains two sentences on the rule.
- **Tests:** with findings 1 and 2 taken, about eight planning rows and five short runs. That is in proportion.
- **Corpus:** two rows.
