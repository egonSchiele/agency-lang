# Approval prompt: one answer per line, a set-wide answer, and a folder picker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person at the approval prompt give a broader read approval in
one answer, and make the prompt easier to read.

**Architecture:** The prompt keeps getting everything from data an interrupt
already carries: its effect, its message, its data, and the `@always` /
`@alwaysUnder` tags on the effect's declaration. Pure helpers in
`lib/runtime/` decide what the prompt offers. `std::policy` calls them and
records the rules. `lib/stdlib/cli.ts` draws the answers one per line. One
constant names the effect sets that get the broader answers. No code names a
single effect.

**Tech stack:** TypeScript runtime (`lib/runtime/`, `lib/stdlib/`), Agency
stdlib (`stdlib/policy.agency`, `stdlib/ui/cli.agency`), vitest, Agency and
agency-js tests.

**Spec:** There is no separate spec. The design was settled in conversation
and is written out in "Background" and "The design" below. The review of an
earlier draft is in
`docs/superpowers/plans/2026-11-10-approval-prompt-broader-answers-review.md`.

## Background

### Why this work exists

In trace `g-4ALvj-hqw9Sl69-etaa` the agent took 22 minutes to answer a
question. The model worked for about 47 seconds. The rest was the user
answering approval prompts. They approved a `std::read` in a folder, then were
asked again for `std::ls` in the same folder, then for `std::grep`. They also
wanted to approve a parent folder (`.worktrees`) when the prompt only offered
the exact folder in the interrupt
(`.worktrees/agent-prompt-cleanup/packages/agency-lang/.agency-build/prompt-cleanup`).

### How the prompt works today

Read these before changing anything:

- `docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`, `policies.md`
- `docs/dev/agents/approval-policies.md`
- `docs/dev/language/effect-always-tag.md`

The short version follows.

`cliPolicyHandler` in `stdlib/policy.agency` is a handler. For each interrupt
it first checks the saved policy. If no rule decides, `askUser`
(`stdlib/policy.agency:965`) draws a prompt and waits.

The prompt is built from four things:

| Part | Where it comes from |
|---|---|
| Title | `intr.effect` in bold, then `intr.message` exactly as the raiser wrote it |
| Table | Every field of `intr.data`, through `prettyPrintInterruptData` |
| Answers | `askUserChoices` (`stdlib/policy.agency:920`), a list of `{ key, label }` |
| Scope of "always here" | The effect's tags, through `buildScopedMatch` (`stdlib/policy.agency:292`) |

The tags look like this:

```ts
@alwaysUnder(dir)
effect std::ls { dir: string, recursive: boolean, maxResults: number }

@always(method, baseUrl)
effect std::http::fetch { ... }
```

`@always(x)` means a saved rule pins the exact value of `x`. `@alwaysUnder(x)`
means the rule pins the value and every path below it, written as the glob
`{value,value/**}`. The runtime keeps these in a registry
(`lib/runtime/alwaysScope.ts`) as `{ field, matchSubpaths }[]` per effect. A
caller of `cliPolicyHandler` can replace an effect's scope with its `fields:`
argument, and an empty list turns the scoped answer off for that effect.
`scopedFieldsFor` (`stdlib/policy.agency:268`) applies that override.

The five answers today are:

| Key | Label today | What it saves |
|---|---|---|
| `a` | approve once | nothing |
| `r` | reject once | nothing |
| `aa` | approve always (every future std::ls) | `{ action: "approve" }` under the effect |
| `ap` | approve always here (dir={/x,/x/\*\*}) | `{ match: {...}, action: "approve" }` under the effect |
| `rr` | reject always | `{ action: "reject" }` under the effect |

The prompt is drawn in one of three ways, chosen in `interruptChoice`
(`stdlib/ui/cli.agency:378`):

1. **The pinned footer**, when a line-mode REPL is running and both stdin and
   stdout are terminals. `renderInterruptFooter` (`lib/stdlib/cli.ts:601`)
   draws it and `packOptions` (line 523) packs the answers onto as few lines
   as fit. `agency agent` always uses this one.
2. **A picker**, when there is a terminal and no REPL. `chooseOption` calls
   `autocomplete`, which shows each item as `key - label`
   (`lib/stdlib/prompts.ts:185` and `:209`).
3. **Plain input**, when stdout is not a terminal. `chooseOption` (line 294)
   prints the title and body and reads a line. It prints no items. Tests use
   this path through `inputOverride`.

`agency run --interactive` has a separate prompt in
`lib/runtime/interruptPrompts.ts`, with the keys `a`, `r`, `aa`, and `rr`.
This plan does not change it.

### Three limits this plan removes

1. **A rule belongs to one effect.** Approving `std::read` under a folder says
   nothing about `std::ls` there.
2. **The folder is always the one in the interrupt.** There is no way to pick
   a parent.
3. **`**` does not enter a dot folder.** A dot folder is one whose name starts
   with a period, such as `.git`. In a policy glob, `/x/**` does not match
   `/x/.cache/y`. This is picomatch's default. A rule for everything under
   `.worktrees` would still not cover `.worktrees/a/.agency-build`.

### What the dot-folder rule does and does not protect

`docs/dev/agents/approval-policies.md` says the dot rule "is what shields
`.git` from broad approve rules". That is only partly true, and this plan must
not repeat it.

A file effect's payload has two fields, `dir` and `filename`. `locateSync`
(`lib/host/node/nodeFiles.ts:197`) keeps `dir` as the folder the caller
passed and puts the rest of the path in `filename`. So this call:

```ts
write(".git/hooks/pre-commit", content, dir: "/Users/me/proj")
```

raises `std::write` with `{ dir: "/Users/me/proj", filename:
".git/hooks/pre-commit" }`. A rule `{ dir: "{/Users/me/proj,/Users/me/proj/**}" }`
approves it, because a rule on `dir` never looks at `filename`. The same is
true of `read(".env")` in the launch directory, which `recommended` approves
today.

The dot rule therefore blocks a dot folder only when it appears in `dir`. This
is how rules work today, and this plan leaves it alone: a person who approves
writes across a project has already let the model change any file that runs
on the next build. It matters here for two reasons. The dev doc's sentence
should be corrected (Task 5), and the new rule field in Task 1 gives up less
protection than it would seem to.

### Effect sets

`stdlib/effectSets.agency` declares named groups of effects:

```ts
export effectSet FileRead = <std::read, std::readBinary, std::ls, std::glob, std::grep, std::vision>
```

`make` generates `lib/runtime/effectSets.data.ts` from that file, and
`builtinEffectSets()` in `lib/runtime/effectSets.ts` returns the table. The
`--approve FileRead` flag already expands a set name to its members.

## The design

### The prompt

```
──────────────────────────────────────────────────────────────────────────
 std::ls  Are you sure you want to list this directory?
 ╭────────────────────────────────────────╮
 │ dir        │ /Users/adityabhargava/foo │
 │ recursive  │ false                     │
 │ maxResults │ 100                       │
 ╰────────────────────────────────────────╯
 a    approve once
 aa   always approve                 every std::ls
 ap   always approve when            dir = /Users/adityabhargava/foo and below
 as   always approve FileRead when   dir = /Users/adityabhargava/foo and below
 r    reject once
 rr   always reject                  every std::ls
 or type a reason · Enter to submit
 > ▏
```

