# Review: approval prompt broader answers

Plan reviewed: `docs/superpowers/plans/2026-11-10-approval-prompt-broader-answers.md`

Paths below are relative to `packages/agency-lang`.

## Summary

The plan is in good shape. Its line numbers match the code, its background
is accurate, and the tasks are in a sensible order. I checked its claims
against `stdlib/policy.agency`, `lib/runtime/policy.ts`, `lib/stdlib/cli.ts`,
`stdlib/ui/cli.agency`, the effect declarations, and the existing tests.

Four findings should change the design before anyone builds it. Each one
lets a single answer approve more than the person at the prompt can see or
intended.

1. An `as` answer ignores a caller's `fields:` override for the other
   members of the set.
2. When no REPL is running, the prompt falls back to a picker that shows
   only the key and the label. The detail column, which now holds the
   scope, does not appear there.
3. The folder step applies to every effect with an `@alwaysUnder` tag,
   including `std::write`, `std::remove`, and `std::git::commit`, and it
   offers the home directory as one keystroke.
4. The plan treats "`**` does not enter a dot folder" as a working safety
   rule. (A dot folder is a folder whose name starts with a period, such as
   `.git`.) The rule holds only when the dot folder is in `dir`. A model can
   put it in `filename` instead.

Findings 5 to 14 are errors in the plan's steps that would cost time during
the build, such as a wrong file path, a flag the js test runner does not
accept, and a test the plan does not list. Smaller points and questions for
the owner come last.

## Findings that change the design

### 1. `as` bypasses a caller's `fields:` override for the other members

`cliPolicyHandler(file, fields: { "std::read": [] })` tells the handler to
never offer a scoped "always" answer for `std::read`. `scopedFieldsFor`
(`stdlib/policy.agency:268`) applies the override, so today the handler
never writes a scoped rule for `std::read`.

The plan's `sharedApprovalSet` compares the registered scopes from
`allAlwaysScopes()`, which knows nothing about overrides. So at an `ls`
prompt, the menu still offers `as`, and choosing it writes a rule under
`std::read`. The caller had turned that off.

The same happens with an override that changes the shape of the scope. If a
caller pins `std::grep` to an exact `dir`, an `as` answer at an `ls` prompt
writes a subpath rule under `std::grep`.

The fix is to resolve each member's scope the way `scopedFieldsFor` does:
the override when there is one, and the registry otherwise. Pass
`globalCliPolicyOpts.fields` into the bridge, and merge it over
`allAlwaysScopes()` in TypeScript before calling `sharedApprovalSet`.
`generatedRuleMatchesDotFolders` should take the resolved fields too. Add a
test: with an override of `[]` for `std::read`, an `ls` interrupt does not
offer `as`.

Review focus item 3 covers an override for the effect being prompted. It
does not cover an override for another member of the set.

### 2. The detail column is lost when no REPL is running

`interruptChoice` (`stdlib/ui/cli.agency:378`) draws the pinned footer only
when a line-mode REPL is running and both stdin and stdout are terminals
(`_stickyInterruptAvailable`, `lib/stdlib/cli.ts:765`). Otherwise it calls
`chooseOption`. In a terminal, `chooseOption` uses `autocomplete`, which
shows each item as `key - label` (`lib/stdlib/prompts.ts:185` and `:209`).
It never reads a `detail` field.

Today the scope is part of the label: `approve always here
(dir={/x,/x/**})`. The plan moves the scope into `detail`. A program that
installs `cliPolicyHandler` and runs in a terminal without `repl()` would
show this:

```
ap - always approve when
as - always approve FileRead when
```

The person cannot see what they are approving. The agent always runs a
REPL when it prompts, so the agent is unaffected. But `cliPolicyHandler` is
a public stdlib function, and its module docs present it as a terminal
prompt.

The smallest fix is in `interruptChoice`. Before it calls `chooseOption`, it
appends `detail` to `label` for any item that has one. Task 3 Step 3 then
changes two things in `stdlib/ui/cli.agency`, so its sentence "That is the
only change in this file" needs updating.

The plain fallback in `chooseOption` (line 294, used when stdout is not a
terminal) prints the title and the body but no items. For the folder step,
that hides the list of folders, and the person has to pick a number they
cannot see. Printing one line per item there takes three lines of code. The
plan chose to leave the fallback as it is. I would add the lines, because
the folder step depends on the items being visible.

