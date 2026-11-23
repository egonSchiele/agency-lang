# Review 2: safeBash globs plan

Reviews `docs/superpowers/plans/2026-11-22-safebash-globs.md`. The architecture review is in `2026-11-22-safebash-globs-review.md` next to it. This review checks the plan against the code and against bash.

I read every function the plan names at the line it gives, and all the line numbers match. I ran the two write cases below in bash 3.2 on macOS, and the Task 4 cases in the repository's picomatch (4.0.4).

Findings 1 and 2 must be fixed before the plan is built. In each one, a line that asks only `std::read` or `std::ls` writes a file when bash runs it. The `recommended` policy approves those questions for the launch folder, so nobody sees a prompt. Decision 5 says anything that writes stays broad, so both are bugs against the plan's own decisions. Neither fix reopens a decision.

## Finding 1: a glob that starts with `*` can expand to a flag (must fix)

safeBash runs a read or listing command as the model wrote it (`simpleCommandRule`, `stdlib/safeBash.agency:451`). Only grep and git are rewritten. So nothing ends the flags before a glob in `cat`, `sort`, `wc`, `ls`, `tree`, or `du`.

Bash sorts a glob's matches by name, and in most locales `-` sorts before letters. A repository can hold a file named `-o`. In a folder holding `-o`, `a.txt`, and `b.txt`:

```
$ sort *
# bash runs: sort -o a.txt b.txt
# a.txt now holds the sorted contents of b.txt
```

I ran that, and `a.txt` was overwritten. After this plan, `sort *` asks `std::read { dir: "/proj", filename: "*" }` and the recommended policy approves it. `tree *` with a file named `-o` writes the listing over a file in the same way, under a `std::ls` question. GNU `wc`, `du`, and `sort` also accept `--files0-from=FILE`, which reads every file that `FILE` lists, so a file with that name reads files that no question names.

The plan lists "a file whose name starts with `-`" under "Not in this plan". That entry reads as an accepted limit. It is a write under a read question, and the plan's own rows make it reachable (`ls *.json` and `cat *.txt` become narrow in Task 6).

The code already refuses this for `gh`: "a glob in a gh line can expand to a flag, such as --jq" (`stdlib/safeBash.agency:440`).

**Fix.** Add one row to `globTargetOf`'s failure table:

| Condition | Failure message |
|---|---|
| The text starts with `*`, `?`, or `[` | ``a glob that starts with `*`, `?`, or `[` can expand to a name that starts with `-` `` |

