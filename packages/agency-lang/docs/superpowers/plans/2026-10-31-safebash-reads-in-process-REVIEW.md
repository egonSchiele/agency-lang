# Review: safeBash file reads plan

This is a review of `docs/superpowers/plans/2026-10-31-safebash-reads-in-process.md`.

I checked the plan against the code on main at 04b90823b, the spec's Part 5, and the real programs on this Mac. The Mac has Apple diff, BSD head, tail, cat, and tr, and `/bin/sh`, which is bash 3.2 in POSIX mode. I ran the bash parser from the built `dist/` on each command line the plan's tests use. I did not run the Agency tests.

The findings come in three groups:

1. Fix before building. Four of these make a payload or an output wrong, and two make a test fail to compile or parse.
2. Simplify. These are smaller designs that do the same job.
3. Smaller points.

At the end there is a list of the plan's claims that I checked and found true.

---

## 1. Fix before building

### 1.1 A read of a folder raises one `std::read` while the program reads the whole tree

Here is the case, run with Apple diff:

```
$ mkdir -p a b outside
$ echo SECRET-LINE > outside/s.txt
$ ln -s ../outside/s.txt a/creds
$ echo other > b/creds
$ diff -r a b
diff -r a/creds b/creds
1c1
< SECRET-LINE
---
> other
```

Under the plan, `diff -r a b` raises two questions:

```
std::read { dir: <cwd>, filename: "a" }
std::read { dir: <cwd>, filename: "b" }
```

`recommended` approves both, because `<cwd>` is the launch directory. diff then follows the link and prints a file outside the launch directory. GNU diff follows links the same way unless it is given `--no-dereference`.

The cause is the resolver. Task 1 resolves every path with `_resolveRedirectTarget` (`lib/stdlib/prepareContainedPath.ts:72`). That function finds the real parent and name, and it never asks whether the target is a file. So a folder passes as if it were a file.

`-r` is not the only way in. `diff a.txt subdir` reads `subdir/a.txt`, which no payload names:

```
$ diff a/f b
diff: b/f: No such file or directory
```

A FIFO in the launch directory is a third case. `wc -l pipe` would raise one auto-approved `std::read` and then hang forever, because `runBash` calls `_bash` with no timeout.

The grep slice refused the same thing for a folder grep through bash. Its message is "grep through bash would search a directory, and reads files the grep tool skips".

Suggested fix:

1. Resolve read-verb paths with `_searchTargetIn` (`lib/stdlib/shell.ts:513`), which `safeBash.agency` already imports for grep. It realpaths the path and stats it. It returns `file: null` for a folder. It throws for a missing path, and for anything that is neither a file nor a folder, such as a FIFO or `/dev/zero`.
2. Refuse a result with `file == null`, with a message such as `diff would read a directory`.
3. Drop `r` from the diff row.
4. Resolve a `< file` target in Task 3 the same way, so `< pipe` and `< dir` are refused too.

This departs from the spec's "Paths" section in one way. The spec says a missing path resolves by its parent, as a redirect target does. With `_searchTargetIn`, `cat nope.txt` is unrecognized and asks `std::bash`, the same as `grep x nope.txt` does today. The cost is a broad prompt when the model mistypes a name. If you would rather keep missing paths narrow, write a small helper that stats the path, refuses a folder or a special file, and lets a missing path through. Either way, the spec's `diff -r` row carries the same bug, so the spec needs the change too.

Add rows to Task 1's test for `diff -r one.txt two.txt`, `diff one.txt <a folder>`, and `cat <a folder>`.

### 1.2 `echo -n` prints `-n` on macOS, so Task 7 makes the shell-free path disagree with the bash path

safeBash runs every bash-path command as `sh -c` (`lib/host/node/nodeSubprocess.ts:51`). macOS `/bin/sh` is bash 3.2 in POSIX mode, and its `echo` does not take `-n`:

```
$ /bin/sh -c 'echo -n hi' | od -c
0000000    -   n       h   i  \n
```

After Task 7, these two lines print different text on a Mac:

```
echo -n hi                  -> "hi"        (shell-free)
echo -n hi && git status    -> "-n hi\n"   (bash path, through sh)
```

`echo -n hi > out.txt` writes `hi` shell-free, but `echo -n hi > out.txt; true` writes `-n hi` and a newline. On Ubuntu, dash takes `-n`, so the two agree there.

The plan leaves out `echo -e` for this exact reason (ADI-248). `-n` belongs with it. I suggest removing Task 7 from this plan and adding it to ADI-248. If ADI-248 switches safeBash to `bash -c`, `echo -n` agrees on every platform and Task 7 can land then. Task 7 has nothing to do with file reads either, so the plan gets shorter without it.

### 1.3 The shell-free error message is wrong for `head`, for `tail`, and for every error except a missing file

Task 6 says `runRead` turns any `_read` failure into this message, "the message GNU and BSD both print":

```
${verb}: ${argument}: No such file or directory
```

BSD prints that form for cat, head, and tail. GNU prints it only for cat. GNU head and tail say this:

```
head: cannot open 'nope.txt' for reading: No such file or directory
tail: cannot open 'nope.txt' for reading: No such file or directory
```

The message also gives the wrong reason for every other failure. If the file is unreadable, the model is told it does not exist. The same happens if the file was replaced by a folder after the plan was made.

With fix 1.1, a missing file never reaches `runRead`, because the plan refuses it. Only a race or a permission error gets there. So the simplest fix is to return `_read`'s own error, as `runGrep` does with `_grep`'s error at `stdlib/safeBash/actions.agency:258`. Change `shellFreeReadMissingFile` in Task 6 to match. With fix 1.1 that node becomes a plan-time test: `cat nope.txt` is `broad`.

### 1.4 Task 3's example is not recognized under the plan's own rules

Task 3's interface text says:

> One input redirect and one output redirect may both appear (`sort < in.txt > out.txt` is a read and a write).

`sort` names no path and is not in a pipe. So it goes to `stdinStage` with `readsStdin` false, which fails with `sort with no path reads stdin`. Row 2 of the same task says this on purpose for `cat < one.txt`. Change the example to `git status < in.txt > out.txt`, or add a sentence saying that a stdin reader with only an input redirect stays unrecognized.

### 1.5 Task 1's test helper does not type check

Here is the helper from Task 1:

```
const first = parsed.value[0]
if (first.tag != "simpleCommand" || first.command == null) {
  return "NOT-SIMPLE"
}
const verb = first.command.text
```

The plan's own Global Constraints say that `!=` on a tag does not narrow. So `first.command` is not known to exist after the guard, and `first.command.text` is a type error. `command` is a `Word`, and not every `Word` variant has `text`.

Here is a version that narrows:

```
if (first is { tag: "simpleCommand" }) {
  ...
}
```

Inside that block, read the verb with the helper `verbNames` already uses. The `READ_VERBS[verb]` lookup can also be missing, so it needs a null check before the call.

### 1.6 Task 4's `cut` row does not parse, and neither do the usual `cut` and `sort` forms

The bash parser refuses a comma or a colon joined to a flag:

```
cut -d: -f1       -> unparseable: Unexpected input after commands: "-d: -f1"
cut -d , -f 1     -> unparseable
sort -t, -k2      -> unparseable
sort -k2,2n       -> unparseable
cut -d : -f 1     -> flag(-d) lit(:) flag(-f) lit(1)
cut -f1           -> flag(-f1)
sort -t : -k 2    -> flag(-t) lit(:) flag(-k) lit(2)
```

The plan already says to check this. The parser answered: write row 3 as `cut -d : -f 1`. Then add a row for `cut -d, -f1` that expects `unparseable`, so the limit is pinned.

The comma forms are what models write most often (`sort -t, -k2`, `cut -d, -f2`), so most real `sort` and `cut` stages will stay broad until tarsec accepts a comma in a word. Give that a ticket, and say in the dev doc that these rows mostly cover the forms without a comma.

---

## 2. Simplify

### 2.1 Filters can be rows in `READ_VERBS`

The plan has two tables. `READ_VERBS` lists verbs that read the paths they name, or stdin when they name none. `FILTER_VERBS` lists verbs that the plan lets read only stdin. It refuses a path on them with `sort with a path reads the file, not the pipe`.

But `sort`, `uniq`, `cut`, `nl`, `tac`, and `rev` all read the files they name. `sort a.txt` reads `a.txt`, and `std::read` for `a.txt` is a truthful payload. So these verbs fit `READ_VERBS` as they are. `readFileVerb` already answers `{ kind: "stdin" }` when no path is named, and that goes to `stdinStage`.

Two verbs need care:

1. `uniq in out` writes `out`. Give `uniq` `maxPaths: 1`, so a second positional is refused.
2. `tr` takes no file at all. Its positionals are character sets. It stays as one special case, a verb whose positionals are not paths.

This removes `FILTER_VERBS`, the "reads the file, not the pipe" message, and the second lookup in `otherVerbEffects`. It also recognizes `sort one.txt` and `uniq -c one.txt`, which the plan leaves broad. In Task 4's test, rows 6 and 8 become `std::read` rows.

### 2.2 `count` belongs to head and tail, so keep it off `FileRead`

`FileRead` carries `count: number`, "10 when it did not". Only `head` and `tail` have a count. It shows up as noise in the Task 1 test:

```
readOf("cat one.txt")    -> [["one.txt"], 10]
readOf("wc -l one.txt")  -> [["one.txt"], 10]
```

`FileRead` already keeps `split`. So `tryShellFreeRead`, the one reader of the count, can read `-n` from `split.values` itself. Then the Task 1 rows become just the file names.

### 2.3 Drop `wc` from `READ_TOOL_FOR_VERB`

Task 2 adds `cat`, `head`, `tail`, and `wc` to the hint table, all pointing at the `read` tool. The `read` tool cannot count lines, so a rejected `wc -l -L one.txt` would tell the model to "Call the read tool instead". The comment above the table (`stdlib/safeBash.agency:1655`) already says the plan is cat, head, and tail. Keep it to those three.