- The title and the table do not change. The message is the interrupt's own.
- Each answer is on its own line, in three columns: key, label, detail.
- Approving keys are green and bold. Rejecting keys are red and bold. Labels
  are plain. The detail column is dim. The effect name in the title is cyan
  and bold.
- The approving answers come first, then the rejecting ones.
- The wording is "always approve", "always approve when", and "always reject".
- A detail too long for its line wraps onto more lines, each indented under
  the label, so a long path is shown whole.

### The detail column comes from the tags

One function turns an effect's scope and an interrupt's data into words:

- A field tagged `@always(x)` prints as `x = value`.
- A field tagged `@alwaysUnder(x)` prints as `x = value and below`.
- Several fields are joined with `, `.

| Effect and tag | Detail for `ap` |
|---|---|
| `std::ls`, `@alwaysUnder(dir)` | `dir = /Users/adityabhargava/foo and below` |
| `std::http::fetch`, `@always(method, baseUrl)` | `method = GET, baseUrl = https://example.com` |
| `std::github::prGet`, `@always(owner, repo)` | `owner = egonSchiele, repo = agency-lang` |

The raw glob (`{/x,/x/**}`) is never printed. The values come from interrupt
data, which a model can influence, so every detail goes through
`stripControlChars` before it is shown.

### The other two ways of drawing the prompt

The scope used to be part of the label. Now it is in `detail`, which only the
pinned footer knows how to draw. So that the picker and the plain-input path
still show what is being approved, `interruptChoice` does two things on the
path that does not use the footer:

- It folds each item's detail into its label, as `label (detail)`.
- When stdout is not a terminal, it appends one line per item to the body, as
  `key  label (detail)`. The folder step needs this: without it a person would
  pick a number from a list they cannot see.

Both changes are in `interruptChoice`. `chooseOption` and its other callers do
not change.

### `SHARED_APPROVAL_SETS`

One constant in the runtime, `SHARED_APPROVAL_SETS = ["FileRead"]`, names the
effect sets that get the three broader behaviors below. The list holds sets
whose members only read local files. All three behaviors depend on that
property.

The list is explicit for a safety reason. The GitHub review effects all share
`@always(owner, repo)`, so a rule that gave a set-wide answer to any set with
a uniform scope would let one answer to a review comment also approve
`std::github::prApprove`. In the same way, a folder picker on `std::remove`
would let one keystroke approve removals across a much larger folder than the
interrupt named.

For an effect in no listed set, `ap` behaves as it does today: it saves a rule
for the exact scope in the interrupt, with no further question.

### `as`: one answer for a whole effect set

`as` is offered when all of these hold:

1. The interrupt does not expect a value (the same rule as `aa`, `ap`, `rr`).
2. `ap` is offered, meaning the scoped match is not empty.
3. The effect is a member of a listed set.
4. No member of that set has a scope that differs from this effect's scope.
   A member's scope is resolved the way `scopedFieldsFor` resolves it: the
   caller's `fields:` override when there is one, and the registry otherwise.

Condition 4 means a caller's override is respected for every member. If a
caller passes `fields: { "std::read": [] }`, then `std::read` has an empty
scope, it differs from `std::ls`, and `as` is not offered at an `ls` prompt.

The registry only knows effects whose module has been imported. A member with
no override and no registered scope is assumed to agree. A unit test (Task 2)
reads the stdlib source and fails if a listed set's members do not all declare
the same scope.

Choosing `as` saves the same rule once under each member of the set, with one
exception: a member whose policy already rejects this interrupt is skipped.
Suppose the person earlier answered `rr` for `std::glob`. A new approve rule
under `std::glob` would come first and override that. The check is
`checkPolicy` on a copy of the interrupt carrying that member's effect.

### The folder step

After `ap` or `as` on an effect in a listed set, when the scope has exactly
one `@alwaysUnder` field, the prompt asks which folder:

```
──────────────────────────────────────────────────────────────────────────
 Always approve FileRead in which folder? Folders inside it are included.
 FileRead: std::read, std::readBinary, std::ls, std::grep, std::vision
 1    /Users/me/proj/.worktrees/agent-prompt-cleanup/packages/agency-lang/.agency-build/prompt-cleanup
 2    /Users/me/proj/.worktrees/agent-prompt-cleanup/packages/agency-lang/.agency-build
 3    /Users/me/proj/.worktrees/agent-prompt-cleanup/packages/agency-lang
 4    /Users/me/proj/.worktrees/agent-prompt-cleanup/packages
 5    /Users/me/proj/.worktrees/agent-prompt-cleanup
 6    /Users/me/proj/.worktrees
 7    /Users/me/proj                 the launch directory
 b    back
 > ▏
```

- For `ap` the title names the effect, `Always approve std::ls in which
  folder? Folders inside it are included.`, and there is no members line.
- The members line lists the members a rule will be saved for. In the example
  `std::glob` is absent because the policy already rejects it.
- The list is the folder from the interrupt, then each parent, nearest first.
- **The home directory is never offered**, and neither is any folder above it
  or the filesystem root. The reason is in `lib/runtime/builtinPolicies.ts:40`:
  the agent home holds earlier conversations, and `recommended` also approves
  web searches, so a read grant over the home directory would let injected
  text search old conversations and send what it finds out in a query. The
  same grant would cover `~/.ssh` and `~/.aws`.
- The list stops at the launch directory when the folder is inside it. The
  launch directory is included and labelled, unless it is the home directory
  or above it.
- At most 8 folders are listed (`MAX_FOLDER_CHOICES`): the nearest 7 and the
  outermost one.
- `b` returns to the first prompt. Free text is not accepted here.
- The step appears even when the list has one entry. For `as` it is also where
  the person sees which effects the answer covers.

The chosen folder replaces the field's value in a copy of the interrupt, and
the rule is built from that copy.

### Dot folders

A new optional field on a policy rule, `matchDotFolders`, makes that rule's
globs match dot-led path segments:

```json
{ "match": { "dir": "{/Users/me/proj/.worktrees,/Users/me/proj/.worktrees/**}" },
  "action": "approve",
  "matchDotFolders": true }
```

The prompt sets it on a rule it generates for an effect in a listed set whose
scope has an `@alwaysUnder` field. This applies to `ap` and to `as`.

Nothing else sets it. Hand-written rules, the built-in policies, and the
exported `recordScopedRule` are unchanged. An older Agency version that reads
a policy file with the field ignores it, because the rule schema drops unknown
keys. Its rules then match fewer interrupts than intended and approve nothing
they would not have approved before.

## Decisions for the owner to confirm

