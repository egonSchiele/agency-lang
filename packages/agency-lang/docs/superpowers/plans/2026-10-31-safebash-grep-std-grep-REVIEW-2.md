# Review, round 2: safeBash `grep` raises `std::grep` (ADI-242)

Date: 2026-10-31.

- Plan: `docs/superpowers/plans/2026-10-31-safebash-grep-std-grep.md`
- Round 1 review, which this version of the plan answers: `docs/superpowers/plans/2026-10-31-safebash-grep-std-grep-REVIEW.md`

This round reviews the rewritten plan: the lone grep that runs through the grep tool's search, and the bash path that is narrow only for one file. I checked it against the code on `adit/safebash-grep`. Paths are relative to `packages/agency-lang`. The grep on this Mac is ugrep 7.8.4. CI runs GNU grep. Where a finding depends on which grep runs, I say so.

The split is sound. The shell-free path builds the payload and the search from one `GrepPayload`, so they cannot disagree. The bash path asks a narrow question only for one named file, and real grep and the tool read a named file the same way. I checked the main payload claim: `_searchTarget` realpaths the path it is given (`lib/stdlib/shell.ts:479-502`). So if `one.txt` is a symlink to `~/.ssh/id_rsa`, the payload names `~/.ssh` and `id_rsa`, and `recommended` leaves it undecided. It also refuses a FIFO or a device (`info.kind !== "file"`). Those are the cases I worried about most, and the plan handles them.

There are six findings to fix before executing. One is a payload lie on BSD grep, one is a test that cannot pass as written, three are places where the shell-free output differs from real grep, and one is a type import that has no precedent. After those come a simplification, some smaller fixes, and what I checked.

## Must fix

### 1. On BSD grep, a flag after the file name is read as another file

`splitFlags` treats a flag word as a flag wherever it appears. GNU grep does the same, because it reorders its arguments. BSD grep does not. It stops reading options at the first operand, so every later word is a file name. GNU grep does the same when `POSIXLY_CORRECT` is set in the environment.

Take `grep -n hello one.txt -s`. The plan's payload names one file, `one.txt`. BSD grep searches `one.txt` and also a file named `-s` in the working directory. The payload does not mention that file. It has to exist under that name, so this is unlikely, but the plan's first rule is that any doubt sends the command to `std::bash`, and the fix costs one check.

Fix: on the bash path, a flag after the first positional word makes the command unrecognized, with a detail like ``an option after `one.txt` is a file name to some greps``. The shell-free path never runs real grep, so it does not need the rule. Add `grep -n hello one.txt -s` to `grepUnrecognized`. The filter-stages plan inherits this: `git log | grep fix -i` should stay broad for the same reason. I put a note in that plan's review.

### 2. The parity test's `bash()` call never returns a success

`parityOf` (Task 5) reads real grep's output with:

```
const real = bash(source, cwd: FIXTURES)
if (real is success(result)) {
  theirs = result.stdout
}
```

`bash` returns a plain `ExecResult`, not a `Result` (`stdlib/shell.agency:150-158`). So the `is success` branch never runs, `theirs` stays `""`, and all fifteen rows compare against empty output. The plan says to check `bash`'s result shape, and tells the executor not to change the test when a row fails. Together those could send the executor hunting for a translation bug that does not exist. Write the code that is correct now:

```
const real = bash(source, cwd: FIXTURES)
theirs = real.stdout
```

### 3. `-w` matches different lines than grep when the pattern starts or ends with a non-word character

The grep tool builds `-w` as `\b(?:pattern)\b` (`lib/stdlib/grepQuery.ts`, `compileGrepQuery`). GNU grep's rule is different. The matched text must be preceded by the line start or a non-word character, and followed by the line end or a non-word character. A JavaScript `\b` instead checks the boundary between the pattern's own edge character and its neighbour. The two agree only when the pattern's first and last characters are word characters (letters, digits, `_`).

With the fixture `one.txt` (`hello world`):

