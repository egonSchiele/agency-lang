# Review: `ls`, `tree`, `du` ask `std::ls`; `find` asks `std::glob`

This is a review of `docs/superpowers/plans/2026-11-01-safebash-listings-std-ls-glob.md`.

I checked the plan against the code on this branch (5f2b4db74) and the `ls` and `glob` tools in `stdlib/shell.agency` and `lib/stdlib/shell.ts`. I ran the bash parser from the main checkout's build (tarsec 0.5.6). I ran macOS `ls`, `du`, and `find` on a folder holding a symlink. I did not run any tests.

The findings come in three groups:

1. Fix before building. One payload describes a different search, one owner decision is missing, and three details would make rows fail.
2. Should fix.
3. Smaller points.

At the end there is a list of the plan's claims that I checked and found true.

---

## 1. Fix before building

### 1.1 `find -name` and a `glob` pattern mean different searches

The plan fills `std::glob`'s `pattern` with the `-name` value, so `find . -name '*.txt'` raises:

```
std::glob { pattern: "*.txt", dir: <cwd>, maxResults: 0 }
```

The glob tool matches a pattern against each entry's whole relative path. `globToRegExp` (`lib/stdlib/shell.ts:640`) turns `*` into `[^/]*` and anchors both ends, so `*.txt` matches `a.txt` but not `src/a.txt`. `find -name` matches the last part of the path at any depth. So the payload describes a top-level glob, while `find` searches the whole tree. A person reads "glob `*.txt` here" and approves a smaller search than the one that runs. A policy rule keyed on `pattern` would be wrong too.

Suggested fix: the payload's pattern is `**/` followed by the `-name` value, so `find . -name '*.txt'` raises `pattern: "**/*.txt"`. When `-maxdepth 1` is given, keep the value as it is. With no `-name`, use `**`. Add the payload rows for each case. `-iname` is case-insensitive and the glob tool is not, so the plan should either refuse `-iname` or say in the payload doc that the pattern is matched without case. I'd refuse it for now. It is the smaller rule.

### 1.2 The tools skip folders that the programs list: the owner needs to decide

The `ls` tool's recursive walk skips `SKIP_DIRS` (`node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`). Its docstring says so, and `lib/stdlib/shell.ts:339` does it. `_glob` walks with `walkDir`, which skips the same folders and applies `.gitignore` (`lib/stdlib/shell.ts:446-461`). Real `ls -R`, `du`, `tree`, and `find` skip neither.

This is the question ADI-242 decided for grep. A policy that approves `std::ls` under the launch directory approves what the tool does. The bash spelling, with the same payload, reads more. For grep the answer was `std::bash` for a folder through bash, because real grep reads file contents the tool skips, `.git/config` among them.

Listings differ in one way that matters: they print names and sizes, not contents. So there are two honest choices:

- **A.** Accept it, and write the reason in the dev doc: a listing through bash shows the names under `.git` and `node_modules` that the tool leaves out, and no file's contents.
- **B.** Follow grep. A recursive listing through bash (`ls -R`, `du`, `tree`, `find`) asks `std::bash`, and only a listing of one folder's own entries (`ls`, `ls -la src`) is narrow. The two spellings agree on that.

I lean to A, because names are not the secret that decided grep. But the owner chose accuracy over fewer prompts for grep, so the plan should put this question at the top and not decide it in passing. Plan B is a small change to `listEffects`: refuse when `recursive` is true.

### 1.3 The count-flag message prints two dashes for `find`

`checkCountFlags` is the loop from `readFileVerb`, which builds its message as "the value of `-${entry.flag}` is not a number". For head, `entry.flag` is `n`, so the message reads `-n`. For find, the flag is listed whole as `-maxdepth`, so the message reads `--maxdepth`. Task 3's expected row says `-maxdepth`, so it would fail.

Use `flagDisplay(entry.flag)`, which `splitFlags`' repeated-flag message already uses. It prints a name that starts with `-` as it is.

### 1.4 The whole-word check must come after the joined-value refusal

The parser hands over `find . -name=x` as the flag `-name` with `flagValue: "x"`. I checked. Today `readFlagWord` reads, in order: the `--` branch, the digit branch, then `if (word.flagValue != null) { return failure(...) }`, then the letter loop.

Task 1 puts the whole-word check "after the `--` branch and the digit branch", which is before the `flagValue` refusal. A valued whole flag would then take the next word as its value and drop the `=x`. That gives a payload for `find . -name=x foo` that names `foo` as the pattern. GNU find rejects `-name=x` outright.