1. **Dot folders use a new rule field.** This changes the policy format, which
   every Agency program shares. As "What the dot-folder rule does and does not
   protect" explains, the protection it relaxes is already incomplete, and it
   is relaxed only for read rules the prompt generates. The alternative is to
   drop Task 1, in which case a grant for `.worktrees` still prompts for a dot
   folder below it.
2. **The folder step and `as` apply only to effects in `FileRead`.** `ap` on
   `std::write`, `std::remove`, `std::git::*`, and every other effect stays as
   it is today.
3. **The home directory is never offered** in the folder list.
4. **Grants are saved to the policy file**, the same as `ap` today. There is
   no session-only grant in this plan.
5. **`ap` on a `FileRead` effect now takes one more answer** (`1`, Enter),
   because the folder step always appears.
6. **The new key is `as`** ("s" for set), and the `Decision` type gains
   `"approve-always-set"`. The value `"approve-always-here"` keeps its name,
   since programs may match on it.
7. **`recordScopedRule` is unchanged.** Programs that build their own approval
   UI with it get the same rules as before.
8. **The guide pages in `docs/site/guide/` are not edited.** If the owner
   wants `matchDotFolders` in `policies.md`, that is a hand edit for the owner.

## Global constraints

- Types, not interfaces. Objects, not maps. Arrays, not sets. No dynamic
  imports.
- Colors come from the helpers `lib/stdlib/cli.ts` already uses (`color`,
  `DIM`, `COLOR_RESET`). Do not write raw escape codes.
- Files in `lib/runtime/` import `path` from `#path`, as
  `lib/runtime/agentHome.ts` does. The browser bundle reaches them.
- Do not run `agency fmt` on an existing `.agency` file. Run it only on files
  this plan adds.
- Run `pnpm run fmt:ts` on the named TypeScript files only, from the worktree.
- Docstrings in `stdlib/policy.agency` are user-facing reference text. Keep
  them accurate when a signature changes.
- Never edit `docs/site/stdlib/*.md` or `docs/site/diagnostics/*.md` by hand.
  `make` regenerates them.
- Read `docs/dev/contributing/anti-patterns.md` and
  `docs/dev/contributing/coding-standards.md` before writing code.
- A rule with an empty `match` approves every interrupt of its effect. Every
  code path that writes a scoped rule must refuse to write one when the match
  is empty.
- **Nothing here may make a broad delete or write approval easier.** No answer
  this plan adds may save a rule for an effect outside a listed set, so
  `std::remove`, `std::write`, and `std::move` get no `as` and no folder step.
  `folderChoices` must never return the home directory, a folder above it, or
  the filesystem root.
- **Wording.** Prose that says "approve always here" changes to "always
  approve when". Text that refers to the value `"approve-always-here"` or the
  key `ap` keeps them.

## Review focus

Each line names a case no task's main test covers. The owning task has a test
for it.

1. A caller's `fields:` override for a different member of the set than the
   one being prompted. `as` must not be offered. (Task 4)
2. A folder path containing glob characters, such as `/tmp/a{b}/c*`. The saved
   rule must match that folder only. (Task 4)
3. A member the policy already rejects. `as` must not save a rule under it.
   (Task 4)
4. A terminal 60 columns wide with a long path in the detail column. Every
   character of the path must be shown. (Task 3)
5. An interrupt that expects a value. It must still get only `a` and `r`, and
   a typed `as` must be read as the user's answer text. (Task 4)
6. An escape sequence in a `dir` value. It must not reach the terminal through
   the detail column or the folder list. (Task 4)

## File map

| File | Change |
|---|---|
| `lib/runtime/policy.ts` | `matchDotFolders` on the rule schema and in the matcher |
| `lib/runtime/policyUpdate.ts` | `sameRule` compares `matchDotFolders`; new `prependPolicyRule` |
| `lib/runtime/alwaysChoices.ts` | New. The pure helpers and `SHARED_APPROVAL_SETS` |
| `lib/runtime/alwaysChoices.test.ts` | New |
| `lib/typeChecker/alwaysTag.stdlib.test.ts` | One new `it` block for listed sets |
| `lib/stdlib/policy.ts` | Bridges for the helpers |
| `lib/stdlib/cli.ts` | One answer per line, colors, detail column |
| `stdlib/ui/cli.agency` | `ChoiceItem` gains `detail` and `tone`; `interruptChoice` shows details off the footer path |
| `stdlib/policy.agency` | `PolicyRule` type, new labels, `as`, the folder step, recording |
| `tests/agency/policy-ask-value-interrupt/main.agency` | New key order, and three new cases |
| `tests/agency-js/cli-policy-handler-set/` | New end-to-end test |
| Docs and comments | Listed in Task 5 |

---

### Task 1: `matchDotFolders` on a policy rule, and `prependPolicyRule`

**Files:**
- Modify: `lib/runtime/policy.ts` (schema at line 4, `matchesGlob` and `matchesRule` near line 195)
- Modify: `lib/runtime/policyUpdate.ts` (`sameRule`, line 15)
- Modify: `stdlib/policy.agency` (`PolicyRule` type, line 92)
- Modify: `lib/stdlib/policy.ts` (one bridge)
- Test: `lib/runtime/policy.test.ts`, `lib/runtime/policyUpdate.test.ts`

**Interfaces:**
- Produces: `PolicyRule` has `matchDotFolders?: boolean`, in the zod schema and
  in the Agency type.
- Produces, in `lib/runtime/policyUpdate.ts`, beside `appendPolicyRules`:

```ts
/** `policy` with `rule` put first under each of `effects`. An effect whose
 *  first rule is already the same rule is left as it is. */
export function prependPolicyRule(policy: Policy, effects: string[], rule: PolicyRule): Policy;
```

  It uses the file's existing `sameRule`, so "the same rule" keeps one
  definition. The case it handles is the same answer given twice, for example
  `as` for a folder at a `read` prompt and again at an `ls` prompt elsewhere
  in that folder before the first was saved. `lib/stdlib/policy.ts` exports it
  to Agency as `_prependPolicyRule`.

- [ ] **Step 1: Write the tests**

In `lib/runtime/policy.test.ts`, following the file's existing helpers for
building an interrupt and `PolicyDirs`:

```ts
describe("matchDotFolders", () => {
  const rule = (extra: object) => ({
    "std::read": [{ match: { dir: "{/p/.w,/p/.w/**}" }, action: "approve" as const, ...extra }],
  });

  it("is off by default, so ** stops at a dot folder", () => {
    expect(check(rule({}), "std::read", { dir: "/p/.w/a/.build/x" }).type).toBe("propagate");
  });

  it("lets ** enter dot folders when set", () => {
    const policy = rule({ matchDotFolders: true });
    expect(check(policy, "std::read", { dir: "/p/.w/a/.build/x" }).type).toBe("approve");
    expect(check(policy, "std::read", { dir: "/p/.w" }).type).toBe("approve");
  });

  it("does not widen the rule sideways", () => {
    const policy = rule({ matchDotFolders: true });
    expect(check(policy, "std::read", { dir: "/p/.wx/a" }).type).toBe("propagate");
    expect(check(policy, "std::read", { dir: "/p" }).type).toBe("propagate");
  });

  it("is accepted by validatePolicy as a boolean and refused as a string", () => {
    expect(validatePolicy(rule({ matchDotFolders: true })).success).toBe(true);
    expect(validatePolicy(rule({ matchDotFolders: "yes" })).success).toBe(false);
  });
});
```

