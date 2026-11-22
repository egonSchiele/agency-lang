# Policy rules match lists, and `std::exec` asks how much of a command to approve

Date: 2026-11-22. Status: waiting for the owner's yes. Nothing is built.

This is the second version of this spec. The owner decided two things after the first: older policy files need not keep working, and whatever changes in a policy rule must hold for every effect and not only for `std::exec`. The architecture review beside this file reviewed the first version, and its finding about older copies of Agency no longer applies.

## The problem

When a program runs, the person is asked the `std::exec` question. One of the answers is "always approve when", which saves a rule so the same question is not asked again. For `std::exec` that rule pins the program and its first argument.

```
python3 -c 'print(1)'      →  saved rule: command = python3, subcommand = -c
```

Everything after the first argument is free, so that one answer approves every later `python3 -c …`, which is any code at all. The folder is not pinned, so the rule holds in every project.

`/Users/adityabhargava/agency-lang/safebash-security-review.md` lists this as the hole to fix first.

The rule was made broad on purpose, so that one answer covers `pnpm run build`, `pnpm run test`, and so on. Any change has to keep that.

The cause is in the policy rule itself. A rule matches each field of a question as one string, so it cannot look inside the list of arguments. `subcommand` was added to the question as a copy of the first argument to get around that, and nothing can pin the second.

## Part 1: a rule can match a list

This part is about every effect.

Today a rule's `match` holds one glob string per field. A list in the question is turned into text with commas before it is compared, so `["a,b"]` and `["a", "b"]` look the same to a rule.

The change is one rule about how a pattern meets a value. It depends on what the value is, and on nothing else.

| The value in the question | The pattern in the rule | It matches when |
| --- | --- | --- |
| a string, a number, or true/false | a string | the glob matches. This is today's behaviour. |
| a list | a string | the list is not empty, and the glob matches every item |
| a list | a list | the items match one by one, in order. A last item of `**` stands for "any items after this, or none". |
| anything else | anything else | never |

The third row uses `**` the way a path glob does. In `src/**` it means "any folders after this". In `["run", "agency", "**"]` it means "any arguments after this".

Examples across effects:

```json
"std::exec":       { "command": "pnpm", "args": ["run", "agency", "**"] }
"std::exec":       { "command": "python3", "args": ["-c", "print(1)"] }
"std::git::add":   { "cwd": "/Users/me/proj", "paths": "src/**", "all": "false" }
"std::applyPatch": { "files": "docs/**" }
```

- The first approves `pnpm run agency` followed by anything.
- The second approves that one script and no other.
- The third approves a `git add` when every path is under `src`. No rule can say that today. It also pins `all`, because `git add` with `all` set stages everything whatever `paths` holds.
- The fourth says the same for a patch.

Details that matter:

- **An empty list does not match a string pattern.** `git add --all` raises its question with an empty `paths`. If "every item matches" were true for no items, a rule written for `src/**` would approve it.
- **`**` is special only as the last item of a list pattern.** Anywhere else it is an ordinary glob and matches one item.
- **A pattern has a maximum length,** the glob library's own limit of 65,536 characters. A rule in a policy file with a longer pattern fails when the file is loaded. A value longer than that is never pinned: "always approve when" is not offered for that interrupt. Without this, a rule saved from a very long inline script would make the library throw on every later question.
- **Plain `@always` on a list field** saves the list as a list, item by item. It saved the joined text before, which would no longer match.
- **A list pattern against a value that is not a list does not match,** and the reverse is covered by the second row.
- **An item that is not a string, a number, or true/false never matches.** `std::edit` carries a list of edits, each an object, and no rule should match on those.
- **Items are compared as written.** The matcher strips a leading `./` from a value today, and gives `.` a meaning in a `dir` pattern. Neither applies to the items of a list: `./x` and `x` are different arguments, in both directions. The glob library drops a leading `./` from a pattern on its own, so the matcher handles it before the glob test. Otherwise a rule saved from `git checkout ./main`, which restores a file, would approve `git checkout main`, which switches branches.
- **A missing field does not match,** as today.

The limit of this design: a list pattern is by position, which suits arguments. For a list where order means nothing, such as paths, the useful question is "does every item match", and that is the string form. A rule cannot say "some item matches". Nothing needs that yet.

## Part 2: a tag for pinning the start of a list

Which fields "always approve when" pins is declared on the effect, with `@always` (the exact value) and `@alwaysUnder` (a folder and everything below it). A third tag joins them:

```
@alwaysPrefix(args)
```

It means: pin the leading items of this list, and let the person choose how many. It is a statement about an ordered list, and any effect with one can use it.

It follows the path of the other two tags. The typechecker checks that the field exists and is a list. Codegen registers it. The prompt reads it from the registry. The registry's `ScopedField` gains one optional flag; no second type is added.

`@always` on a list field keeps its meaning: pin the exact value, which for a list is the whole list.

## Part 3: `std::exec`

```
@always(command)
@alwaysPrefix(args)
@alwaysUnder(cwd)
effect std::exec {
  command: string;
  args: string[];
  cwd: string;
  timeout: number;
  stdin: string
}
```

