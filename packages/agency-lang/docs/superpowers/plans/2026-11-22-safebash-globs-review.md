# Architecture review: safeBash globs plan

Reviews `docs/superpowers/plans/2026-11-22-safebash-globs.md`. Findings 2 to 6 are applied to the plan. Finding 1 needs the owner's answer.

## Major features and API

The plan changes which interrupt a shell line raises, so it touches the language's most important feature. The change is deliberate and the owner approved it. Every question still goes through `raiseAll`, so no handler is skipped and no command runs without a question.

Two exported things would change under the first draft of the plan:

- `ReadSource` in `stdlib/safeBash/actions.agency` gained a kind. Finding 3 removes that change.
- `std::read`'s `filename` field can now hold a pattern such as `*.ts`. This is finding 1.

## Finding 1: a rule that names a file does not see a glob read (owner's call)

Take a policy that cuts a hole in a folder approval:

```json
"std::read": [
  { "match": { "dir": "/proj/config", "filename": "secrets.json" }, "action": "reject" },
  { "match": { "dir": "{/proj,/proj/**}" }, "action": "approve" }
]
```

Today `cat config/*.json` asks `std::bash`, so a person sees it. After Task 4 it asks `std::read { dir: "/proj/config", filename: "*.json" }`. The reject rule compares `secrets.json` with the text `*.json`, which does not match, so the second rule approves the read and `cat` prints `secrets.json`.

This already holds for grep. `grep -r KEY config` asks about the folder, and a comment in `lib/runtime/builtinPolicies.ts:86` says so: "the tree-searching effects carry no filename, so a rule that names one cannot match them". Task 4 puts a glob read in that same group.

No built-in policy is affected. Their only `std::read` rule with a `filename` is an approve rule for `settings.json`, and an approve rule that names a file never matches a pattern, which is the safe direction.

Task 4 is also the task with the least evidence. The trace has no read-family glob. The safeBash corpus has one in 132 lines, `wc -l stdlib/*.agency`.

Outcome: the owner said the matcher is wrong here and the reject rule should match. The plan now has a matcher task ahead of the read family (Task 4, with the read family as Task 5). The folder-search case is ticket ADI-364.

## Finding 2: `GlobPath` repeats `PathTarget`

The draft added `GlobPath { dir, pattern, argument }`. `PathTarget { dir, file, argument }` already exists and has the same three parts. `globPathOf` now returns a `PathTarget` whose `file` is the name pattern, and the name becomes `globTargetOf`.

## Finding 3: two ways to say "bash expands this"

The draft marked a glob grep with `GrepCall.expands` and a glob read with a new `ReadSource` kind. That is one idea with two spellings, and the second one changed an exported type. The plan now uses `expands: boolean` on `ReadPath` as well. The source stays `{ kind: "disk", dir, filename: "*.ts" }`, so `readPayloadOf` is unchanged.

The cost is that the compiler no longer forces each reader of a `ReadSource` to handle a glob. There is one reader that opens files, `shellFreeReadPlan`, and it gets the refusal.

## Finding 4: existing tests the plan did not name

The draft said to run all of `tests/agency/safeBash.agency` locally and fix what changed. These rows plan in a real folder and will change, and the plan now names them:

- `tests/agency/safeBash.agency:1490`, `grepNames("grep -rn hello *.txt")`
- `tests/agency/safeBash.agency:1870`, `readOf("cat *.txt")`
- `tests/agency/safeBash.agency:2723`, `grepNames("ls *.txt")`
- `tests/agency/safeBash-corpus.json:33`, `ls *.json`
- `tests/agency/safeBash-corpus.json:38`, `wc -l stdlib/*.agency`

The local run of the whole file is gone. CI runs it.

## Finding 5: test cost

Five nodes each built and deleted the tree with a shell call. The plan now has two nodes: one for every plan-level row, and one that runs commands.

## Finding 6: doc size

The doc step asked for a section with six parts. The feature is one rule with three callers. The section is now the example, the table, and the refusals, plus the limit from finding 1.

## Effort and impact

| Task | Effort | Impact | Must-do? |
|---|---|---|---|
| 1. `globTargetOf` | S | Needed by 2 to 4 | Yes |
| 2. grep | S | 5 of the 6 glob prompts in the trace | Yes |
| 3. Listings | S | 1 of the 6, plus one more inside a `cp` line | Yes |
| 4. Read family | S after finding 3 | None in the trace, 1 corpus line | Optional, see finding 1 |
| 5. End-to-end test and doc | S | Proves the excludes and the in-process refusal | Yes |

## The 80/20 check

Tasks 1 to 3 remove every glob prompt in the trace. No cheaper route covers grep: the model could be told to write `--include`, but that searches subfolders too and still costs the first prompt.

## Concepts added

One: "a glob in the file-name part of a path asks about the folder". It reuses the folder questions that exist. The only new thing a policy author has to learn is finding 1.