`check` stands for whatever helper the file already uses to call
`checkPolicy`. If there is none, call `checkPolicy(policy, { effect, message:
"", data, origin: "" }, dirs)` directly.

In `lib/runtime/policyUpdate.test.ts`:

- Two rules that differ only in `matchDotFolders` are not the same rule, so
  `missingPolicyRules` reports the one the saved policy lacks.
- `prependPolicyRule` puts the rule first under each named effect, keeps the
  rules already there after it, creates the list for an effect the policy does
  not mention, and does not change the input policy.
- Called twice with the same rule, it leaves one copy.
- With an empty effect list it returns a policy equal to the input.

- [ ] **Step 2: Implement**

- Add `matchDotFolders: z.boolean().optional()` to `PolicyRuleSchema`.
- `matchesGlob(value, pattern, dot)` passes `{ dot }` to `picomatch.isMatch`.
  `matchesRule` passes `rule.matchDotFolders === true` on all three attempts
  (raw, via `.`, via placeholders).
- `sameRule` also compares `(a.matchDotFolders === true) === (b.matchDotFolders === true)`.
- Add `prependPolicyRule` and its bridge.
- Add `matchDotFolders?: boolean` to the Agency `PolicyRule` type, with a doc
  comment saying what it does and that a rule without it leaves dot folders
  out. The generated stdlib reference shows this type.

- [ ] **Step 3: Typecheck**

Run: `pnpm run typecheck`. Expected: no errors.

- [ ] **Step 4: Commit** (`policy: a rule can opt in to matching dot folders`)

---

### Task 2: The helpers in `lib/runtime/alwaysChoices.ts`

**Files:**
- Create: `lib/runtime/alwaysChoices.ts`
- Create: `lib/runtime/alwaysChoices.test.ts`
- Modify: `lib/typeChecker/alwaysTag.stdlib.test.ts`
- Modify: `lib/stdlib/policy.ts` (bridges)

**Interfaces:**
- Consumes: `ScopedField`, `sameScopedFields`, `allAlwaysScopes` from
  `lib/runtime/alwaysScope.ts`; `EffectSetInfo`, `builtinEffectSets` from
  `lib/runtime/effectSets.ts`.
- Produces:

```ts
/** Effect sets whose members only read local files. An effect in one of
 *  them gets the set-wide answer, the folder step, and generated rules that
 *  match dot folders. Check a new entry against all three. */
export const SHARED_APPROVAL_SETS: string[] = ["FileRead"];

/** How many folders the folder step lists at most. */
export const MAX_FOLDER_CHOICES = 8;

/** "dir = /x and below, method = GET". Called only when every field is in
 *  `data`: the prompt offers a scoped answer only then. */
export function describeScope(fields: ScopedField[], data: Record<string, unknown>): string;

export type FolderChoice = { path: string; note: string };

/** `value`, then each parent, nearest first. See "The folder step". */
export function folderChoices(value: string, dirs: { cwd: string; home: string }): FolderChoice[];

/** Each effect's scope: the override when there is one, else the registry's. */
export function resolvedScopes(
  registered: Record<string, ScopedField[]>,
  overrides: Record<string, ScopedField[]>,
): Record<string, ScopedField[]>;

/** The listed set `effect` belongs to whose members all share `effect`'s
 *  scope, or null. A member absent from `scopes` is taken to agree. */
export function sharedApprovalSet(
  effect: string,
  scopes: Record<string, ScopedField[]>,
  sets: Record<string, EffectSetInfo>,
): EffectSetInfo | null;

/** True when `effect` is in a listed set. */
export function inSharedApprovalSet(effect: string, sets: Record<string, EffectSetInfo>): boolean;
```

Bridges in `lib/stdlib/policy.ts`:

- `_describeScope(fields, data)`
- `_folderChoices(value)`, which fills in the run's policy directories.
  `_checkPolicy` in the same file shows how a bridge gets them.
- `_sharedApprovalSet(effect, overrides)`, which passes
  `resolvedScopes(allAlwaysScopes(), overrides)` and `builtinEffectSets()`. It
  returns `{ name: string; members: string[] }`, with an empty name and an
  empty list when no set applies.
- `_inSharedApprovalSet(effect)`

The Agency side passes `globalCliPolicyOpts.fields` as `overrides`.

- [ ] **Step 1: Write `lib/runtime/alwaysChoices.test.ts`**