### 3. The folder step reaches far past the case that motivated it

The trace that motivated this plan was about reads. As written, the folder
step appears for `ap` on every effect whose scope has one `@alwaysUnder`
field. Dozens of stdlib effects have that tag, including these:

- `std::write`, `std::writeBinary`, `std::edit`, `std::mkdir`, `std::copy`
- `std::remove`, tagged `@alwaysUnder(target)` (`stdlib/fs.agency:42`)
- every `std::git::*` effect, such as `std::git::commit`, tagged
  `@alwaysUnder(cwd)` (`stdlib/git.agency:109`)
- `std::toolbox::save` and `std::skills::save`

Suppose the agent asks to remove `~/bench/jobs/out.txt` and the person
answers `ap`. The folder list ends at `/Users/me`, labelled "your home
directory". One more keystroke saves "always approve `std::remove` anywhere
in my home directory". Today the widest rule an `ap` answer can save is the
folder the interrupt named.

For reads, the home directory has its own problem.
`lib/runtime/builtinPolicies.ts:40-48` explains why `recommended` leaves the
agent home out of read scope on purpose: `sessions/` and `history` hold
earlier conversations, and `recommended` also approves web searches, so
injected text could have the agent search old conversations and send what
it finds out in a query. A rule for `{~,~/**}` with `matchDotFolders: true`
covers `~/.agency-agent/sessions`, `~/.ssh`, and `~/.aws`. The plan answers
this with a label and a paragraph in the dev doc. The label warns the
person, and the grant is still one keystroke away.

I recommend two changes, both for the owner to confirm:

- Offer the folder step only for effects in a listed set, which today means
  `FileRead`. For every other `@alwaysUnder` effect, `ap` saves the folder
  in the interrupt, as it does now. This keeps the change to the case the
  trace showed.
- Stop the list one level below the home directory, so the home directory
  itself is never offered. If the owner wants home offered, at least do not
  set `matchDotFolders` on a rule whose folder is home or a folder above it.

Decision 3 in the plan describes the cost of the folder step as one extra
keystroke. The decision should also name the reach described above.

### 4. The dot-folder rule does not protect what the plan says it protects

The plan's "Three limits" item 3, its "Dot folders" section, and Task 5 all
treat "`**` does not enter a dot folder" as a rule that works. The plan
says that after this change, "an approved `std::write` under a folder still
does not reach its `.git`".

That is true only when the dot folder is part of `dir`. `locateSync`
(`lib/host/node/nodeFiles.ts:197-216`) keeps `dir` as the folder the caller
passed and puts the rest of the path in `filename`. Take this call:

```
write(".git/hooks/pre-commit", content, dir: "/Users/me/proj")
```

It raises `std::write` with `{ dir: "/Users/me/proj", filename:
".git/hooks/pre-commit" }`. A saved rule
`{ dir: "{/Users/me/proj,/Users/me/proj/**}" }` approves it, because the
rule looks only at `dir`. The same is true of `read(".env")` in the launch
directory, which `recommended` approves today through `{.,./**}`.

This hole exists today, and this plan did not create it. It still changes
three things:

- Remove the sentence about `std::write` and `.git` from the plan, and do
  not write it into `approval-policies.md`. The doc already says "This is
  what shields `.git` from broad approve rules" (the "Rule matching"
  section, item 3). That sentence is also wrong, and Task 5 should correct
  it.
- Decision 1 asks the owner to add a field to the policy format, which
  every Agency program shares. The owner should know that the boundary this
  field relaxes is already porous, so the field gives up less safety than
  the plan suggests.
- Open a GitHub issue for the `filename` hole in write rules. The fix does
  not belong in this plan.

## Findings in the plan's steps

### 5. A test the plan does not list will fail

`tests/agency/policy-ask-value-interrupt/main.agency` checks the order of
the keys: `"a,r,aa,ap,rr"` at line 11, and `"a,r,aa,rr"` at lines 20 and
25. The plan reorders the keys to `a, aa, ap, as, r, rr`. Task 4 Step 2
lists the tests to update and leaves this one out. "How to test" runs it,
so the failure would be caught, but the plan should list the new expected
strings.

This test file is also a better home for two of the new cases in Task 4
Step 1:

- "A value interrupt answered `as`." Add `"as"` to the loop at line 36,
  which already checks `aa`, `ap`, and `rr` typed at a question.