### 2.4 `countFlagAsN` must not rewrite a word that is the value of `-n`

This is how the parser reads `head -n -5 a`:

```
head -n -5 a  -> flag(-n) flag(-5) lit(a)
```

GNU reads `head -n -5` as "every line but the last five". If `countFlagAsN` turns `-5` into `-n 5` first, the args become `-n -n 5 a`. The command is still refused, but only because `-n`'s value turns out to be a flag word. The refusal happens by accident.

Make `countFlagAsN` rewrite a digit flag only when the word before it is not a valued flag. Add rows for `head -n -5 one.txt` and `tail -n -5 one.txt` that expect a refusal.

There is also a mismatch in the interface. `countFlagAsN` takes and returns `Word[]`, but `splitFlags` takes a `SimpleCommand`. Say how the copy is made, for example `{ ...command, args: countFlagAsN(command.args) }`, and check that Agency accepts a spread of that type.

---

## 3. Smaller points

1. **`head -n 0` fails on BSD.** BSD head prints `head: illegal line count -- 0` and exits 1. GNU head prints nothing. The shell-free renderer prints nothing. To keep "one output everywhere" true of a choice someone made on purpose, refuse a count of 0 for `head` on the shell-free path, or write in the dev doc that the GNU behaviour was picked. `tail -n 0` prints nothing on both.

2. **The table comment about `-c` is wrong.** It says `head/tail -c` is left out because "BSD head lacks it". BSD head and tail both take `-c` on this Mac. Either add `-c` to the bash-path rows or give the real reason for leaving it out.

3. **`tr`'s positional count refuses a valid form.** The plan allows one positional with `-d` or `-s`, and two otherwise. `tr -s a b` is valid on BSD and GNU and squeezes after translating. The rule should be: `-d` alone takes one, `-ds` takes two, `-s` takes one or two, and no flag takes two.

4. **`tr` should keep `optionsFirst: true`.** BSD tr reads `tr a b -d` as three operands and prints a usage error. GNU tr reads `-d` as a flag. Every other filter refuses positionals, so the flag does nothing for them, but for `tr` it decides which program's reading the payload describes.

5. **`tac` does not exist on macOS.** On a Mac, `git log | tac` will be recognized and then fail with `tac: command not found`. That is harmless, but the table comment should say so, since the owner works on a Mac.

6. **`sort` may write temporary files.** GNU and BSD sort spill large input to files in `$TMPDIR`. No payload names that write. It is fine to accept it, but the dev doc should say so, because the filter rule's claim is "writes only stdout".

7. **The symlink test should not put a link into `FIXTURES`.** `readPayloadNamesTheRealParent` creates `FIXTURES/link.txt` and `FIXTURES/../outside-fixture.txt`. The grep parity rows search `FIXTURES` with `-r`. If those nodes overlap in time, the link changes their output. Make the link and its target in a folder of their own, cleaned up with `safeDeleteDirectoryWithin`.

8. **"path(s)" in a message.** `head with more than 1 path(s)` reads badly to the model. Use `head takes one path`.

9. **`planOutcomes` exists.** Task 2 says "if that node lists outcomes by command". It does (`tests/agency/safeBash.agency:437`), so the step can say to add the row.

10. **No history in the dev doc.** Task 8 asks for the reasons behind the in-process rule, which is fine. The plan also says the rule was "decided 2026-10-31" and is "a departure from the spec's table". Leave the date and the departure out of `docs/dev/stdlib/safe-bash.md`, and state the rule and its reasons.

---

## Claims I checked and found true

1. `_read(dir, filename)` with no offset or limit returns the file's text unchanged. `sliceLines` returns early when both are unset (`lib/stdlib/builtins.ts:198`).
2. The shell-free path reads through `readBytes`, which opens without following a final link and requires a regular file inside the root (`lib/host/node/nodeFiles.ts:259`). So the shell-free read cannot be sent elsewhere by a link swapped in after the plan. The bash path does not have this protection, as the dev doc already says for grep.
3. `safeBash` already lists `std::read` in its `raises` clause (`stdlib/safeBash.agency:1565`). Task 2 does not need to add it.
4. `recommended` approves `std::read` by `dir` under `{.,./**}` (`lib/runtime/builtinPolicies.ts:77`). A bash-path read under the launch directory needs no prompt, as the plan says.
5. `keepOutput(text, exitCode, label)` and `exitFailure(command, exitCode, stdout, stderr, label)` have the signatures the plan uses.
6. The parser reads `head -20 f` as the flag `-20`, so `countFlagAsN` is needed. `tail -n +5 f` gives the literal `+5`, which `isDigits` refuses.
7. `cat -`, `cat a -`, and `cat -- a` do not parse, so a `-` that means stdin cannot reach a path payload.
8. `cat -n` prints `%6d\t` on BSD, the same as GNU. A last line with no newline keeps no newline on both, which matches the renderer's rules.
9. Apple diff accepts `--color=never`.
10. Two `<` redirects parse as two redirects, so Task 3's "more than one input redirect" row reaches the new check.