```text
grep -rnw " world" .        GNU: no match. " world" is preceded by "o", a word character.
shell-free:                  \b(?: world)\b matches, because "o" then " " is a boundary.
```

The translation table accepts a leading space and punctuation, so this reaches the shell-free path today. Fix: with `w`, `tryShellFreeGrep` accepts only a pattern made of word characters (and, with `-E`, alternatives made of word characters). Anything else goes to the bash path. Add `grep -rnw " world" .` as a parity row, which fails today.

### 4. `-F` with a newline in the pattern is two patterns to grep and none to JavaScript

The `fixed` row accepts "any text". grep treats a pattern containing a newline as one pattern per line. So `grep -F "a<newline>b"` matches lines containing `a` or `b`. The translated JavaScript regex contains a newline, and a single line can never match it. A double-quoted word can hold a real newline. Fix: refuse a newline (and any control character) in every syntax, `fixed` included. The `basic` and `extended` sets already leave it out, but the table should say so outright.

### 5. A path written with `~` renders differently from grep's output

`GrepRender.prefix` is `pathText`, "the path as the command wrote it". For an unquoted `~/notes`, bash expands the tilde before grep runs, so grep prints `/Users/me/notes/a.txt:1:…`. The renderer would print `~/notes/a.txt:1:…`. Fix: when `tildeModeFor(word)` is `"expand"`, the prefix is the expanded text, the same string bash hands grep.

### 6. Agency has no precedent for importing a TypeScript type

Task 5 says `GrepRender` "is imported from `agency-lang/stdlib-lib/grepDialect.js`, as the TypeScript type", and `GrepExec` holds one. I found no `.agency` file that imports a type from `agency-lang/stdlib-lib`. Every import I found is a value: a function, or `VERSION` (`stdlib/agency.agency:37`). Define `GrepRender` as an Agency type in `stdlib/safeBash/actions.agency`, beside `GrepPayload`. The TypeScript function takes the same structural shape, and the type then also lives where the other plan types live.

## Simplification: drop `filters` from this slice

The `filters` part of `FlagSpec` (`--include`, `--exclude`, `--exclude-dir`) changes no outcome in this plan. Here is each place a filter could matter:

- The shell-free path refuses filters (Task 5, condition 3).
- The bash path is narrow only for one file. A filter on a one-file search can only skip that file, and nobody writes `grep -n x one.txt --include=*.ts`.
- A directory through bash is broad whatever its flags.

The filters bring along their own repeat rule, the `valueIsGlob` acceptance, the glob-as-next-word refusal, and test rows 6, 7, and 15 in Task 2. Dropping them makes `--include` an unknown flag, so the command asks `std::bash`. That is the right answer while every directory search through bash is broad. Add them back in the slice that first gives them a user.

## Should fix

### 7. Rule 5 and a word consumed as a value

Rule 2 lets a valued letter take the next word as its value. Rule 5 refuses a quoted word that starts with `-`. The plan does not say whether rule 5 also applies to a word already taken as a value. `grep -e "-x" one.txt` is legitimate: grep searches for `-x`. The safe reading is that rule 5 applies to that word too, so the command is refused. Either reading is safe. Say which one, and pin it with a test row.

### 8. The payload's `pattern` and `maxResults` mean different things on the two paths