```ts
const under = (field: string) => ({ field, matchSubpaths: true });
const exact = (field: string) => ({ field, matchSubpaths: false });

describe("describeScope", () => {
  it("prints an exact field", () => {
    expect(describeScope([exact("name")], { name: "HOME" })).toBe("name = HOME");
  });
  it("prints a subpath field with 'and below'", () => {
    expect(describeScope([under("dir")], { dir: "/x/y" })).toBe("dir = /x/y and below");
  });
  it("joins several fields with a comma", () => {
    const data = { method: "GET", baseUrl: "https://a.b" };
    expect(describeScope([exact("method"), exact("baseUrl")], data))
      .toBe("method = GET, baseUrl = https://a.b");
  });
});

describe("folderChoices", () => {
  const dirs = { cwd: "/Users/me/proj", home: "/Users/me" };
  const paths = (value: string, where = dirs) => folderChoices(value, where).map((c) => c.path);

  it("stops at the launch directory for a folder inside it", () => {
    expect(folderChoices("/Users/me/proj/.w/a", dirs)).toEqual([
      { path: "/Users/me/proj/.w/a", note: "" },
      { path: "/Users/me/proj/.w", note: "" },
      { path: "/Users/me/proj", note: "the launch directory" },
    ]);
  });
  it("never offers the home directory", () => {
    expect(paths("/Users/me/bench/jobs")).toEqual(["/Users/me/bench/jobs", "/Users/me/bench"]);
  });
  it("never offers a folder above home, or the root", () => {
    expect(paths("/Users/other/x")).toEqual(["/Users/other/x", "/Users/other"]);
    expect(paths("/etc/ssh/keys")).toEqual(["/etc/ssh/keys", "/etc/ssh", "/etc"]);
    expect(paths("/etc")).toEqual(["/etc"]);
  });
  it("compares whole path segments", () => {
    // proj2 is not inside proj, so the list does not stop at /Users/me/proj.
    expect(paths("/Users/me/proj2/x")).toEqual(["/Users/me/proj2/x", "/Users/me/proj2"]);
  });
  it("does not offer the launch directory when it is the home directory", () => {
    const atHome = { cwd: "/Users/me", home: "/Users/me" };
    expect(paths("/Users/me/a/b", atHome)).toEqual(["/Users/me/a/b", "/Users/me/a"]);
  });
  it("returns the folder alone when it is the launch directory", () => {
    expect(folderChoices("/Users/me/proj", dirs)).toEqual([
      { path: "/Users/me/proj", note: "the launch directory" },
    ]);
  });
  it("returns a value that is not an absolute path alone", () => {
    expect(paths("")).toEqual([""]);
    expect(paths("sub/dir")).toEqual(["sub/dir"]);
  });
  it("keeps the nearest folders and the outermost one when there are too many", () => {
    const deep = "/Users/me/proj/a/b/c/d/e/f/g/h/i";
    const choices = folderChoices(deep, dirs);
    expect(choices).toHaveLength(MAX_FOLDER_CHOICES);
    expect(choices[0].path).toBe(deep);
    expect(choices[6].path).toBe("/Users/me/proj/a/b/c");
    expect(choices[7].path).toBe("/Users/me/proj");
  });
});

describe("sharedApprovalSet", () => {
  const sets = {
    FileRead: { name: "FileRead", doc: "", members: ["std::read", "std::ls", "std::vision"], composedOf: [] },
    Other: { name: "Other", doc: "", members: ["std::read", "x::y"], composedOf: [] },
  };
  it("returns the listed set when every known member shares the scope", () => {
    const scopes = { "std::read": [under("dir")], "std::ls": [under("dir")] };
    expect(sharedApprovalSet("std::ls", scopes, sets)?.name).toBe("FileRead");
  });
  it("returns null when a member's scope differs", () => {
    const scopes = { "std::read": [exact("dir")], "std::ls": [under("dir")] };
    expect(sharedApprovalSet("std::ls", scopes, sets)).toBeNull();
  });
  it("returns null when a member's scope was overridden to empty", () => {
    const registered = { "std::read": [under("dir")], "std::ls": [under("dir")] };
    const scopes = resolvedScopes(registered, { "std::read": [] });
    expect(sharedApprovalSet("std::ls", scopes, sets)).toBeNull();
  });
  it("returns null for an effect in no listed set", () => {
    expect(sharedApprovalSet("x::y", { "x::y": [exact("a")] }, sets)).toBeNull();
  });
  it("returns null for an effect with no scope", () => {
    expect(sharedApprovalSet("std::ls", {}, sets)).toBeNull();
  });
});

describe("resolvedScopes", () => {
  it("lets an override replace a registered scope, an empty one included", () => {
    const registered = { "a::b": [under("dir")], "c::d": [exact("x")] };
    expect(resolvedScopes(registered, { "a::b": [] })).toEqual({ "a::b": [], "c::d": [exact("x")] });
  });
});
```

`resolvedScopes` must keep an overridden effect present with its empty list.
`sharedApprovalSet` treats an effect absent from the record as agreeing, and
an effect present with a different scope, the empty one included, as
disagreeing.

- [ ] **Step 2: Add one `it` block to `lib/typeChecker/alwaysTag.stdlib.test.ts`**

That file already loads every stdlib effect declaration with its tags, and
holds a decision table with one row per effect. Its loader is not exported, so
the check goes in the same file. For each name in `SHARED_APPROVAL_SETS`,
assert that the set exists in `builtinEffectSets()`, that every member has a
row, and that every member's scope equals the first member's. The failure
message names the member and both scopes.

This test must fail if someone tags `std::vision` differently from `std::read`.
Check that by editing a tag locally, seeing the failure, and reverting.

- [ ] **Step 3: Implement the helpers and the bridges**

`folderChoices` works on path strings and reads no file. The note is exactly
`"the launch directory"`. No helper in the codebase lists a path's parents.
The nearest one, `repositoryAncestors` in `lib/stdlib/gitignore.ts`, reads the
disk for `.git` entries and stops at a repository root, so it does not fit.

- [ ] **Step 4: Typecheck.** Run: `pnpm run typecheck`.

- [ ] **Step 5: Commit** (`policy: helpers for the prompt's broader answers`)

---

### Task 3: Draw one answer per line

**Files:**
- Modify: `lib/stdlib/cli.ts` (`packOptions` line 523, `InterruptFooterInput`
  line 553, `renderInterruptFooter` line 601, `InterruptOpts` line 628,
  `_interruptChoice` line 743, the `_internal` export near line 1851)
- Modify: `stdlib/ui/cli.agency` (`ChoiceItem` line 150, `interruptChoice` line 378)
- Test: `lib/stdlib/cli.test.ts` (`packOptions` block line 684,
  `renderInterruptFooter` block line 709)

**Interfaces:**
- Produces, in TypeScript:

```ts
type InterruptItem = {
  key: string;
  label: string;
  /** Dim text in the third column: what the answer covers. */
  detail?: string;
  /** Colors the key: green for approve, red for reject, bold alone otherwise. */
  tone?: "approve" | "reject";
};

/** One or more lines per item. Pure. */
function optionRows(items: InterruptItem[], width: number): string[];
```

- Produces, in Agency:

```ts
export type ChoiceItem = {
  key: string;
  label: string;
  detail?: string;
  tone?: "approve" | "reject"
}
```

Other users of `ChoiceItem` (`chooseOption`, the model picker) pass neither
new field and are unaffected.

- [ ] **Step 1: Replace the `packOptions` tests with `optionRows` tests**

Strip color codes before comparing layout.

```ts
const items = [
  { key: "a", label: "approve once", tone: "approve" as const },
  { key: "aa", label: "always approve", detail: "every std::ls", tone: "approve" as const },
  { key: "ap", label: "always approve when", detail: "dir = /x and below", tone: "approve" as const },
  { key: "r", label: "reject once", tone: "reject" as const },
];

it("puts each item on its own line with aligned columns", () => {
  expect(plain(_internal.optionRows(items, 80))).toEqual([
    "a    approve once",
    "aa   always approve        every std::ls",
    "ap   always approve when   dir = /x and below",
    "r    reject once",
  ]);
});

it("wraps a detail that does not fit, indented under the label", () => {
  const path = "/long".repeat(30);
  const long = [{ key: "ap", label: "always approve when", detail: `dir = ${path} and below` }];
  const rows = plain(_internal.optionRows(long, 60));
  expect(rows[0]).toBe("ap   always approve when");
  expect(rows.length).toBeGreaterThan(2);
  rows.slice(1).forEach((row) => {
    expect(row.startsWith("     ")).toBe(true);
    expect(row.length).toBeLessThanOrEqual(60);
  });
  // Nothing is cut: the wrapped lines hold the whole detail.
  const joined = rows.slice(1).map((row) => row.trim()).join("");
  expect(joined.replace(/\s/g, "")).toBe(`dir = ${path} and below`.replace(/\s/g, ""));
});

it("colors an approving key green and a rejecting key red", () => {
  const rows = _internal.optionRows(items, 80);
  expect(rows[0]).toContain(color.green("a"));   // match the helper cli.ts uses, bold included
  expect(rows[3]).toContain(color.red("r"));
});

it("prints an item with no tone and no detail as key and label", () => {
  expect(plain(_internal.optionRows([{ key: "v", label: "view it all" }], 80))).toEqual(["v    view it all"]);
});
```