Three changes:

- **`subcommand` is deleted.** It existed because a rule could not look inside `args`. It goes from the effect, from the `exec` tool, from safeBash, and from the `agency` rules in `recommended`, which become `"args": ["parse", "**"]` and so on.
- **The arguments are pinned from the start, as far as the person chooses.**
- **The folder is pinned.**

The `exec` tool also changes what it reports. safeBash always puts the real folder in `cwd`. The `exec` tool puts in whatever the model passed, which is often an empty string, and a rule cannot pin that. The tool will report the folder the command really runs in, which is also what the person should see.

## Part 4: the prompt

After "always approve when", the prompt asks up to two more questions. Each is skipped when it has only one possible answer.

**How much of the command.** The narrowest choice is first.

```
pnpm run agency test tests/agency/safeBash.agency

Which commands should this cover?
  1. pnpm run agency test tests/agency/safeBash.agency       this exact command
  2. pnpm run agency test tests/agency/safeBash.agency …
  3. pnpm run agency test …
  4. pnpm run agency …
  5. pnpm run …
```

`…` means "and any arguments after this". The last choice is what today's rule covers, so nothing gets broader than it is now. A command with no arguments has one choice. At most eight are listed: the narrowest ones, and the widest.

**Which folder.** This is the step reads already have.

```
Which folder should this cover?
  1. /Users/me/proj/packages/agency-lang
  2. /Users/me/proj                          the launch directory
```

It lists the folder the command ran in, then each parent, and stops at the launch directory. It never lists the home directory, the agent home, or a filesystem root. These are the rules `folderChoices` has today.

The rule that is saved:

```json
{
  "match": {
    "command": "pnpm",
    "args": ["run", "agency", "**"],
    "cwd": "{/Users/me/proj,/Users/me/proj/**}"
  },
  "action": "approve",
  "matchDotFolders": true
}
```

For the two cases that matter:

| Command | First choice | What the widest choice does |
| --- | --- | --- |
| `pnpm run build` | `pnpm run build`, this exact command | `pnpm run …`, as today, but only in the folder picked |
| `python3 -c 'print(1)'` | that one script | `python3 -c …`, as today, with the prompt showing it |

### What changes in the prompt code

Today an option carries one list of choices (`PromptOption.scopes`), which is always folders, and `resolvePromptOption` takes one pick. An option will carry a list of steps, each with its question and its choices, and `resolvePromptOption` takes one pick per step. Each pick is checked against the choices offered, as a folder pick is today.

Front-ends written in TypeScript read this shape, so Perry has to follow.

### Which effects get the folder step

The folder step is offered today only to the effects that read files (`SHARED_APPROVAL_SETS`, which holds `FileRead`). That list decides three things at once: the set-wide answer "always approve all reads in", the folder step, and rules that reach dot folders.

`std::exec` should get the second and third and not the first. So the list is split in two: the sets that get the set-wide answer, and the effects that get the folder step and dot folders, which are the file reads and `std::exec`.

This is the one place the change names an effect. The list is explicit on purpose. The doc gives the reason: a folder step on `std::remove` would let one key press approve removals across a far larger folder. Each effect added to it is a decision.

Dot folders matter here because a rule for `/Users/me/proj` and below would otherwise not cover a command run in `/Users/me/proj/.worktrees/x`. The folder in this rule is where a program starts, and a program started in `.worktrees/x` is no more dangerous than one started in `src`. The doc sentence that ties `matchDotFolders` to effects that only read changes with this.

## Choices made, for the owner to confirm

1. **No list of interpreters.** The security review suggests keeping `python`, `node`, `perl`, and `awk` away from the narrow question. With the narrowest choice first, `python3 -c '…'` pins the whole script unless the person picks something wider, and the prompt shows what the wider choice covers. That is one rule for every program. The same problem also exists for programs no list would name: `aws s3 …` approves `aws s3 rm`. The cost is that the wide choice is one key press away.
2. **Both questions in one pull request.** The first version of this spec suggested building the folder question second, because it changes the shape front-ends use. With one user and one front-end, that reason is gone.
3. **The owner's saved policy is rewritten once, by hand, with their yes.** See the next section.

## What happens to existing rules

- **A saved `std::exec` rule that names `subcommand` stops matching,** because the question no longer has that field. A rule that names a missing field never matches, so those commands ask again. That is the safe direction. It also retires the `command = sed, subcommand = -n` rule in the owner's policy, which approves `sed -n 'w somefile'`, a write.
- **A saved policy does not follow `recommended`.** The owner's `policy.json` holds its own copy of the `agency` rules, with `subcommand`. They need rewriting to the list form, or `agency parse` and the rest start asking.
- **Every other rule is untouched.** No other effect's question changes, and a string pattern against a string value matches as before.
- **One hand-written case changes meaning:** a string pattern against a list field. It compared against the comma-joined text, and it will compare against each item. The built-in policies have no such rule.

## What this does not fix