- "An empty override." Call `askUserChoices` directly after
  `cliPolicyHandler(file: ..., fields: { "std::ls": [] }, policy: {})`, the
  way `lib/agents/agency-agent/tests/envPolicy.agency` does.

The agency-js test then covers only what needs a real handler and a policy
file on disk.

### 6. The stdlib test file the plan names does not exist

The plan names `lib/utils/alwaysTag.stdlib.test.ts` in Task 2 Step 2 and in
the vitest command under "How to test". The file is
`lib/typeChecker/alwaysTag.stdlib.test.ts`. A vitest filter naming a path
that does not exist matches no tests.

That file already has a decision table with one row per effect. For
example, line 70 says `std::vision` is `["dir/**"]`. Its loader functions
are not exported. So instead of a new file,
`lib/runtime/alwaysChoices.stdlib.test.ts`, that reuses the loader, add one
`it` block to `alwaysTag.stdlib.test.ts`. The block checks that for each
set in `SHARED_APPROVAL_SETS`, every member's declared scope equals the
first member's. Then drop the new file from the file map.

### 7. `agency test js` does not take `--check-capabilities`

The `test` command declares `--check-capabilities`
(`scripts/agency.ts:1632`). The `js` subcommand (`scripts/agency.ts:1751`)
declares its own options, and the flag is not among them. The two `test js`
commands in "How to test" will either fail on the flag or ignore it. Drop
the flag from those two lines. Use it on the
`tests/agency/policy-ask-value-interrupt` run, which goes through
`agency test`.

### 8. The Agency `PolicyRule` type needs the new field

Task 1 adds `matchDotFolders` to the zod schema in `lib/runtime/policy.ts`.
`stdlib/policy.agency:92` declares its own `PolicyRule` type, and the
generated stdlib docs show that type to users. Add `matchDotFolders?:
boolean` there with a doc comment, and add the file to Task 1. Without it,
the documented type does not describe what the prompt saves, and the
typechecker may reject the object literal in `recordScopedRuleFor`.

The dev doc should also say what an older Agency version does with the
field. Zod drops unknown keys without failing, so an older version that
reads a policy with `matchDotFolders` ignores the field. Its rules then
match fewer interrupts, and nothing is approved that would not be approved
before.

### 9. `recordScopedRule` changes behavior for every caller

Task 4 routes `recordScopedRule` through `recordScopedRuleFor`, which adds
`matchDotFolders: true` for `FileRead` effects. `recordScopedRule` is
exported, and its docs offer it to programs that build their own approval
UI. After this change, those programs write rules that enter dot folders
without having asked for that.

Either keep `recordScopedRule` as it is and add the field only on the
prompt's path, or add this change to the plan's decisions. I recommend the
first. Also, `recordScopedRuleFor` does not need to be exported, because
`askUser` is its only caller.

### 10. The detail column needs `stripControlChars` too

Task 4 Step 5 says that every string the folder step prints goes through
`stripControlChars`. The detail column on the first prompt also prints
interrupt data, such as `dir`, `baseUrl`, and `owner`, and a model can
influence those values. The comment in `prettyPrintInterruptData`
(`stdlib/policy.agency:837`) explains why this matters for layout too: the
footer's width math counts an escape sequence as visible width.

Task 4 Step 3 should say that the `detail` for `aa`, `ap`, and `as` is
stripped. Add a test with an escape sequence in `dir`. Today's label
appears to have the same gap, because `_escapeGlob` does not remove control
characters.

### 11. How a long detail wraps

The `optionRows` doc comment says "One or two lines per item". The test in
Task 3 uses a detail of more than 100 characters at width 60, which needs
three lines. The plan relies on `buildFrame` to wrap the long line.
`buildFrame` wraps at the left edge, so the continuation lines lose their
indent, and the path breaks wherever the width falls.

I suggest that `optionRows` wrap the detail itself, indented under the
label, and that the doc comment say "one or more lines". The 60-column test
can then check that every row after the first starts with the indent.

The footer also gets taller. The answers grow from about two rows to six,
plus any wrapped details. With a six-row body, the footer reaches about 20
rows. I did not find a height cap in `installBottomRegion`. Add "a
terminal 24 rows tall" to the checks by hand.

### 12. Edge cases for `folderChoices`

The plan's tests do not cover these cases:

- "Inside" must compare whole path segments. With the launch directory
  `/Users/me/proj`, the folder `/Users/me/proj2/x` is outside it, so its
  list stops at home.