The key column is the longest key plus a gap. The label column is the longest
label among items that have a detail, plus a gap. Trailing spaces are trimmed.

Update the `renderInterruptFooter` tests that assert on the packed option
line.

- [ ] **Step 2: Implement `optionRows` and use it in `renderInterruptFooter`**

Delete `packOptions`. A detail that fits beside its label stays on that line.
One that does not is wrapped by `optionRows` itself, with `wrapText`, onto
lines indented to the label column. Do not leave the wrapping to `buildFrame`:
it wraps at the left edge and would lose the indent.

The appended view item (`VIEW_KEY`) has no tone. Map a tone to its color with
one small table (`approve` to green, `reject` to red), and name the two column
gaps as constants. Pass `detail` and `tone` through `InterruptOpts`,
`_interruptChoice`, and the `__agencyInterruptPrompt` hook. The keys
`validKeys` reads are unchanged.

- [ ] **Step 3: `stdlib/ui/cli.agency`**

Add the two fields to `ChoiceItem`. Then, in `interruptChoice`, on the branch
that calls `chooseOption`:

- Pass items whose label is `"${label} (${detail})"` when the item has a
  detail.
- When stdout is not a terminal (`_isTTY()` is false), append one line per
  item to the body, as `"${key}  ${label}"` using the folded label.

Put the folding in one small function. The footer branch passes the items
through unchanged.

Before relying on the body change, search `tests/` for fixtures that assert on
a prompt's printed body, and update the ones that go through
`interruptChoice`.

- [ ] **Step 4: Typecheck.** Run: `pnpm run typecheck`.

- [ ] **Step 5: Commit** (`cli: approval prompt shows one answer per line`)

---

### Task 4: New answers, the folder step, and recording, in `stdlib/policy.agency`

**Files:**
- Modify: `stdlib/policy.agency`
  - `Decision` type (line 142)
  - `describeScopedMatch` (line 616)
  - `AskUserResult` (line 637)
  - `askUserChoices` (line 920)
  - `askUser` (line 965)
  - `recordAnswer` (line 1030)
  - `choiceResult` (line 1052)
  - the handler's use of the answer near line 1211
- Modify: `tests/agency/policy-ask-value-interrupt/main.agency`
- Modify: `lib/agents/agency-agent/tests/envPolicy.agency` and its `.test.json`
- Modify: `tests/agency-js/cli-policy-handler/`
- Create: `tests/agency-js/cli-policy-handler-set/`

**Interfaces:**
- Consumes: the bridges from Task 2; `_prependPolicyRule` and
  `matchDotFolders` from Task 1; `ChoiceItem` with `detail` and `tone` from
  Task 3.
- Produces:

```ts
export type Decision =
  | "approve"
  | "reject"
  | "approve-always"
  | "approve-always-here"
  | "approve-always-set"
  | "reject-always"

type AskUserResult = {
  action: Decision;
  reason?: string;
  rule?: any;
  /** The folder chosen at the folder step. Empty when the step did not run. */
  folder?: string
}
```

`recordScopedRule` is exported and stays exactly as it is.

**One table of answers.** Today each answer is spelled out in three places:
`askUserChoices` (key and label), `choiceResult` (key to `Decision`), and the
handler's approve check near line 1211. Before adding `as`, move what the
three share into one table at the top of the prompt code:

```ts
type AnswerRow = {
  key: string;
  action: Decision;
  tone: "approve" | "reject";
  /** True for an answer that saves a rule. Withheld from a raise that expects a value. */
  saves: boolean
}

static const ANSWERS: AnswerRow[] = [
  { key: "a", action: "approve", tone: "approve", saves: false },
  { key: "aa", action: "approve-always", tone: "approve", saves: true },
  { key: "ap", action: "approve-always-here", tone: "approve", saves: true },
  { key: "as", action: "approve-always-set", tone: "approve", saves: true },
  { key: "r", action: "reject", tone: "reject", saves: false },
  { key: "rr", action: "reject-always", tone: "reject", saves: true },
]
```

- `askUserChoices` walks the table in order, drops the rows that are not
  offered for this interrupt, and adds each row's label and detail.
- `choiceResult` finds the row whose key was typed and returns its `action`.
  Its `match` over the five keys goes away.
- The handler's check becomes "the answer's row has `tone: "approve"`".

A later answer is then one row, its label, and its case in `recordAnswer`.

- [ ] **Step 1: Update `tests/agency/policy-ask-value-interrupt/main.agency`**

This test calls `askUserChoices` and `choiceResult` directly, so it is the
place for everything that does not need a policy file on disk.

- The key order changes. Line 11 expects `"a,aa,ap,r,rr"`. Line 15 still
  expects `"a,r"`. Lines 20 and 25 expect `"a,aa,r,rr"`. `app::env` is in no
  listed set, so `as` does not appear.
- Add `"as"` to the loop at line 36, which checks keys typed at a question.
- Add a case with a `std::ls` interrupt (`{ effect: "std::ls", data: { dir:
  "/x/y", recursive: false, maxResults: 10 }, expectsValue: false }`). Its
  keys are `"a,aa,ap,as,r,rr"`. The `ap` item's `detail` is
  `"dir = /x/y and below"` and its label is `"always approve when"`. The `as`
  item's label is `"always approve FileRead when"`. The file must import
  something from `std::shell` so that `std::ls` and its tag are registered.
- Add a case with a `std::remove` interrupt (`{ effect: "std::remove", data:
  { target: "/x/y" }, expectsValue: false }`, with an import from `std::fs` so
  its tag is registered). Its keys are `"a,aa,ap,r,rr"`. There is no `as`.
- Add a case with an escape sequence in `dir`
  (`"/x/\u001b[2Jy"`). No item's `detail` contains `\u001b`.
- Add the override cases, installing the handler the way
  `lib/agents/agency-agent/tests/envPolicy.agency` does
  (`cliPolicyHandler(file: ..., fields: ..., policy: {})`):
  - `fields: { "std::ls": [] }`: an `ls` interrupt gets `"a,aa,r,rr"`.
  - `fields: { "std::read": [] }`: an `ls` interrupt gets `"a,aa,ap,r,rr"`.
    `ap` is offered and `as` is not.

- [ ] **Step 2: Update the other existing tests**

- `lib/agents/agency-agent/tests/envPolicy.agency` filters labels that start
  with `"approve always here"` and expects
  `"approve always here (name=BRAVE_API_KEY)"`. Change it to find the item
  with key `ap` and return its label and detail, and update the expected
  output in `envPolicy.test.json` to match (`always approve when` and
  `name = BRAVE_API_KEY`).
- `tests/agency-js/cli-policy-handler/` answers `"ap"`. If the effect it
  answers is in `FileRead`, add `"1"` after it for the folder step. Otherwise
  leave the answers alone.
- `tests/agency/safeBash.agency` and its `.test.json` contain the old phrase.
  Update any expected string that changes.
- `lib/stdlib/prompts.test.ts:86` uses the old phrase as sample data. Leave
  it.