A rule for `pnpm run …`, `make …`, or `python3 scripts/x.py …` approves running code that lives in the project. If writes in the project are also approved, the agent can edit that code and then run it under the saved rule. No pin on the command line closes that. Only limiting what the process can do closes it, and that is separate work (`docs/dev/security/goal.md`).

Also out of scope:

- **"Always approve" (`aa`), the effect-wide answer,** still approves every `std::exec`. It is offered for every effect.
- **Glob words in `std::exec` arguments** (hole 4 in the review), and the review's other holes.
- **The list of programs safeBash keeps away from `std::exec`** (`NO_EXEC_PROGRAMS`). Its comments mention `subcommand` and are reworded. The list itself does not change.

## Interrupts and safety

- **No raise is added, removed, or moved.** This changes what a rule can say and what answering a question saves. It changes nothing about when a question is asked or which handlers see it.
- **A new `std::exec` rule is never broader than today's.** The widest choice is the program and its first argument, which is today's rule, and it now also pins a folder.
- **A rule can only narrow.** `buildScopedMatch` returns nothing when a pinned field is missing, so no rule is saved with an empty match, which would approve everything. That holds for the list: an `args` that is missing or is not a list saves no rule.
- **Argument text comes from the model.** Each argument goes through `escapeGlob` before it is saved, as scoped values do today, so `*` in an argument is a literal star and an argument that is the two characters `**` cannot be read as "any items after this". Each goes through `stripControlChars` before it is shown.
- **Rule order is unchanged.** `insertApproveRule` places the new rule after the effect's reject rules, so a wider folder never overturns a reject.
- **A list in the question can no longer be confused with its joined text.** That closes the `["a,b"]` case.

## One thing to expect in use

Answering with the first choice for a long inline script, such as `python3 -c '<forty lines>'`, saves the whole script in the policy file, and it will not be run again with the same text. For a one-off command the right answer is "approve once". The first choice says "this exact command" so that is plain.

## Tests

- **The matcher** (`lib/runtime/policy.test.ts`), one test per row of the table, and:
  - a list pattern matches the same arguments, and does not match a longer or shorter command without `**`;
  - `["-c", "**"]` matches `-c` alone and `-c` followed by anything;
  - a string pattern matches a list when every item matches, fails when one does not, and fails for an empty list;
  - a list pattern does not match a string value;
  - an item that is an object never matches;
  - `./x` in a list does not match the pattern `x`;
  - an escaped `*` matches only a literal star, and an escaped `**` is not "the rest".
- **The command choices** (`lib/runtime/alwaysChoices.test.ts`): no arguments gives one choice; one argument gives two; five give six, narrowest first; a long command is cut to eight and keeps the narrowest and the widest.
- **The saved rule** (`lib/runtime/interruptPromptOptions.test.ts`): each pair of picks saves the rule shown above; a pick that was not offered is refused; a step with one choice is not asked.
- **End to end,** in an Agency test:
  - approve `python3 -c 'print(1)'` with the first choice, then `python3 -c 'print(2)'` asks again;
  - approve `pnpm run build` with `pnpm run …`, then `pnpm run test` in the same folder does not ask, and does ask in a folder outside the one picked;
  - a rule saved for the launch directory covers a command run in a dot folder inside it.
- **The tag** (`lib/typeChecker/alwaysTag.stdlib.test.ts`): the new row for `std::exec`, and a diagnostic for `@alwaysPrefix` on a field that is not a list.
- **`recommended`:** `agency parse` is approved and `agency run` is not, through both the `exec` tool and the agent's own tests (`lib/agents/agency-agent/tests/execPolicy.agency`).
- **Other effects:** `std::git::add` with `"paths": "src/**"` is approved for paths under `src`, asks for a path outside it, and asks for a `git add` of everything, whose `paths` is empty.

## Docs

- `docs/dev/agents/approval-policies.md`: "Rule matching" gains the table; "What 'always approve when' pins" gains the command step and the split list; the paragraph that says an interpreter rule "should be keyed on `subcommand`" is rewritten.
- `docs/dev/language/effect-always-tag.md`: the third tag.
- `docs/dev/stdlib/safe-bash.md` and `docs/dev/stdlib/jobs.md`: the places that describe `subcommand`.
- The user guide's policy page is not edited in this pull request. It will not describe list rules until it is updated separately.
- The changelog note, in the pull request description: `subcommand` is gone from `std::exec`, and the `exec` tool reports the real folder.

## Size

About three and a half days, in one pull request:

| Part | Days |
| --- | --- |
| The matcher's list rule, the schema, and tests | 0.5 |
| The tag, through the typechecker, codegen, and registry | 0.5 |
| Deleting `subcommand`: the effect, the `exec` tool, safeBash, `recommended`, and their tests | 0.5 |
| The command choices and the rule they save | 0.5 |
| More than one follow-up question, in the terminal prompt and in the shape front-ends use; the split list | 1 |
| The `exec` tool's folder, the end-to-end test, and docs | 0.5 |

Perry's change to show the steps is not counted here.
