# Review, round 2: `ls`, `tree`, `du` ask `std::ls`; `find` asks `std::glob`

This is a second review of `docs/superpowers/plans/2026-11-01-safebash-listings-std-ls-glob.md`, as of the owner's decision commit cb0efc44e (recursive listings through bash are narrow).

I checked the revised plan against `readFlagWord`, `readLongFlag`, `splitFlags`, `readFileVerb`, `otherVerbEffects`, the `ls` and `glob` tools, the `recommended` policy rules, and the existing test rows. I did not run any tests.

The first-round findings are folded in, and the owner's decision is recorded at the top. The new findings are in three groups:

1. Fix before building. One `find` payload can describe the opposite search, and three groups of expected messages will not match what the code produces.
2. Should fix.
3. Smaller points.

---

## 1. Fix before building

### 1.1 `-not` and `-o` make the pattern understate or invert the search

The pattern table builds `**/` plus the `-name` value whenever `-name` is given. `FIND_FLAGS` also allows `-not` and `-o`, and the table never looks at them:

| Command | Payload pattern | What find lists |
|---|---|---|
| `find . -not -name '*.ts'` | `**/*.ts` | every entry that is not a `.ts` file |
| `find . -name '*.ts' -o -type d` | `**/*.ts` | the `.ts` files and every folder |
| `find . -path ./node_modules -prune -o -name '*.ts'` | `**/*.ts` | the `.ts` files and `./node_modules` itself |

The first row's payload names the opposite of the search. Round 1 asked for the `**/` prefix because a payload that named a smaller search than the one that runs is wrong. These rows have the same problem.

Suggested fix: the pattern is `**/` plus the value only when the expression has no `-not`, `-o`, or `-prune`. Otherwise it is `**`, or `*` at `-maxdepth 1`. `**` says the search may list anything under `dir`, which is true for every expression this allowlist accepts. That keeps the common `-not -path '*/node_modules/*'` narrow. Add a row for each of the three commands above to the payload node, expecting `**`. Dropping the three words from `FIND_FLAGS` would also work, but it sends the `node_modules` idiom to `std::bash`.

### 1.2 An unknown whole flag is reported one letter at a time

After Task 1, `readFlagWord` tries the whole word and then falls back to the letter loop. `FIND_FLAGS` lists no letters, so every unknown `find` word fails on its first letter:

- `find . -iname '*.TXT'` gives "find does not take `-i`".
- `find . -delete` gives "find does not take `-d`".
- `find . -newer one.txt` gives "find does not take `-n`".

Task 3 expects `-iname`, `-delete`, and `-newer`. The model reads these messages, and "`-d`" does not tell it what was refused.

No verb in this plan mixes the two kinds. `ls`, `tree`, and `du` list letters, and `find` lists whole words. So mixing them in one table, which Task 1's `WHOLE_FLAGS` test sets up, is a case no verb needs. Suggested design: `FlagSpec` gains `wholeWords?: boolean`. When it is true, a single-dash word is looked up whole, an unknown one fails with its whole name, and the letter loop never runs. `FIND_FLAGS` sets it. Task 1's test then uses a find-shaped spec (`plain: ["-print"]`, `valued: ["-name"]`, `wholeWords: true`), and the `-nam` row expects "x does not take `-nam`". The fallback to letters goes away, and so does the second-guessing about which branch runs first. The `flagValue` refusal still runs before the lookup, so `-name=x` is refused as round 1 asked.

### 1.3 `ls --color=always .` is reported as `--color`

The parser splits `--color=always` into the flag name `--color` and the value `always`. `readLongFlag` (`stdlib/safeBash.agency:682-713`) fails with `` `${word.flagName}` `` when the name is not in `spec.valued`. So the message is "ls does not take `--color`", and Task 2 expects "ls does not take `--color=always`". Either pin `--color`, or change that one failure in `readLongFlag` to print `written`, which already holds the whole flag. I'd change it, because "`--color`" reads as if `--color=never` were refused too. That also changes the message for grep, so check the grep rows that pin it.

### 1.4 Task 3's expected list does not match its rows