- [ ] **Step 3: Write the end-to-end test**

Create `tests/agency-js/cli-policy-handler-set/`, modelled on
`tests/agency-js/cli-policy-handler/` (copy its `fixture.json` shape and its
way of scripting answers through `inputOverride`).

`agent.agency`:

```ts
import { cliPolicyHandler } from "std::policy"
import { ls, grep } from "std::shell"

node main(args: { policyFile: string, root: string }): string[] {
  const handler = cliPolicyHandler(file: args.policyFile)
  let outcomes: string[] = []
  handle {
    const deep = "${args.root}/.w/a/.build"
    const first = read("x.txt", dir: deep)
    outcomes.push(outcome("read", isFailure(first)))
    const second = ls("${args.root}/.w/b")
    outcomes.push(outcome("ls", isFailure(second)))
    // This grep is what shows the saved rule enters dot folders: its dir is
    // two dot folders deep and nobody is asked about it. Keep it.
    const third = grep("needle", deep)
    outcomes.push(outcome("grep", isFailure(third)))
  } with handler
  return outcomes
}

def outcome(name: string, failed: boolean): string {
  if (failed) {
    return "${name} rejected"
  }
  return "${name} ok"
}
```

Check this file parses with `pnpm run ast` before relying on it, and adjust
the calls to the real signatures of `read`, `ls`, and `grep`.

`test.js` makes a temp folder with `.w/a/.build/x.txt` (containing `needle`)
and `.w/b/`, passes its real path as `root`, and scripts these answers:

```js
// "as" at the std::read prompt, then folder 3 at the folder step.
// The folders listed are: <root>/.w/a/.build, <root>/.w/a, <root>/.w, ...
const answers = ["as", "3"];
```

It asserts:

- `outcomes` is `["read ok", "ls ok", "grep ok"]`.
- No answers remain, and the override was never called a third time. The `ls`
  and the `grep` were approved by the saved rules. The `read` was the
  interrupt the person answered, so it shows nothing about the rules.
- The saved policy file has a rule under each of `std::read`,
  `std::readBinary`, `std::ls`, `std::glob`, `std::grep`, and `std::vision`.
  Each rule has `action: "approve"`, `matchDotFolders: true`, and a `dir`
  match that is `{<root>/.w,<root>/.w/**}` with the root escaped.

Add these cases to the same test, each with its own run:

- **`ap` with a parent folder.** Answers `["ap", "2"]` at an `ls` prompt, then
  a `read` in the chosen folder, answered `"a"`. The saved policy has one
  rule, under `std::ls` only, and the `read` did prompt. That shows the `ap`
  rule stayed on one effect.
- **`b` goes back.** Answers `["as", "b", "a"]`. Nothing is saved and the
  interrupt is approved once.
- **Glob characters.** A root folder named `a{b}c*`. After `["ap", "1"]`, an
  `ls` of a sibling folder `abc` still prompts.
- **A member already rejected.** The policy file starts with
  `{ "std::glob": [{ "action": "reject" }] }`. After `["as", "1"]` the file
  has no approve rule under `std::glob`, and its reject rule is still first.

Use `safeDeleteDirectoryWithin` for cleanup if the test helpers offer it. Do
not hand-roll `rm`.

- [ ] **Step 4: The `ANSWERS` table and `askUserChoices`**

Add the table from "Interfaces" above. `askUserChoices` produces, in table
order:

| Key | Label | Detail | Offered when |
|---|---|---|---|
| `a` | `approve once` | | always |
| `aa` | `always approve` | `every <effect>` | no value expected |
| `ap` | `always approve when` | the scope in words | scoped match not empty |
| `as` | `always approve <Set> when` | the same detail as `ap` | see "`as`" in the design |
| `r` | `reject once` | | always |
| `rr` | `always reject` | `every <effect>` | no value expected |

`describeScopedMatch` now returns
`stripControlChars(_describeScope(scopedFieldsFor(...), intr.data))`. The
`every <effect>` detail goes through `stripControlChars` as well.

The set for `as` comes from `_sharedApprovalSet(intr.effect,
globalCliPolicyOpts.fields)`. An empty member list means it is not offered.

- [ ] **Step 5: `choiceResult`**

Replace the `match` over keys with a lookup in `ANSWERS`. The existing rule
stays: a key the menu did not offer is read as text.

- [ ] **Step 6: The folder step**

Put the step in its own function, so `askUser` does not grow into one long
procedure:

```ts
// The folder the user picked, or null when they went back.
def askFolder(value: string, subject: string, membersLine: string): string | null
```

`value` is the scoped field's value from the interrupt. `subject` is the
effect name for `ap` and the set name for `as`.

`askUser` calls it after the first `interruptChoice` returns `ap` or `as`,
when `_inSharedApprovalSet(intr.effect)` is true and the resolved scope has
exactly one field with `matchSubpaths`. The call is inside the same
`withLock("std::tty")` block. `askFolder` calls `interruptChoice` with:

- title: `Always approve <subject> in which folder? Folders inside it are included.`
- body: `membersLine`.
- items: one per `_folderChoices(value)` entry, with key `"1"`, `"2"`, and so
  on, the path as the label, and the note as the detail. Then
  `{ key: BACK_KEY, label: "back" }`, where `BACK_KEY` is a named constant
  holding `"b"`.
- `allowFreeText: false`, `allowCancel: true`.

`askFolder` returns the path of the item whose key was typed, found by looking
the key up in the items it built, or null for `BACK_KEY`. On null, `askUser`
shows the first prompt again. Write that as a loop, with no recursion.
Otherwise it sets `folder` on the result.

Every path and the subject go through `stripControlChars` before they are
shown. The rule is built from the value `_folderChoices` returned, and never
from the stripped text.

- [ ] **Step 7: `recordAnswer`**

Add one private function for the rules the prompt generates:

```ts
// The members of `effects` a new approve rule may be saved under: those the
// policy does not already reject for this interrupt.
def unrejectedEffects(policy: Policy, intr: any, effects: string[]): string[]

// Save one scoped approve rule under each effect, built from the interrupt
// with `folder` in place of its subpath field when one was chosen.
def recordPromptRule(policy: Policy, intr: any, effects: string[], folder: string): Policy
```

- `recordPromptRule` copies the interrupt, with the chosen folder in the
  scoped field when `folder` is not empty. It does not change `intr`, which
  the handler still uses. It builds the match with `buildScopedMatch` and
  returns the policy unchanged when the match is empty. It builds one rule,
  `{ match, action: "approve" }`, adds `matchDotFolders: true` when
  `_inSharedApprovalSet(intr.effect)` is true and the scope has a field with
  `matchSubpaths`, and hands the rule and the effects to `_prependPolicyRule`.
- `approve-always-here` calls it with `[intr.effect]`.
- `approve-always-set` calls it with
  `unrejectedEffects(rules, intr, <the set's members>)`. An empty member list
  records nothing, so no separate check for "no set" is needed.