Every name bash produces from a glob starts with the fixed text before the first glob character. The parser never starts a word with `-` (`BARE_WORD_START_CHAR_STRING` in tarsec's `chars.d.ts`). So a glob that starts with a fixed character, such as `lib/*` or `a*`, can never expand to a flag.

What this changes in the plan:

- The rows `grep -n hello *.ts` ("What each command asks") and `grep -n hello *.txt | wc -l` (Task 1) become `broad`.
- In Task 6 Step 2, `safeBash.agency:1490`, `:1870`, and `:2723` stay broad with the new failure message, and `safeBash-corpus.json:33` (`ls *.json`) does not change. Only `safeBash-corpus.json:38` (`wc -l stdlib/*.agency`) moves to narrow.
- Replace the "Not in this plan" entry with this refusal, and add a Review Focus line for `sort *`.

None of the six glob lines in the trace starts with a glob character. All of them name a folder first (`tests/agency/structured-interrupts/*.agency`, `lib/runtime/*.ts`, and so on), so the fix costs nothing the trace measured.

grep could keep bare globs, because `grepCommand` writes `--` before its paths (`stdlib/safeBash.agency:1539`). One refusal in `globTargetOf` is simpler, and no trace line needs the grep exception.

## Finding 2: a glob counts as one path in `countFits` (must fix)

`readFileVerb` checks the number of words against the verb's `paths` range (`stdlib/safeBash.agency:2528`). A glob is one word, and bash can expand it into any number of paths. `uniq` takes at most one path, "because a second positional is its output file" (`stdlib/safeBash.agency:1703`):

```
$ uniq u*.txt
# bash runs: uniq u1.txt u2.txt
# u2.txt is overwritten with the output
```

I ran that, and `u2.txt` was overwritten. After Task 5, `uniq lib/*.txt` asks one `std::read` and passes the count check. Finding 1 does not catch it, because the glob starts with a fixed character.

`diff` and `cmp` take exactly two paths. `diff one.txt lib/a*` passes the count, and if `lib/a*` matches a folder such as `lib/app`, `diff` reads `lib/app/one.txt`. `resolveReadPath` refuses a folder for this reason (`stdlib/safeBash.agency:1962`), and a glob skips that check.

**Fix.** In `readFileVerb`, a verb whose `paths` range has a `most` refuses a glob word, with the message ``a glob can name any number of files, and `${verb}` takes ${describeCount(spec.paths, "path")}``. This covers `uniq`, `diff`, `cmp`, `head`, and `tail`, and it states one rule about the range rather than naming a verb.

What this changes in the plan:

- The Task 5 row `head -5 lib/*.ts` becomes `broad`. head's limit of one path exists because several files print headers, which the in-process head does not reproduce. Letting `head` take a glob under bash would be a change to head's row, and this plan does not need it.
- Add `globPlans` rows: `uniq lib/*.ts` broad, `diff one.txt lib/*.ts` broad, `head -5 lib/*.ts` broad.

## Finding 3: Task 4 reads a value with picomatch's full syntax, which is wider than bash's

Task 4 reads every scalar value as a picomatch glob, for every effect. picomatch understands syntax that bash's glob does not have, and it throws on long input.

**A value that starts with `!` is a negation.** picomatch reads `!notes.md` as "anything except `notes.md`". I checked that `secrets.json` matches it. Take a user policy with a common rule:

```json
"std::bash": [{ "match": { "command": "*rm -rf*" }, "action": "reject" }]
```

The model runs `! grep -q TODO notes.md && echo none`. safeBash asks `std::bash` with that line as `command`. The second test reads the line as a glob that means "anything except ` grep -q TODO notes.md && echo none`". The rule's text `*rm -rf*` is not that, so the rule matches and the line is rejected. Today it does not match.

**Braces and `**` mean something else to picomatch.** `{a,b}.json` matches `a.json` in picomatch. bash brace expansion is a different step, and the parser refuses it in a glob. `**` crosses folders in picomatch. In bash 3.2, `**` is the same as `*`.

**A value longer than 65536 characters throws.** picomatch raises `SyntaxError: Input length: 70000, exceeds maximum allowed length: 65536`. `policy.ts` caps rule patterns at `MAX_PATTERN_LENGTH` for this reason (`lib/runtime/policy.ts:6`). Values have no cap. A heredoc in a `std::bash` command can pass that length, and under Task 4 it would throw inside `checkPolicy` whenever a reject rule names `command`.

Each of these makes a reject rule match more often. That is the safe direction, but the rejects are wrong, and the throw is an error in the approval path.

**Fix.** Read the value with the options that match bash 3.2 globbing: `{ dot: false, nonegate: true, nobrace: true, noextglob: true, noglobstar: true }`. Return false from the second test when the value is longer than `MAX_PATTERN_LENGTH`. That leaves the value with today's behavior, because today has no second test.

Pass `dot: false` every time, and do not pass the rule's `matchDotFolders`. That flag says what the rule's own globs match. bash's `*` never matches a leading dot, whatever the rule says.

Add three tests to Step 1: the value `!notes.md` does not match a reject rule for `secrets.json`, the value `{a,secrets}.json` does not match it, and a 70000-character value does not throw.

## Finding 4: Task 4 breaks a sentence in the "Rule matching" doc

`docs/dev/agents/approval-policies.md:983` says which comparison applies "depends on the shape of the value and the shape of the pattern, and on nothing else". After Task 4 it also depends on the rule's action. Step 6 adds a paragraph. It also has to change that sentence and add a row or a note to the table under it. Otherwise the doc contradicts the code.

## Finding 5 (small): the third known limit in Task 4 is stated too strongly

The limit says that when the rule and the value are both globs, "neither test passes". That holds for `secret*` against `*.json`. It does not always hold: a reject rule for `*.pem` matches the value `*`, because the text `*.pem` is a name that `*` matches. I checked that in picomatch. The doc should say a rule that is a glob may fail to match, and give both examples, so a policy author does not conclude that it never matches.

## Finding 6 (small): Task 3 can loop over the words once

Step 2 splits the words into glob words and the rest, calls `resolveTargets` on the rest, and then puts the payloads back in the written order. `resolveTargets` is a loop that calls `literalWordText` and `listTargetOf` on each word (`stdlib/safeBash.agency:2135`). `listEffects` can loop over the words itself: try `globTargetOf`, and for a word that is not a glob, check that it is literal and call `listTargetOf`. The order then comes from the loop, and `resolveTargets` stays unchanged for `find`.

## Finding 7 (small): `globTargetOf` takes a `LineState` and uses only its `cwd`

The plan says not to consult `missingPath` or `madeFolder`, which are the only reasons to pass the whole line. A signature of `globTargetOf(word: Word, cwd: string)`, like `resolveTarget`'s, makes that rule visible in the signature.

## Checked and correct

- Every line number in the plan matches the code.
- In bash 3.2, `lib/[.]*`, `lib/[.][.]`, and `lib/[!a]*` match no name that starts with `.`. Only a name part that starts with `.` reaches `.` and `..`, so the plan's refusal is enough.
- Every row of the Task 4 table gives the stated result in picomatch with `dot: false`.
- The in-process refusals in Tasks 2 and 5 cover a glob anywhere in a line, because `tryShellFreeStep` is asked about every command and goes through `shellFreeGrepPlan` and `shellFreeReadPlan`. `readFileVerb` has two callers, `verbEffects` and `tryShellFreeRead`, and both are covered. `stdinFilter` refuses any stage that names a path.
- The corpus test plans in the package folder (`tests/agency/safeBash-corpus.agency:9`), so both corpus rows the plan names plan in real folders.
- The `recommended` policy approves `std::read` by `dir` (`readScopeRules` in `lib/runtime/builtinPolicies.ts:167`), so a glob read in the launch folder needs no prompt, as the plan says.