The text says rows 1, 3, 4 (two), and 5 give `std::glob`, and row 6 is `-H`. In the node as written, row 4 is `find . -H -name x`, row 5 is `find . . -name x` (the two-effect row), and row 6 is `find . -maxdepth 2 -print0`. So the glob rows are 1, 3, 5 (two), and 6, and `-H` is row 4. Write each row's expected value next to the row, the way Task 2 does, so the numbering cannot drift.

---

## 2. Should fix

### 2.1 Existing rows that use `ls` as "a command with no rule"

Several rows plan `ls` in `/repo`, a folder that does not exist, to show an unrecognized command:

- `classifyOneCommand`, `effectNamesFor("ls")` (`tests/agency/safeBash.agency:73`)
- `wholeStringPlans`, `git status; ls`, `ls`, and `git status && ls` (`:104`, `:105`, `:113`)
- `rebuiltVersusOriginal`, `ls    -la` (`:129`)
- `agencyCommandLines`, `ls agency-lang` (`:401`)

After Task 2 these rows still pass, because the `.` path does not resolve in `/repo`. But the reason changes from "no rule for `ls`" to a missing path. The tests keep their names and stop testing what the names say. Swap `ls` in each for a verb that is meant to stay broad, such as `xargs`, which the wrapper rule keeps on `std::bash` (the test file already uses `xargs rm x` this way). List the swaps in Task 2.

### 2.2 `-maxdepth 0` is not in the pattern table

The table has rows for "absent, or more than 1" and "1". `find . -maxdepth 0` lists only the start path, and no row covers it. Refuse a `-maxdepth` of 0 with a short message, or add a row. A refusal is the smaller rule.

### 2.3 `du` should not point at the ls tool

Task 2 adds `du: "ls"` to `READ_TOOL_FOR_VERB`. The ls tool reports each entry's size. It does not report a folder's total, which is what `du -sh` asks for. The table's comment already leaves out `wc` for the same reason: "the read tool cannot count lines". Leave out `du` too.

### 2.4 The `ListVerb` block is missing `countFlags`

The prose under `LIST_VERBS` says to give `ListVerb` a `countFlags: string[]` (`["L"]` for tree, `["d"]` for du, `[]` for ls). The type block and the `LIST_VERBS` literal above it do not have the field. An implementer who copies the blocks will miss it. Put the field in both blocks.

---

## 3. Smaller points

1. `resolvePath` returns `GrepTarget`. After this plan the type is used by the read verbs, `<`, the listings, and `find`, and by grep. Renaming it to something like `PathTarget` would match what it now holds. The comment that ties it to `GrepTarget` in `lib/stdlib/shell.ts` can stay.
2. `lsPayloads` reads `e.payload.dir` inside a comprehension filtered by `e.name == "std::ls"`. The existing payload tests narrow with an `if` inside a `for` loop (`readPayloadNamesTheRealParent`, `tests/agency/safeBash.agency:914-919`). Copy that shape, since a comprehension filter may not narrow `payload` to `LsPayload`.
3. The PR's "left out" list names `find . -name a -o -name b`. With finding 1.1 fixed, `find . -name a -o -path b` is narrow with pattern `**`. One sentence in the dev doc says which forms of `-o` work and which do not.

---

## Claims I checked and found true

1. The owner's decision is recorded at the top of the plan, and Task 4's dev doc section states it as a rule.
2. `std::ls` and `std::glob` have `recommended` rules (`readScopeRules()`, `lib/runtime/builtinPolicies.ts:154-155`), and their declarations (`stdlib/shell.agency:60-82`) carry `@alwaysUnder(dir)`. The `std::read` raise already adds a `command` field its declaration does not list, so the new raises can add one too.
3. `readFileVerb`'s count loop prints `` `-${entry.flag}` `` (`stdlib/safeBash.agency:1281-1285`), so `checkCountFlags` needs `flagDisplay`, as the plan says.
4. `splitFlags` refuses a valued flag given twice with `flagDisplay` (`stdlib/safeBash.agency:595-600`), so "find takes `-name` only once" is the right expected text.
5. `LiteralWord` is `{ tag: "literal"; text: string }` (`stdlib/safeBash.agency:57-60`), so the default `.` word in `listEffects` needs only those two fields.
6. The ls tool skips `SKIP_DIRS` only when recursive, and leaves symlinked entries out (`stdlib/shell.agency:208-215`), as the plan's background says.