- `askUser` uses `unrejectedEffects` for the members line too, so the line
  shows exactly the effects a rule will be saved under.
- `recordAnswer` still runs before the lock is released. That ordering is what
  lets a rule saved here answer the interrupts already waiting. See "An always
  answer covers the interrupts already waiting" in
  `docs/dev/agents/approval-policies.md`.

- [ ] **Step 8: The handler's use of the answer**

Near line 1211 the handler treats `approve-always` and `approve-always-here`
as an approval. Replace the condition with the `ANSWERS` lookup.

- [ ] **Step 9: The title color**

In `askUser`, the effect name in the title becomes cyan and bold, using the
`color` helper the file already imports.

- [ ] **Step 10: Docstrings**

Update the `Decision` comment, the `ScopedField` and `ScopedRuleFields`
comments, and the `cliPolicyHandler` docstring near line 1296 to the new
wording. Describe `as`, the folder step, and `matchDotFolders` in the module
comment near line 58.

- [ ] **Step 11: Typecheck.** Run: `pnpm run typecheck`.

- [ ] **Step 12: Commit** (`policy: set-wide answer and folder picker at the approval prompt`)

---

### Task 5: Docs and comments

Dev docs here state the mechanism and the rule. They do not tell the history
of the change.

- [ ] **Step 1: `docs/dev/agents/approval-policies.md`**

- Rename the section "What approve always here pins" to "What always approve
  when pins". Add: the detail column and `describeScope`;
  `SHARED_APPROVAL_SETS`, what it turns on, and why the list is explicit (the
  GitHub review and `std::remove` examples); `as`, how a member's scope is
  resolved through the override, and why a member the policy rejects is
  skipped; the folder step, `folderChoices`, and why the home directory is
  never offered; the stdlib test that keeps a listed set uniform.
- In "Rule matching": add `matchDotFolders` to the rule shape, say which
  generated rules set it, and say what an older Agency version does with a
  file that has it.
- Correct item 3 of "Rule matching". The sentence "This is what shields `.git`
  from broad approve rules" is wrong as written. State what is true: the dot
  rule applies to the field the glob is matched against, and a rule on `dir`
  does not look at `filename`, so `write(".git/hooks/x", dir: <project>)` is
  approved by a `dir` rule for the project. Use the example from this plan's
  background.
- In "What `recommended` lets the agent read", update the wording in the
  `std::grep` paragraph.
- In "Reading what you are approving", describe the three ways the prompt is
  drawn and how the detail reaches each one.
- Note that the folder step is a second `interruptChoice` call, so the log
  shows two prompt waits for one interrupt (`_logPromptWait`).

- [ ] **Step 2: `docs/dev/language/effect-always-tag.md`**

Update the wording, and add to "Pipeline" item 6 that the prompt also reads
the scope to build the detail column.

- [ ] **Step 3: Wording elsewhere**

Apply the wording rule from "Global constraints" to:

- `lib/typeChecker/diagnosticExplanations.ts:324`. `make` copies this text
  into `docs/site/diagnostics/effects.md`.
- Comments in `lib/runtime/alwaysScope.ts:2`, `lib/runtime/ipcChild.ts:33`,
  `lib/stdlib/system.ts:175`, `lib/runtime/builtinPolicies.ts:203`,
  `lib/typeChecker/alwaysTag.ts`, and `lib/typeChecker/alwaysTag.stdlib.test.ts:60`.
- Comments in `stdlib/system.agency` and `stdlib/github.agency`.
- `docs/dev/stdlib/github.md`, `docs/dev/stdlib/toolbox.md`,
  `docs/dev/llm/local-vision.md`.

Run `grep -rn "always here" lib stdlib docs/dev` afterwards. What is left
should be `lib/stdlib/prompts.test.ts` and references to the value
`"approve-always-here"`.

- [ ] **Step 4: The index**

The `approval-policies.md` line in `CLAUDE.md` and in the `agency-agent-docs`
skill should mention the set-wide answer, the folder step, and
`matchDotFolders`. Keep both in step.

- [ ] **Step 5: Commit** (`docs: approval prompt answers`)

---

## How to test

Make all the changes first. Then run one `make` and one test run. Do not
build or test after each task. Save every output to a file outside the
repository, so a failure can be read without running anything again.

Run `pnpm run typecheck` after each task. It is fast and is the one check
that runs per task.

From `packages/agency-lang` in the worktree, with `$S` set to a scratch
folder:

```bash
make > $S/make.log 2>&1
pnpm vitest run lib/runtime/policy.test.ts lib/runtime/policyUpdate.test.ts \
  lib/runtime/alwaysChoices.test.ts lib/typeChecker/alwaysTag.stdlib.test.ts \
  lib/stdlib/cli.test.ts > $S/unit.log 2>&1
pnpm run agency test --check-capabilities tests/agency/policy-ask-value-interrupt > $S/ask.log 2>&1
pnpm run agency test --check-capabilities lib/agents/agency-agent/tests/envPolicy.agency > $S/env.log 2>&1
pnpm run agency test js tests/agency-js/cli-policy-handler-set > $S/set.log 2>&1
pnpm run agency test js tests/agency-js/cli-policy-handler > $S/handler.log 2>&1
pnpm run lint:structure > $S/lint.log 2>&1
```

`agency test js` does not accept `--check-capabilities`. Only `agency test`
does.

Name the test files to vitest as above. A bare filter run from the main
checkout reaches every worktree. Run the agent test with `HOME` pointed at a
scratch folder.

Also run the other `tests/agency-js/cli-policy-handler-*` tests, since they
script answers at this prompt. Do not run the full Agency suite. CI runs it on
the PR.

For each new test, confirm it fails for the right reason before the code that
makes it pass exists.

### By hand

The layout and colors need a real terminal. With `HOME` pointed at a scratch
folder, so the real `~/.agency-agent` is not touched:

```bash
HOME=$S/home pnpm run agency agent
```

Ask the agent to list a folder outside the launch directory. Check:

1. Each answer is on its own line, with green approving keys and red
   rejecting keys.
2. `as` shows for `std::ls` and does not show for a `std::write` prompt.
3. `ap` on a `std::write` prompt saves at once, with no folder step.
4. `as` opens the folder step, with the `FileRead` members line. The home
   directory is not in the list.
5. After choosing a parent, a `read` and a `grep` below it, including inside a
   dot folder, run with no prompt.
6. With the terminal 60 columns wide and a long path, the path is shown whole,
   wrapped under the label.
7. With the terminal 24 rows tall, the prompt for an interrupt with a six-row
   table still shows its input line. If it does not, report it: the footer has
   no height cap today.

Do not pass `--policy approve-all` for this check. It answers every prompt and
shows nothing.

## Before opening the PR

- Read the diff against `docs/dev/contributing/anti-patterns.md`.
- Read every comment and doc line added against
  `~/.claude/skills/simplify-speech/verbal-tics.md`.
- Look for anything the diff can lose: a helper used once, a test that cannot
  fail, a comment that restates the code.
- Write the PR description to a file and pass the file to `gh`.
