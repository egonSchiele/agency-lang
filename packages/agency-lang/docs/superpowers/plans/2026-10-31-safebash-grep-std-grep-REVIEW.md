# Review: safeBash `grep` and `rg` raise `std::grep` (ADI-242)

Plan reviewed: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-242/packages/agency-lang/docs/superpowers/plans/2026-10-31-safebash-grep-std-grep.md`

**Status (2026-10-31):** the plan has been rewritten to answer this review. The owner asked for accuracy over fewer prompts. So the old Task 1 (stdin) moved to its own plan, `2026-10-31-safebash-filter-stages.md`, and `rg` was dropped from the slice. Findings 1-12 and the smaller points are folded in. Finding 1 now lives in the filter-stages plan, which checks `-r` first.

I checked the plan against the code on `adit/safebash-grep` (main merged in, tarsec 0.5.6). I ran the bash parser from the main checkout's build to see how it splits grep flags, and I ran `grep` and `rg` in a scratch folder to confirm two behaviors. The grep on this Mac is ugrep 7.8.4 (`grep --version`); CI runs GNU grep. Where a finding depends on which grep runs, I say so.

The overall shape is right. One helper splits the flags, one function fills the payload, the path goes through the same `_searchTarget` split the grep tool uses, and a spelling the table does not know falls back to `std::bash`. The findings below are about places where the payload would describe a different search than the one grep runs. The module's first rule is that the payload tells the truth, so I ranked those first.

## Findings that make the payload lie

### 1. `grep -r` with no path reads the working directory even as a later pipeline stage

Task 3, step 3 of `grepEffects` checks `readsStdin` before it checks `-r`:

> Zero: if `readsStdin`, return `success([])` (a filter stage); else if `r` or `R` is present, the path is `"."`

With `-r` and no path, grep searches the working directory. GNU grep does this whether or not stdin is a pipe. ugrep reads both. In a scratch folder holding `a.txt` with the line `hello`:

```
$ echo piped-hello | grep -r hello
(standard input):piped-hello
a.txt:hello
```

So `git status | grep -rn TODO` would plan as narrow with only `std::git::status`. A policy that approves git status in this directory would then let grep read the whole tree with no `std::grep` question.

Fix: check `-r` first. With `-r` and no path, the path is `.` in every stage. Only a stage with no path and no `-r` is a filter. Add `git status | grep -rn hello` to `grepRecognized`, expecting `["std::git::status","std::grep"]`.

### 2. `-R` follows every symlink below the path

`GREP_FLAGS` lists `R` as a plain flag. `grep -R` follows symlinks it meets while walking. `grep -r` follows only the ones named on the command line. In the scratch folder, with `link -> ../outside`:

```
$ grep -R hello .
a.txt:hello
link/o.txt:hello-outside
```

The `std::grep` payload says `dir: <cwd>`, and `recommended` approves that under `{.,./**}`. The grep tool never follows symlinks below its path, so the existing rule has always meant "the files under this directory". With `-R`, one symlink in the project makes the approved search read anything on the disk.

Fix: take `R` out of the table, and add `grep -Rn hello .` to `grepUnrecognized`. The spec's row lists `R` among the regex letters from `grepQuery.ts`, so record this as a departure from the spec (see finding 13). For the same reason `rg -L` (`--follow`) must stay out of `RG_FLAGS`, and the plan already leaves it out.

### 3. A quoted word that starts with `-` is a flag to grep, but `splitFlags` treats it as a positional

`splitFlags` treats only words with tag `flag` as flags. The parser gives `"-R"` and `'-R'` the tags `doubleQuoted` and `singleQuoted`. bash removes the quotes, so grep still reads them as options. Take `grep "-R" src`:

- The plan sees the pattern `-R` and the path `src`. It raises `std::grep` with `dir: <cwd>/src` and `pattern: "-R"`.
- grep runs `grep -R src`, which means the pattern `src` searched recursively from `.`, following symlinks.

The payload names one directory, and grep reads a larger tree and follows links out of it. A prompt injection could write this command on purpose.

Fix: when the text of a positional starts with `-`, the command is unrecognized. A word consumed as a flag's value is exempt, because grep takes it as the value: `-e '-foo'` is fine. Add `grep "-R" hello` and `grep -rn hello '-i'` to `grepUnrecognized`.

### 4. `RG_FLAGS` copies grep's letters, and several mean something else in rg

The plan defines `RG_FLAGS` as "the same plus" a few rg flags. From `rg --help` (ripgrep 14.1.1):

| letter | grep | rg |
|---|---|---|
| `-r` | recursive | `--replace=REPLACEMENT`, takes a value |
| `-E` | extended regex | `--encoding=ENCODING`, takes a value |
| `-h` | no filename | `--help` |
| `-s` | no error messages | `--case-sensitive` |
| `-R` | recursive, following links | not a flag |

`--include`, `--exclude`, and `--exclude-dir` are not rg flags either. rg uses `-g`.

Here is one wrong payload. For `rg -r . foo`, the plan sees plain `r`, the pattern `.`, and the path `foo`. rg sees the replacement `.` and the pattern `foo`, with no path. The payload's pattern is wrong.

rg's no-path behavior differs from grep's too. rg has no recursion flag. With no path, it reads stdin when stdin is a pipe or a file, and otherwise searches `.`. In the scratch folder, `echo piped-hello | rg hello` printed only the piped line, and `rg hello </dev/null` printed `a.txt:hello`. So the rule "`.` when `-r` and no path" must not apply to rg. I did not trace which stdin `abortableShell` hands the child (`lib/stdlib/abortable.ts:111`). Until someone does, treat an rg with no path like a grep with no path and no `-r`: a filter in a later stage, and unrecognized as the first stage.

Fix: build `RG_FLAGS` on its own from `rg --help`. Plain: `n i w l v F P c H o S s`, `--no-heading`, `--line-number`, `--with-filename`, `--no-filename`, `--color=never`. Valued: `e m A B C t g`. Add a test row for `rg -r X hello .`, which should be unrecognized because `-r` is not in the rg table.

### 5. A repeated valued flag overwrites the earlier one

`SplitArgs.values` is a `Record<string, string>`. The parser hands `grep -e a -e b .` over as two separate `-e` flags (I checked this with the parser). The second value replaces the first, so the payload says `pattern: "b"` while grep matches lines with `a` or `b`. Agents often repeat `--include`, as in `--include=*.ts --include=*.tsx`. That loses nothing the payload shows, but it is the same silent overwrite.

Fix: make `values` a list of `{ flag, value }`. Make a second `e` or `m` a failure. Allow repeats only for the filter flags (`--include`, `--exclude`, `--exclude-dir`, `-g`, `-t`).

### 6. The lookup rule for long flags is ambiguous, and a glob value needs a rule

The parser splits `--color=never` into `{ flagName: "--color", flagValue: "never" }`. The plan lists `"--color=never"` as a plain entry and `"--include"` as a valued entry, and it says "`--name` or `--name=value` is one entry". Those three statements disagree about what string gets looked up. Spell it out: look up `renderFlag(word)` in `plain` first, then look up `flagName` in `valued` and take the inline `flagValue` as the value.

Two parser facts belong in the plan as test rows:

- `--include='*.ts'` parses as an `interpolatedVariable` word, not a flag. It then counts as a positional and fails as "the grep path is not literal" or "more than one path". That failure is safe. It does mean the quoted spelling agents use most often stays broad. Pin it with a test row so it stays a failure, and list it as a known gap in the dev doc.
- Under tarsec 0.5.6, `--include=*.ts` parses as a flag with `valueIsGlob: true`. Accept a glob value only on the filter flags. On `-e`, `-m`, `-A`, `-B`, or `-C`, a glob value should make the command unrecognized, because bash may expand it.

### 7. The rejection hint states something safeBash does not know

Task 5 appends: "The grep, read, and ls tools do not need an approval under the current policy." safeBash cannot see the policy. With no policy, or with one stricter than `recommended`, the sentence is false, and the model will believe it. The spec says the sentence is "only said when it is true", but the condition the plan checks is that every verb is in the read family. That condition says nothing about the policy.

Fix: say only what safeBash knows, for example "Call the grep tool instead: a policy can approve its question in advance." The test assertions change with the wording.

## Findings that would break during execution

### 8. Changing `verbNames` to take `Stage[]` breaks six callers

Task 1 changes `verbNames` to take `Stage[]`. Six other call sites pass `[command]`, a list of `SimpleCommand`: `stdlib/safeBash.agency:579`, `:609`, `:619`, `:621`, `:704`, and `:738`. Keep the signature as it is, and call `verbNames([s.command for s in stages])` in `planFor`. The plan also says `stagesOf` is "for `safeBash`'s verb list". `safeBash` reads `plan.verbs` and never needs `stagesOf`, so drop that clause.

### 9. Exporting `stagesOf` fails `lib/stdlibCapabilities.test.ts`

That test fails any exported stdlib function that reaches a `stdlib-lib` helper while its capability list is empty, unless the function is on the allow list (`docs/dev/language/capabilities.md`, around line 288). `stagesOf` reaches `_bashParser`. Its neighbour `bashParser` is on the allow list at `lib/stdlibCapabilities.test.ts:77` for exactly this reason. You can add `stagesOf` beside it, or leave it unexported and import it in the test the way the memory note `import-test-for-unexported` describes. Either way, add that unit test to Task 5's checks, because none of the plan's run commands would catch it.

`grepEffects` stats the path, so give it `@capabilities(fileRead)` the way `prepareRedirectWrite` has it (`stdlib/safeBash.agency:214`).

### 10. With `-e`, every positional is a path

Step 2 says the pattern is "the `e` value when present, else the first positional", and then "Positionals after it are paths". When `-e` is present, no positional is the pattern. Say that every positional is then a path. The `grepPayloads` test with `-e needle .` already depends on this.

### 11. Task 3 leaves the executor a choice about the expected output

The `grepUnrecognized` expectations say, in the middle of the list, to choose between a `contains` match and a kind-only node, and then to move one row into another node. The plan should make that choice itself. Put `grep -rn hello missing-dir` in a node of its own that returns `[names, plan.broadReason.kind]`. Keep `grepUnrecognized` asserting the full detail. Move the `> out.txt` row into `grepRecognized` in the code block itself.

### 12. `-m` needs a parse rule, and its meaning differs from the tool's

`-m abc` has to make the command unrecognized. The plan says "the `m` value as a number" and does not say what happens when the value is not a number. Also, grep's `-m 5` stops after five matches in each file, while the tool's `maxResults` caps the total. A policy is unlikely to key on `maxResults`, but the payload field should mean one thing. Either leave `maxResults: 0` and say why, or keep the value and state in the dev doc that it counts per file for a bash grep.

## Smaller points

13. **Record the spec departures.** The spec's grep row fills `flags` with "the regex letters" and lists `i m s u n r R g E P w l v`. The plan sets `flags: ""`, which is right because grep's `-m`, `-s`, and `-E` are not regex flags. Findings 2 and 4 drop `R` and split rg's table. Add a short "Departures from the spec" list to the plan, and amend the spec in the same PR. The last review round found six places where the spec had drifted from what was built.
14. **The import.** `stdlib/safeBash.agency:8` already imports `bash, ExecResult` from `std::shell`. Add `grep` to that line, and update the comment at lines 1-5 so it names `std::grep`. A second import line from the same module is not needed.
15. **The bridge name.** `_safeBashSearchTarget` names its one caller. `_searchTargetIn(given, cwd, tildeMode)` says what it does. Keep the empty-cwd refusal that `resolveRedirectTarget` has (`lib/stdlib/prepareContainedPath.ts:49`).
16. **Effect sets, not only `recommended`.** `std::grep` belongs to the `FileRead` and `FileSystem` sets (`lib/runtime/effectSets.data.ts:14`). So `agency run --approve FileRead`, `--approve std::grep`, and an "approve always here" answer will all approve bash greps as well. The paragraph for `approval-policies.md` should say this, not only describe the `recommended` rule.
17. **rg reads a config file.** `RIPGREP_CONFIG_PATH` can add flags such as `--pre` (run a program on each file) or `--follow`. This is the same kind of gap as git's config running hooks, so it does not block the slice. The dev doc's limits section should mention it.
18. **Task 4's `handle` as an expression.** `tests/agency/` has no `const x = handle { ... }` example. Write the `let` form from the start instead of trying the expression form first.
19. **The header is out of date.** It says ADI-242 depends on ADI-241 for the pipeline cases. ADI-241 merged as #1313.

## What I did not check

- Which stdin `abortableShell` gives the child process. This decides what `rg hello` with no path does under safeBash (finding 4).
- Whether every letter in the grep table means the same thing in GNU grep, BSD grep, and ugrep. I checked only `-r` and `-R` on ugrep. The table should be read against GNU grep's manual, since CI runs GNU grep, with a note that macOS ships a different grep.