- On the shell-free path, `pattern` is the JavaScript regex. On the bash path, it is grep syntax as written. A person approving `a+b` cannot tell whether it means the literal text `a+b` (basic grep) or one or more `a` then `b`.
- On the bash path `maxResults` is `0` for "no cap". In the grep tool, `0` means no results at all (`_grep`'s per-file budget is `maxResults - matches.length`).

Neither changes what a policy approves, because `recommended` matches on `dir`. The dev doc should still say both outright, so whoever writes a pattern or cap rule into a policy knows.

### 9. Write down the assumption behind resolving the path at plan time

`readGrep` resolves the file when the plan is made. Bash runs the line later. That is safe today, because nothing that can come before the grep in a narrow line can change which file a path names. The narrow commands are git reads and redirects, and a redirect writes content into a file but cannot turn it into a symlink. ADI-243 will make project scripts narrow, and after that, `pnpm build && grep -n x out.txt` can replace `out.txt` between plan and run. Put this assumption in the dev doc's grep section, so the ADI-243 plan has to deal with it.

### 10. Make the hint a table from verb to tool

`READ_TOOL_VERBS = ["grep"]` plus a sentence that names the grep tool works for one verb. ADI-244 adds `cat`, `head`, and `tail`, which should point at `read`. A record from verb to tool name (`{ grep: "grep" }`) makes the next slice a one-line change, and the sentence is built from the table.

### 11. `keepOutput` is changing in the trace-display branch

The tool trace display plan, in `worktree-tool-trace-display`, adds a `source` parameter to `keepOutput` and updates "its only callers" in safeBash. This plan adds a new caller in `runGrep`. Whichever branch merges second will fail to compile. That failure is loud, not silent, but a line in each plan saves the second executor a surprise.

### 12. Name the output differences the parity test cannot see

The fixtures are short ASCII text files, so the parity test does not cover these. They change the output, not the payload:

- A binary file. GNU prints `Binary file ./x matches`, and the tool prints the decoded bytes.
- A character outside the Basic Multilingual Plane, such as an emoji. JavaScript's `.` without the `u` flag matches half of one, so `h.llo` does not match `h😀llo`, while grep in a UTF-8 locale does match.
- `-i` on non-ASCII text, where the case-folding rules differ.

List them in the dev doc's grep section, next to the parity test.

## Seen in passing, out of scope

safeBash's shell is `sh -c`, not bash (`lib/host/node/nodeSubprocess.ts:51`). On Ubuntu, and so on CI, that is dash. The parser models bash. This plan's grep commands mean the same thing in both shells. It matters for the safeBash design as a whole, so it may deserve a ticket.

## Checked and correct

- **Payload truth for symlinks and special files.** `_searchTarget` realpaths the given path, splits a file into its real parent and name, and refuses anything that is not a file or a directory (`lib/stdlib/shell.ts:479-502`).
- **Dot folders under `recommended`.** The read rules approve `{.,./**}` (`lib/runtime/builtinPolicies.ts:73-80`). `**` does not descend into a dot folder, so `grep -n url .git/config` gives `dir: <cwd>/.git`, which falls through to a prompt.
- **A file named outright.** `_grep` searches it whatever `.gitignore` says (`lib/stdlib/shell.ts:538-541`), which matches real grep on the bash path.
- **Filenames on a `-r` search of one file.** GNU prints no filename for `grep -rn hello one.txt`, because it names only files found by recursion. That agrees with the plan's `fileNames` rule. It also prints no `./` prefix when no path is given, which agrees with the `prefix: ""` rule.
- **Extra payload field.** `raiseOne` adds `command` to every payload, and effect declarations accept extra fields: `std::write` declares only `dir` and `filename` (`stdlib/index.agency:43-46`), and `raiseOne` already passes `content`, `mode`, and `command`.
- **Cited code.** `_searchTarget` (`lib/stdlib/shell.ts:479`), `resolveCwdPath` (`lib/stdlib/resolveDir.ts:9`), `expandPath` (`lib/stdlib/expandPath.ts:33`), `TildeMode` and `resolveRedirectTarget` (`lib/stdlib/prepareContainedPath.ts:33`, `:42`), `SKIP_DIRS` (`lib/stdlib/shell.ts:365`), the `_searchTarget` tests (`lib/stdlib/shell.test.ts:428`), `import test` (`tests/agency-js/data-wikidata/agent.agency:1`), and the test nodes the plan names (`planSummary`, `rejectedBroadSaysWhy`) all exist where the plan says.
- **Parser shapes.** With the main checkout's build: `-nA3` is one flag word, `--regexp=x` is `flagName` plus `flagValue`, and an unquoted `-x` after `-e` is a flag word, so it fails `literalWordText`, which is the safe outcome.