- The launch directory can be the home directory. Which note does it get? I
  suggest "your home directory", since that is the one to warn about.
- The value may not be an absolute path. File tools always put an absolute
  path in `dir`, but effects that users declare may not. The exec tool's
  `cwd`, for example, is often `""` (see the `std::exec` paragraph in
  `docs/dev/agents/approval-policies.md`). `path.dirname("")` returns
  `"."`. For a value that is not absolute, return the value alone, or skip
  the folder step.
- Import `path` from `#path`, as `lib/runtime/agentHome.ts` does. The
  browser bundle reaches files in `lib/runtime/`.

### 13. The end-to-end test in Task 4

- `ls` and `grep` live in `std::shell`, and the prelude does not include
  them. Add `import { ls, grep } from "std::shell"`, as
  `tests/agency/stdlib/search-paths.agency` does.
- The plan says the read in `.w/a/.build` makes the test fail without
  `matchDotFolders`. That read is the interrupt the person answers, so no
  saved rule decides it. The `grep` of the same folder is the call that
  shows the rule enters dot folders. Say so in the plan, so that whoever
  edits the test later keeps the `grep`.
- The `ap` case should also check that a `read` in the chosen folder still
  prompts. That check shows the `ap` rule stayed on one effect.

### 14. The old phrase appears in more places than Task 5 lists

A search for "approve always here" also finds these:

- `lib/typeChecker/diagnosticExplanations.ts:324`. `make` copies this text
  into `docs/site/diagnostics/effects.md`, so users read it.
- `lib/agents/agency-agent/tests/envPolicy.agency` and its `.test.json`.
  The expected output `"approve always here (name=BRAVE_API_KEY)"` changes,
  and the test has to read `detail` to keep checking the scope.
- Comments in `lib/runtime/alwaysScope.ts:2`, `lib/runtime/ipcChild.ts:33`,
  `lib/stdlib/system.ts:175`, `lib/runtime/builtinPolicies.ts:203`, and
  `lib/typeChecker/alwaysTag.ts`.

The code keeps the value `"approve-always-here"`, so a comment that refers
to that value could keep the phrase. Pick one rule, and list the files that
change under it.

## Smaller points

- `describeScope` skips a field the data lacks. The prompt never reaches
  that case, because the menu offers `ap` only when `buildScopedMatch`
  found every field. If it did reach it, the prompt would describe a
  narrower rule than the one saved. Drop the behavior and its test, or
  return `""`, the way `buildScopedMatch` returns `{}`.
- `sharedApprovalSet` picks "the one with the fewest members" when several
  listed sets match. The list has one entry. Drop the tie-break until a
  second set is listed.
- Task 4 Step 6 says `recordScopedRuleFor` "skips an effect whose first
  rule is already the same rule". No step explains when that happens, and
  Agency has no `sameRule` to call. Drop it, or say which case it handles
  and which helper it uses.
- An `as` answer prepends an approve rule under effects the person was not
  asked about. Suppose they earlier answered `rr` for `std::glob`. An `as`
  answer at a `read` prompt would then approve `glob` in the chosen folder,
  because the new rule comes first. Skip a member whose policy already
  rejects the same interrupt. To check, run `checkPolicy` on a copy of the
  interrupt with that member's effect. The folder step's members line can
  leave the skipped members out.
- The folder step's title, "Always approve FileRead when dir is which
  folder, and below?", is hard to read. A suggestion: "Always approve
  FileRead in which folder? Folders inside it are included."
- The second `interruptChoice` call logs a second prompt wait
  (`_logPromptWait`, `stdlib/ui/cli.agency:405`). The logs will then show
  two prompts for one interrupt. Mention this in the dev doc.
- `agency run` has its own approval prompt in
  `lib/runtime/interruptPrompts.ts`, with the keys `a`, `r`, `aa`, and `rr`.
  Add one line to the plan saying it is out of scope.

## Questions for the owner

1. Should the folder step apply only to `FileRead` effects? (Finding 3.)
2. Should the folder list ever offer the home directory? If it does,
   should a read rule for the home directory enter dot folders? (Finding
   3.)
3. Now that the dot-folder rule is known to be porous, do you still want a
   new policy field for it? Should the `filename` hole in write rules get
   its own issue? (Finding 4.)
4. Should `recordScopedRule` stay as it is for programs with their own
   approval UI? (Finding 9.)