Put the whole-word check after the `flagValue` refusal, and add a `wholeShortFlags` row for `x -name=foo f` expecting the refusal.

### 1.5 Task 1's fourth row expects a failure, but the code returns a success

`splitSummary("x -nam f", WHOLE_FLAGS)`, with `n` valued and `a` plain. `-nam` is not a whole flag, so the letter loop reads `n` first. `n` is valued, so it takes the rest of the word, `am`, as its value (`readFlagWord`: "A valued letter takes the rest of the word as its value"). The result is a success:

```
[[], ["n=am"], ["f"]]
```

The plan expects "x does not take `-m`". Pin the success. It is a useful row, because it shows a near miss on a whole flag falls back to the letter rules.

---

## 2. Should fix

### 2.1 `-G` means different things on BSD and GNU `ls`

The table rule is that every letter means the same thing on GNU, BSD, and busybox. On macOS, `ls -G` turns on color. On GNU it is `--no-group`. Drop `G`.

### 2.2 `-H` and `-P` cannot appear where the plan's rules allow them

`find` takes `-H`, `-L`, and `-P` only before its paths. The plan's ordering rule (paths first, then the expression) refuses `find -H .`. In the position the rule allows, BSD find fails:

```
$ find ftest -H -name x
find: -H: unknown primary or operator
```

GNU find prints an error there too. So the two entries in `FIND_FLAGS.plain` can only let through a line that fails. Drop them.

### 2.3 One resolver, not two

Task 2 pulls `resolveTargets` out of `readFileVerb`. Since the read slice merged, `readFileVerb` no longer holds that loop body. It calls `resolveReadPath(text, word, cwd, subject)`, which `inputRedirectRead` also calls for `<`. So the plan would leave two resolvers. `resolveReadPath` resolves and requires a file. `resolveTargets` would resolve and hand back both kinds.

Keep one function. Give `resolveReadPath` a parameter for what it wants, `"file" | "dir"`, with the two refusal messages in a small table keyed by it. Then the read verbs, `<`, the listings, and `find` all go through it, and `foldersOnly` is not needed.

### 2.4 A payload `maxResults` of 0

The ls tool's `maxResults` defaults to 1000, and `_glob` returns nothing for 0 (`lib/stdlib/shell.ts:623`). The plan's `maxResults: 0` for both means "no cap" on the bash path. The dev doc's "What the payload fields mean" already explains this difference for grep. Add `std::ls` and `std::glob` to it, because a policy author reading the tool docs would take 0 to mean "nothing".

---

## 3. Smaller points

1. `ls -l link`, with `link` pointing at a folder, lists the link itself on GNU and does not descend. The payload names the target folder, because `_searchTargetIn` realpaths it, so the question names more than runs. That fails safe. One sentence in the dev doc says so.
2. `tree` is not on macOS by default. The line is recognized, and the shell reports it missing, the same as `tac` in the read family. Say so in the table comment.
3. `find . -name a -o -name b` is refused by the repeated-flag rule, as Review Focus 2 says. That is the common way to ask for two extensions, so it is the first limit users will hit. Name it in the PR's "left out".
4. Task 2's `lsPayloadFields` compares `dir` with `FIXTURES`. `_searchTargetIn` realpaths, and the worktree path has no symlinked parts, so they match. A note in the node, like the plan's, is enough.

---

## Claims I checked and found true

1. The parser reads `ls -la src` as the flag `-la` and the literal `src`, and `find . -name '*.ts'` as `.`, the flag `-name`, and a single-quoted `*.ts`. It reads `find . -name *.ts` with a `glob` word, and `find . -print0` as a flag. `find . -exec rm {} \;` and `find . \( -name a \)` are unparseable.
2. macOS `ls -R`, `du -a`, and `find` do not follow a symlink to a folder below the path. I checked with a link to a folder holding `secret-name`, and none of them printed it. Review Focus 1 is right.
3. `std::ls { dir, recursive, maxResults }` and `std::glob { pattern, dir, maxResults }` are the tools' payloads (`stdlib/shell.agency:60-82`), and both carry `@alwaysUnder(dir)`.
4. `splitFlags` refuses a valued flag given twice, so `-name` twice is refused with "find takes `-name` only once", as the plan expects.
5. `git log | ls`: `ls` ignores its stdin, so not consulting `readsStdin` is right.
