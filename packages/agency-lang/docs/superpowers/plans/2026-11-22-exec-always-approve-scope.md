# Policy rules match lists, and `std::exec` asks how much of a command to approve: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A policy rule can match a list, and the "always approve when" answer on a `std::exec` question asks how much of the command and which folder the saved rule covers.

**Architecture:** The rule matcher gains one rule that depends on the shape of the value: a string pattern against a list means "every item matches", and a list pattern against a list matches by position. A third effect tag, `@alwaysPrefix`, tells the prompt to ask how many leading items of a list to pin. The prompt's single follow-up question becomes a list of steps, so `std::exec` can ask about the command and then about the folder.

**Tech stack:** TypeScript in `lib/runtime/` and `lib/typeChecker/`, Agency in `stdlib/`, vitest for unit tests, Agency execution tests in `tests/agency/`.

**Spec:** `docs/superpowers/specs/2026-11-22-exec-always-approve-scope-design.md`. Read it before starting. Read `docs/dev/agents/approval-policies.md` ("Rule matching" and "What 'always approve when' pins") and `docs/dev/language/effect-always-tag.md` as well.

All paths in this plan are relative to `packages/agency-lang`. The work is done in the worktree `.worktrees/exec-always-scope`, on the branch `adit/exec-always-scope`. It is one pull request.

## Background for someone new to this code

**The four words.** An *effect* is the name of a kind of permission, such as `std::exec`. An *interrupt* is one raise of an effect, with data: for `std::exec`, the program, its arguments, and its folder. A *policy* is a JSON object that maps each effect to a list of rules. A *rule* has an optional `match`, which names data fields and a pattern for each, and an `action`: approve, reject, or propagate (ask a person).

**How a rule matches today.** `matchesRule` in `lib/runtime/policy.ts` walks the entries of `rule.match`. For each, it reads the field from the interrupt's data, turns it into a string, and tests it against the pattern with picomatch, a glob library. A list in the data becomes text joined with commas. That is the thing Task 1 replaces.

**How "always approve when" works today.** Each effect declares, with tags above its declaration, which fields a saved rule pins: `@always(name)` pins the exact value, and `@alwaysUnder(dir)` pins a folder and everything below it. `lib/typeChecker/alwaysTag.ts` reads the tags. Codegen emits one `__registerAlwaysScope(...)` call per tagged effect, and `lib/runtime/alwaysScope.ts` holds the result as a list of `ScopedField` values. When a person picks "always approve when", `buildScopedMatch` in `lib/runtime/interruptPromptOptions.ts` turns the interrupt's data and the scope into a rule's `match`.

**The follow-up question today.** For effects that read files, the prompt asks a second question: "Which folder should this cover?". `folderChoices` in `lib/runtime/alwaysChoices.ts` lists the folders. A `PromptOption` carries them in `scopes`, and `resolvePromptOption` takes the one picked as `scope`. The terminal prompt in `stdlib/policy.agency` asks the question in `askFolder`.

**Two prompts share this code.** The terminal menu in `stdlib/policy.agency` calls into `lib/runtime/interruptPromptOptions.ts` through the bridge `lib/stdlib/policy.ts`. A front-end written in TypeScript calls `promptOptions` and `resolvePromptOption` directly; they are exported from `lib/runtime/portable.ts`. Both must save the same rule for the same answer, which is why the decisions live in `lib/runtime/`.

## Global constraints

- Older policy files need not keep working. The owner is the only user. Do not write migration code.
- A rule change must hold for every effect. No operator, key, or branch that names `std::exec` goes into the matcher.
- A new `std::exec` rule is never broader than the program and its first argument, which is today's rule.
- No rule is ever saved with an empty `match`. An empty `match` approves every interrupt of the effect.
- Argument text comes from the model. Every argument is passed through `escapeGlob` before it is saved and through `stripControlChars` before it is shown.
- No raise is added, removed, or moved. Handlers are untouched.
- Use objects, not maps. Use arrays, not sets. Use types, not interfaces. No dynamic imports.
- Run `pnpm run typecheck` after each task. Run vitest only on the files a task names, from inside the worktree, and save the output to a file. Do not run the full Agency test suite locally.
- Never amend a commit and never force push. Write each commit message in a file and use `git commit -F`.
- Do not edit `CHANGELOG.md`. The changelog note goes in the pull request description.
- Do not hand-edit `docs/site/`. `make` regenerates it.

## Review focus

These are the inputs most likely to hurt a person using this, and the task that tests each.

1. **A `git add` of everything, against a rule written for `src/**`.** Its `paths` is an empty list. It must ask. (Task 1)
2. **An argument that is `**`, holds `*`, `{`, or a comma, or starts with `./`.** Saved as a literal, it must match only itself and must never mean "the rest". (Tasks 1 and 3)
6. **A very long argument,** such as a forty-line inline script. It must not save a pattern the glob library throws on. (Tasks 1 and 3)
7. **A wider pick made under the agent,** where answers are replayed into the policy file. The file must get the rule the person picked. (Task 5)
3. **A pick a front-end sends that was not offered,** such as a prefix of zero arguments or a folder outside the list. It must be refused, or it saves a rule broader than anything shown. (Task 4)
4. **A command with no arguments, and one whose `args` field is missing.** The first saves an exact rule for the bare program. The second saves no rule. (Task 3)
5. **A command run in a dot folder such as `.worktrees/x`,** under a rule saved for the launch directory. It must be approved. (Task 7)

---

### Task 1: The matcher matches lists

**Files:**
- Modify: `lib/runtime/policy.ts`
- Modify: `lib/runtime/policyUpdate.ts` (`sameMatch`)
- Modify: `lib/serve/policyStore.ts` (the check near line 51)
- Modify: `stdlib/policy.agency` (the alias `InterruptDataVal` near line 95, and the `PolicyRule` doc comment near line 120)
- Test: `lib/runtime/policy.test.ts`, `lib/runtime/policyUpdate.test.ts`, and the existing test file for `policyStore.ts`

**Interfaces:**
- Produces, in `lib/runtime/policy.ts`: `export type MatchPattern = string | string[]`, `export const REST_OF_LIST = "**"`, and `export const MAX_PATTERN_LENGTH = 65536`. `PolicyRule["match"]` becomes `Record<string, MatchPattern>`.

The rule, from the spec:

| The value | The pattern | It matches when |
| --- | --- | --- |
| a string, number, or boolean | a string | today's behaviour, unchanged |
| a list | a string | the list is not empty, and the glob matches every item |
| a list | a list | by position; a last item equal to `REST_OF_LIST` matches any items after it, or none |
| anything else | anything else | never |

- [ ] **Step 1: Write the failing tests** in `lib/runtime/policy.test.ts`, in a new `describe("list fields")`. Each calls `checkPolicy` with a one-rule policy and asserts `approve` or `propagate`.

```ts
const exec = (args: unknown) => ({
  effect: "std::exec", message: "", origin: "", data: { command: "pnpm", args },
});
const rule = (args: string | string[]): Policy => ({
  "std::exec": [{ match: { command: "pnpm", args }, action: "approve" }],
});

// by position
expect(checkPolicy(rule(["run", "build"]), exec(["run", "build"]), DIRS).type).toBe("approve");
expect(checkPolicy(rule(["run", "build"]), exec(["run", "build", "-w"]), DIRS).type).toBe("propagate");
expect(checkPolicy(rule(["run", "build"]), exec(["run"]), DIRS).type).toBe("propagate");
// the rest
expect(checkPolicy(rule(["run", "**"]), exec(["run"]), DIRS).type).toBe("approve");
expect(checkPolicy(rule(["run", "**"]), exec(["run", "a", "b/c"]), DIRS).type).toBe("approve");
expect(checkPolicy(rule(["run", "**"]), exec(["test"]), DIRS).type).toBe("propagate");
// `**` away from the last place is an ordinary glob: one item, any text
expect(checkPolicy(rule(["**", "build"]), exec(["run", "build"]), DIRS).type).toBe("approve");
expect(checkPolicy(rule(["**", "build"]), exec(["a", "b", "build"]), DIRS).type).toBe("propagate");
// a literal star, and a literal `**`, as escapeGlob writes them
expect(checkPolicy(rule([escapeGlob("*")]), exec(["anything"]), DIRS).type).toBe("propagate");
expect(checkPolicy(rule([escapeGlob("*")]), exec(["*"]), DIRS).type).toBe("approve");
expect(checkPolicy(rule([escapeGlob("**")]), exec(["a", "b"]), DIRS).type).toBe("propagate");
// a string pattern means every item
expect(checkPolicy(rule("src/**"), exec(["src/a.ts", "src/b/c.ts"]), DIRS).type).toBe("approve");
expect(checkPolicy(rule("src/**"), exec(["src/a.ts", "lib/b.ts"]), DIRS).type).toBe("propagate");
expect(checkPolicy(rule("src/**"), exec([]), DIRS).type).toBe("propagate");
// shapes that never match
expect(checkPolicy(rule(["run"]), exec("run"), DIRS).type).toBe("propagate");
expect(checkPolicy(rule(["run"]), exec(undefined), DIRS).type).toBe("propagate");
expect(checkPolicy(rule("*"), exec([{ a: 1 }]), DIRS).type).toBe("propagate");
expect(checkPolicy(rule("*"), exec({ a: 1 }), DIRS).type).toBe("propagate");
// items are compared as written, in both directions
expect(checkPolicy(rule(["x"]), exec(["./x"]), DIRS).type).toBe("propagate");
expect(checkPolicy(rule([escapeGlob("./x")]), exec(["x"]), DIRS).type).toBe("propagate");
expect(checkPolicy(rule([escapeGlob("./x")]), exec(["./x"]), DIRS).type).toBe("approve");
```

The second of those three fails with a plain glob test. picomatch drops a leading `./` from a pattern, so `picomatch.isMatch("x", "./x")` is true. Without the fix, an exact rule saved from `git checkout ./main`, which restores a file, would also approve `git checkout main`, which switches branches.

Add these as well:

- The old joined-text behaviour is gone: the rule `"a,b"` does not match `exec(["a", "b"])`.
- `validatePolicy` accepts a list in `match` and rejects a list that holds a number.
- `validatePolicy` rejects a pattern longer than `MAX_PATTERN_LENGTH`, as a string and as a list item, with a message that names the limit. picomatch throws on a longer input, and a rule that throws would break every question that reaches it.
- In the `policyStore.ts` test: `addRule` accepts a rule whose `match` holds a list.

In `lib/runtime/policyUpdate.test.ts`, add: inserting the same list-pattern rule twice leaves one copy, and two rules that differ only in a list item are both kept.

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm exec vitest run lib/runtime/policy.test.ts lib/runtime/policyUpdate.test.ts > /tmp/task1.log 2>&1; tail -30 /tmp/task1.log`

- [ ] **Step 3: Implement.**
  - The schema: a pattern is a string of at most `MAX_PATTERN_LENGTH` characters, and `match` is `z.record(z.string(), z.union([pattern, z.array(pattern)])).optional()`.
  - Split `matchesRule`'s loop body into `matchesField(key: string, pattern: MatchPattern, value: unknown, dot: boolean, dirs: PolicyDirs): boolean`. The scalar branch is today's code, moved without change, including `stripDotSlash`, the `.` rule for `dir`, and the placeholders.
  - The two list branches test each item with one helper, `matchesItem(item: string, pattern: string, dot: boolean)`. It does not substitute placeholders. For a leading `./` it does this: when the pattern starts with `./`, the item must start with it too, and then both lose it before the glob test; when the pattern does not start with `./`, an item that does never matches. That makes `./x` and `x` different in both directions.
  - `**` has its special meaning only as the last item of a list pattern. Anywhere else it is an ordinary glob and matches one item.
  - A value that is an object and not a list returns false. Today it is turned into the text `[object Object]`.
  - `sameMatch` in `policyUpdate.ts` compares a list pattern item by item.
  - `lib/serve/policyStore.ts`: delete the loop that refuses a `match` value that is not a string. The schema check a few lines below it covers the rule's shape.
  - In `stdlib/policy.agency`, widen the alias `InterruptDataVal` to `string | string[]`, so `PolicyRule` needs no inline union. The doc comment above `PolicyRule` gains two sentences on the list forms, with the `git add` example from the spec.

- [ ] **Step 4: Run the tests and `pnpm run typecheck`. Both pass.**

- [ ] **Step 5: Commit.** Message: `policy: a rule can match a list`.

---

### Task 2: The `@alwaysPrefix` tag

**Files:**
- Modify: `lib/runtime/alwaysScope.ts`
- Modify: `lib/typeChecker/alwaysTag.ts`
- Modify: `lib/typeChecker/effectPayloadCheck.ts`
- Modify: `lib/typeChecker/diagnostics.ts`, `lib/typeChecker/diagnosticExplanations.ts`
- Modify: `stdlib/policy.agency` (the Agency `ScopedField` type near line 192)
- Test: `lib/runtime/alwaysScope.test.ts`, `lib/typeChecker/alwaysTag.test.ts`

**Interfaces:**
- Produces: `export type ScopedField = { field: string; matchSubpaths: boolean; matchPrefix?: boolean }`. `matchPrefix: true` means "pin the leading items of this list, and ask how many".
- Produces: `export const ALWAYS_PREFIX_TAG = "alwaysPrefix"` in `lib/typeChecker/alwaysTag.ts`.

No effect uses the tag until Task 6.

- [ ] **Step 1: Write the failing tests.**
  - `alwaysTag.test.ts`: `@always(command)`, `@alwaysPrefix(args)`, and `@alwaysUnder(cwd)` on one declaration read as three fields, the second with `matchPrefix: true` and `matchSubpaths: false`. The tag twice gives `repeatedTag`. A field named by two tags gives `namedTwice`. A call as an argument gives `badArgument`.
  - `alwaysTag.test.ts`, through the typechecker: `@alwaysPrefix(command)` on an effect whose `command` is a `string` gives the new diagnostic `alwaysPrefixNotList`. `@alwaysPrefix(args)` on `args: string[]` gives none, and neither does a field whose type is an alias for `string[]`. A field typed `string[] | null` gives the diagnostic: a rule can pin only a list that is always there. `@alwaysPrefix(nope)` gives `alwaysUnknownField` with the tag name `alwaysPrefix`.
  - `alwaysScope.test.ts`: `sameScopedFields` treats two fields that differ only in `matchPrefix` as different. `adoptAlwaysScope` accepts a field with `matchPrefix: true`, ignores one whose `matchPrefix` is a string, and ignores one with both `matchSubpaths: true` and `matchPrefix: true`. The typechecker cannot produce that pair, but a child process can send it.

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm exec vitest run lib/runtime/alwaysScope.test.ts lib/typeChecker/alwaysTag.test.ts > /tmp/task2.log 2>&1; tail -30 /tmp/task2.log`

- [ ] **Step 3: Implement.**
  - `alwaysScope.ts`: the type, `includesField` (compare `matchPrefix === true` on both sides), and `isScopedField` (an absent `matchPrefix` or a boolean, and never both flags true).
  - `stdlib/policy.agency`: the Agency `ScopedField` type gains `matchPrefix?: boolean`, so a caller's `fields:` override can use it.
  - The check for `alwaysPrefixNotList` resolves type aliases before it looks for an array type.
  - `alwaysTag.ts`: `isAlwaysTag` and `readAlwaysScope` take the third tag as a third group, beside the exact and under groups.
  - `effectPayloadCheck.ts`: `unknownFieldDiagnostic` names the right tag for a prefix field. A new check beside `isInPayload` reports `alwaysPrefixNotList` when the field's declared type is not an array type.
  - `diagnostics.ts` and `diagnosticExplanations.ts`: the new entry, written like `alwaysUnknownField`. Message: "`@alwaysPrefix({field})` on effect `{effect}` needs a list field, and `{field}` is not one."
  - Codegen needs no change: `lib/backends/typescriptBuilder.ts` writes the fields with `JSON.stringify`, so the new flag is carried. Confirm this by reading line 701 and say so in the commit message.

- [ ] **Step 4: Run the tests and `pnpm run typecheck`. Both pass.**

- [ ] **Step 5: Commit.** Message: `effects: @alwaysPrefix pins the start of a list field`.

---

### Task 3: The choices for a list, and the rule they save

**Files:**
- Modify: `lib/runtime/alwaysChoices.ts`
- Modify: `lib/runtime/interruptPromptOptions.ts` (`buildScopedMatch`, `describeScope`'s caller)
- Modify: `stdlib/policy.agency` and `lib/stdlib/policy.ts` only where they call `buildScopedMatch`
- Test: `lib/runtime/alwaysChoices.test.ts`, `lib/runtime/interruptPromptOptions.test.ts`

**Interfaces:**
- Consumes: `ScopedField.matchPrefix` (Task 2), `REST_OF_LIST` and `escapeGlob` (Task 1).
- Produces, in `alwaysChoices.ts`:

```ts
/** How many choices the list step shows at most. */
export const MAX_PREFIX_CHOICES = 8;
/** The id of the choice that pins the whole list. */
export const EXACT_PREFIX = "exact";
/** One width a rule for a list can have. `keep` is how many leading items
 *  it pins. `rest` is true when any items may follow them. */
export type PrefixChoice = { id: string; keep: number; rest: boolean };
export function prefixChoices(itemCount: number): PrefixChoice[];
/** The pattern a choice saves: the kept items, each escaped, then
 *  REST_OF_LIST when `rest` is true. */
export function prefixPattern(items: string[], choice: PrefixChoice): string[];
```

- Produces, in `interruptPromptOptions.ts`: `buildScopedMatch(intr, context, prefix = EXACT_PREFIX): Record<string, MatchPattern>`. `prefix` is the id of a `PrefixChoice`.

`prefixChoices(n)` returns, narrowest first:

- `{ id: "exact", keep: n, rest: false }`
- then `{ id: String(k), keep: k, rest: true }` for `k` from `n` down to 1.

So `prefixChoices(0)` is one choice, `prefixChoices(1)` is two, and `prefixChoices(5)` is six. There is never a choice with `keep: 0` and `rest: true`: that would approve the program with any arguments, which is broader than today's rule. When there are more than `MAX_PREFIX_CHOICES`, keep the first seven and the last one.

- [ ] **Step 1: Write the failing tests.**
  - `alwaysChoices.test.ts`: the three counts above; the ids in order for `n = 2` are `["exact", "2", "1"]`; `prefixChoices(20)` has eight entries, the first is `exact` and the last has `keep: 1`.
  - `prefixPattern(["run", "a*b"], { id: "1", keep: 1, rest: true })` is `["run", "**"]`. With the exact choice it is `["run", "a\\*b"]`. `prefixPattern(["**"], exact)` is `["\\*\\*"]`.
  - `interruptPromptOptions.test.ts`, with a context whose registry holds `[{field:"command",matchSubpaths:false},{field:"args",matchSubpaths:false,matchPrefix:true},{field:"cwd",matchSubpaths:true}]` for a test effect:
    - `buildScopedMatch` with no third argument pins the whole list.
    - With `"1"` it gives `args: ["run", "**"]`.
    - With an id that is not a choice for this list, such as `"0"` or `"9"`, it returns `{}`.
    - With `args` missing from the data, or `args` a string, it returns `{}`.
    - With `args: []` it gives `args: []`.
    - The match for `cwd` is unchanged: `{/x,/x/**}` with the path escaped.
    - A scope with plain `@always` on a list field (`{ field: "args", matchSubpaths: false }`, no `matchPrefix`) saves the list as a list of escaped items. Today it saves the joined text `a\,b`, which after Task 1 would never match.
    - A pinned value longer than `MAX_PATTERN_LENGTH`, as a string field or as one argument, returns `{}`. "Always approve when" is then not offered for that interrupt, and "approve once" is the answer left.
  - `describeScope` for the three-field scope and `pnpm run build` in `/x` reads `command = pnpm, args = run build, cwd = /x and below`.

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm exec vitest run lib/runtime/alwaysChoices.test.ts lib/runtime/interruptPromptOptions.test.ts > /tmp/task3.log 2>&1; tail -30 /tmp/task3.log`

- [ ] **Step 3: Implement.** In `buildScopedMatch`, a field with `matchPrefix` takes the list branch: the value must be a list of strings, the choice is looked up by id in `prefixChoices(value.length)`, and a miss returns `{}` for the whole match, like a missing field does today.

An exact field whose value is a list (plain `@always` on a list) takes the same list branch with the exact choice.

`describeScope` prints a list field as its items joined with spaces: `args = run build`. It is used for the dim text beside the "always approve when" row, before any step is asked, so it describes the narrowest rule, which pins the arguments exactly.

`recordScopedRule` in `stdlib/policy.agency` calls `buildScopedMatch` with no choice, so a program with its own approval screen saves the narrowest rule. Add one sentence to its doc comment saying so.

- [ ] **Step 4: Run the tests and `pnpm run typecheck`. Both pass.**

- [ ] **Step 5: Commit.** Message: `policy: choices for how much of a list a saved rule pins`.

---

### Task 4: A prompt option carries a list of steps

**Files:**
- Modify: `lib/runtime/alwaysChoices.ts`
- Modify: `lib/runtime/interruptPromptOptions.ts`
- Modify: `lib/runtime/portable.ts` (the prompt types it exports near line 158: add `PromptStep`, `RulePicks`, and `KnownPicks`)
- Test: `lib/runtime/interruptPromptOptions.test.ts`, `lib/runtime/alwaysChoices.test.ts`, `lib/typeChecker/alwaysTag.stdlib.test.ts`

**Interfaces:**
- Consumes: `prefixChoices`, `buildScopedMatch(intr, context, prefix)` (Task 3).
- Produces, replacing `PromptOption.scopes` and the `scope` argument:

```ts
/** One follow-up question an option asks before its rule is saved. */
export type PromptStep = {
  /** Which part of the rule this step widens. */
  id: "items" | "folder";
  /** "Which commands should this cover?" */
  question: string;
  /** The choices, narrowest first. Always two or more. */
  choices: PromptScope[];
};

export type PromptOption = {
  key: string; label: string; response: "approve" | "reject"; detail?: string;
  /** The questions to ask, in order. Empty when there is nothing to choose. */
  steps: PromptStep[];
};

/** The widths of the rule an option saves. "" for a part that does not
 *  apply to this interrupt. */
export type RulePicks = { items: string; folder: string };

/** The picks that need no question. A part is null when the person must
 *  choose it. */
export type KnownPicks = { items: string | null; folder: string | null };

export function picksWithoutAsking(
  intr: Intr, decision: PromptDecision, context: PromptContext,
): KnownPicks;

export function policyAfterDecision(args: {
  policy: Policy; intr: Intr; decision: PromptDecision; picks: RulePicks; context: PromptContext;
}): Policy;

export function resolvePromptOption(args: {
  intr: Intr; key: string;
  /** One pick per step the option listed, by step id. */
  picks?: Partial<RulePicks>;
  policy: Policy; context: PromptContext;
}): ResolvedPromptOptionResult;
```

`folderWithoutAsking` and `folderFor` are replaced by `picksWithoutAsking` and one checker that covers both parts. Do not keep the old names as wrappers.

- Produces, in `alwaysChoices.ts`:

```ts
/** Effects outside a shared set that still get the folder step and rules
 *  that reach dot folders. Each entry is a decision: the folder step lets
 *  one key press widen a rule to a parent folder. */
export const FOLDER_STEP_EFFECTS: string[] = ["std::exec"];
export function getsFolderStep(effect: string, sets: Record<string, EffectSetInfo>): boolean;
```

`getsFolderStep` is true for a member of a shared set and for an effect in the list. `folderField` and the `matchDotFolders` check in `withScopedRule` use it in place of `inSharedApprovalSet`. The set-wide answer ("always approve all reads in") still uses `sharedApprovalSet`, so `std::exec` does not get it.

The label of an items choice is the values of the effect's exact `@always` fields, in declared order, then the kept items, joined with spaces, then ` …` when `rest` is true. For `std::exec` that reads `pnpm run agency …`. The exact choice carries the note `this exact command`. Every label passes through `stripControlChars`.

An argument longer than 60 characters is cut to its first 60 and `…` in the label only. The body above the menu already shows the whole command, and without the cut a forty-line script would print twice more in the choices. The rule is built from the full argument.

The question `Which commands should this cover?` fits `std::exec`, the tag's only user. Put a comment beside the string saying it needs a general wording when a second effect uses `@alwaysPrefix`.

- [ ] **Step 1: Write the failing tests** in `interruptPromptOptions.test.ts`, using the effect name `std::exec` with the three-field scope from Task 3 supplied through the test's context registry. The real declaration does not carry these tags until Task 6, and the context is what the functions read.
  - `promptOptions` for `pnpm run build` in a sub-folder of the launch directory: the "always approve when" option has two steps, `items` then `folder`. The `items` labels are `pnpm run build`, `pnpm run build …`, `pnpm run …`.
  - For a bare `make` in the launch directory: no steps.
  - For `pnpm test` in the launch directory: one step, `items`, with two choices.
  - `resolvePromptOption` with `picks: { items: "1", folder: "/launch" }` saves `{ command: "pnpm", args: ["run", "**"], cwd: "{/launch,/launch/**}" }` with `matchDotFolders: true`.
  - A pick for a step the option did not list is a failure. A missing pick for a listed step is a failure. An `items` pick of `"0"`, or of `"5"` for a two-argument command, is a failure. A `folder` pick outside the listed folders is a failure.
  - The effect-wide answers and "approve once" save what they saved before.
  - An existing read effect still gets its one `folder` step and its set-wide answer, and `std::exec` gets no set-wide answer.
- In `alwaysTag.stdlib.test.ts`, the test that every shared set's members declare the same scope still passes untouched.

- [ ] **Step 2: Run them and see them fail.**

Run: `pnpm exec vitest run lib/runtime/interruptPromptOptions.test.ts lib/runtime/alwaysChoices.test.ts > /tmp/task4.log 2>&1; tail -40 /tmp/task4.log`

- [ ] **Step 3: Implement.** A step with one choice is not listed: its only choice is used, as a single folder is today. Update every existing test that reads `scopes` or passes `scope`.

- [ ] **Step 4: Run the tests and `pnpm run typecheck`.** The typecheck fails in `lib/stdlib/policy.ts`, which still calls the old names. That is expected; Task 5 fixes it. Confirm that no other file fails.

- [ ] **Step 5: Commit with Task 5.** These two tasks are one commit, because the tree does not typecheck between them.

---

### Task 5: The terminal prompt asks both questions

**Files:**
- Modify: `lib/stdlib/policy.ts`
- Modify: `stdlib/policy.agency` (`askFolder`, `askFolderFor`, `askUser`, `recordAnswer` and the push into the pending answers near line 1202, the `AskUserResult` type, the `PendingAnswer` type near line 255, and `policyToSave` near line 592)
- Test: the agency-js tests that drive the folder step, `tests/agency-js/cli-policy-handler-set/` and `tests/agency-js/cli-policy-handler/`. Add the new cases beside them and run each with `pnpm run agency test js <dir>`.

**Interfaces:**
- Consumes: `picksWithoutAsking`, `policyAfterDecision({ picks })`, `PromptStep` (Task 4).
- Produces, in `lib/stdlib/policy.ts`: `_picksWithoutAsking(intr, decision, fields)` and `_itemChoices(intr, fields): { id: string; label: string; note: string }[]`, replacing `_folderWithoutAsking`. `_policyAfterDecision` takes `picks` where it took `folder`.
- Produces, in `stdlib/policy.agency`: `AskUserResult` and `PendingAnswer` each hold `picks: { items: string; folder: string }` where they held `folder`.

**Why `PendingAnswer` matters.** When the handler runs under `useRunPolicy`, which is the path the agent takes, answers are not saved from the in-memory policy. `policyToSave` loads the policy file again and replays each pending answer against it. If a pending answer carried only a folder, the replay would call `buildScopedMatch` with no items pick, which means the exact choice. The person would pick `pnpm run …`, the session would hold `pnpm run …`, and the file would get `pnpm run build`. Nothing would fail, and the next session would ask again.

- [ ] **Step 1: Write the failing tests.** Drive the terminal prompt the way the existing folder-step tests do.
  - For a `std::exec` interrupt of `pnpm run build` in a sub-folder: answer `ap`, pick the third command choice, pick the launch directory, and assert the saved policy holds the rule from Task 4.
  - Answer `ap`, then `b` at the first question: the first menu is shown again and nothing is saved.
  - In answers-only mode (under `useRunPolicy`): make the same picks, and assert that the policy file on disk holds `args: ["run", "**"]`, and not `["run", "build"]`.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement.**
  - `askItems(intr, risk): string | null` is written like `askFolder`: numbered choices, a `back` item, the title `Which commands should this cover?`, and the body `{effect} will always be approved for the commands you pick.` It returns the choice's id, or null for back.
  - `askFolderFor` becomes `askPicksFor(intr, answer): { items: string; folder: string } | null`. It asks the items question first, then the folder question. `back` at either returns null, which shows the first menu again, as `back` does today.
  - `menuItem` in `lib/stdlib/policy.ts` sets `followUp` when the option has at least one step.
  - `PendingAnswer` carries `picks`, `recordAnswer` pushes them, and `policyToSave` passes them to `_policyAfterDecision`.

- [ ] **Step 4: Run `make`, then the test, then `pnpm run typecheck`.** `make` is needed because a stdlib file changed. Read the `make` log for the word `error`: `make` can exit 0 with a stdlib type error.

Run: `make > /tmp/task5-make.log 2>&1; grep -n "error" /tmp/task5-make.log | head`

- [ ] **Step 5: Commit Tasks 4 and 5.** Message: `approval prompt: an option can ask more than one follow-up question`.

---

### Task 6: `std::exec` pins its arguments and its folder

**Files:**
- Modify: `stdlib/shell.agency` (the effect near line 45, and `exec` near line 97)
- Modify: `stdlib/safeBash/actions.agency` (`ExecPayload`, near line 341)
- Modify: `stdlib/safeBash.agency` (`execEffects` near line 829, `subcommandOf` near line 839, the raise near line 6547, and the comments in `NO_EXEC_PROGRAMS` near line 779)
- Modify: `lib/runtime/builtinPolicies.ts` (`agencyExecApproveRules`)
- Modify: `lib/stdlib/shell.ts` (a new exported function for the folder)
- Modify: `stdlib/policy.agency` (the `ScopedRuleFields` doc example near lines 210 to 214, which names `subcommand`, and the `PolicyRule` doc comment, which says the prompt sets `matchDotFolders` "on the read rules it saves")
- Modify: `lib/typeChecker/alwaysTag.stdlib.test.ts` (the row for `std::exec`, and `describeField` for a prefix field)
- Modify: `tests/agency/safeBash.agency` (it reads `p.subcommand` near lines 2978 and 3673, and holds a rule that matches on `subcommand` near line 3013)
- Test: `tests/agency/safeBash.test.json`, `tests/agency/agency-cli.test.json`, `tests/agency/policy-build-scoped-match/`, `lib/agents/agency-agent/tests/execPolicy.agency`, `lib/runtime/interruptPromptOptions.test.ts`, `lib/cli/eval/workflowFlags.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

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

- [ ] **Step 1: Find every use.** Run `grep -rn "subcommand" stdlib lib tests --include=*.agency --include=*.ts --include=*.json | grep -v "\.js:" | grep -vi "git\|gh "` and read the list. Uses that are about a git or gh subcommand, `stdlib/agency.agency`'s `cliHandles`, and `lib/vendor/commander` are not this field and stay.

- [ ] **Step 2: Write the failing tests.**
  - In `lib/agents/agency-agent/tests/execPolicy.agency`: under `recommended`, `agency parse x.agency` is approved and `agency run x.agency` is not. Rewrite the existing cases that assert on `subcommand`.
  - A new Agency test node beside the existing `exec` tests: `exec("pwd")` with no `cwd` raises `std::exec` whose `cwd` is the run's folder, an absolute path. `exec("pwd", cwd: "sub")` raises one whose `cwd` is absolute and ends in `/sub`. Capture the payload with a handler that records `intr.data.cwd` and rejects. Then no process runs, and the folder `sub` does not have to exist.
  - In `alwaysTag.stdlib.test.ts`, the decision table's row for `std::exec` reads `["command", "args…", "cwd/**"]`, with `describeField` printing a prefix field as `args…`.

- [ ] **Step 3: Implement.**
  - The effect declaration, as above.
  - `exec`: delete the `subcommand` variable and its comment.
  - The folder. `_exec` resolves its folder inside TypeScript: it calls `resolveSpawnCwd` (`lib/stdlib/shell.ts`, near line 72), which calls `resolveDir`, which calls `resolveCwdPath` (`lib/stdlib/resolveDir.ts`, near line 10). `resolveCwdPath` is exported, expands `~`, and touches no file. Add a small exported function to `lib/stdlib/shell.ts` that returns `resolveCwdPath(host, cwd)`, with an empty `cwd` meaning the run's folder. Do not call `resolveSpawnCwd` before the question: it reads the disk to check that the folder exists, and a question must not depend on that.
  - In `exec`, after `applyAgentCwd`, assign that function's result to the `cwd` variable. Put that variable in the interrupt and pass the same variable to `_exec`, so the question and the command read one value. `_exec` resolving it again gives the same folder, because it is already absolute.
  - safeBash: delete `subcommand` from `ExecPayload`, delete `subcommandOf`, and drop the field where the effect is built and raised. Reword the two comments in `NO_EXEC_PROGRAMS` that explain an entry by its subcommand: the reason `npx` is listed is that its first argument is a flag, so the widest choice the prompt offers would cover every package.
  - `agencyExecApproveRules`: `match: { command: "agency", args: [sub, REST_OF_LIST] }`.
  - `tests/agency/safeBash.agency`: the two helpers that read `p.subcommand` read `p.args[0]` where the test still needs the first argument, and the rule near line 3013 is rewritten in the list form.
  - `stdlib/policy.agency`: the `ScopedRuleFields` example uses `args`, and the `PolicyRule` comment says the prompt sets `matchDotFolders` on a rule whose folder came from the folder step.

- [ ] **Step 4: Update the expected values.** `tests/agency/safeBash.test.json` holds payloads that include `subcommand`. Run the test once, saving the output, and copy the actual payloads in. Read each changed row before accepting it: the only difference may be the missing field.

Run: `make > /tmp/task6-make.log 2>&1; grep -n "error" /tmp/task6-make.log | head; pnpm run agency test tests/agency/safeBash.agency --check-capabilities > /tmp/task6-safebash.log 2>&1; tail -20 /tmp/task6-safebash.log`

- [ ] **Step 5: Run the other tests this task names, and `pnpm run typecheck`.** Save each output to a file.

- [ ] **Step 6: Commit.** Message: `std::exec: "always approve when" pins the arguments and the folder; subcommand is removed`.

---

### Task 7: Saved rules against later questions, and docs

The test in this task checks what a saved rule approves afterwards. Its wider rules are written as literals, so it tests the matcher and not the prompt. The path from a pick to a rule is covered by Task 4's unit tests and Task 5's agency-js tests.

**Files:**
- Create: `tests/agency/exec-always-scope.agency` and `tests/agency/exec-always-scope.test.json`
- Modify: `docs/dev/agents/approval-policies.md`
- Modify: `docs/dev/language/effect-always-tag.md`
- Modify: `docs/dev/stdlib/safe-bash.md` (near lines 1208, 1250, and 1272 to 1276)
- Modify: `docs/dev/stdlib/jobs.md` (near line 255)
- Modify: `CLAUDE.md` in this package (the index line for `effect-always-tag.md`)
- Modify: `stdlib/policy.agency` doc comments, which generate the stdlib reference

Nothing under `docs/site/` is edited by hand. The user guide's policy page does not describe list rules after this change, and the pull request description says so.

- [ ] **Step 1: Write the test.** Each node builds a policy, then asks `checkPolicy` about a second interrupt. A rule for the exact choice is saved with `recordScopedRule`. A rule for a wider choice is written out as a literal, in the shape the unit tests of Task 4 pin for that choice. No program is run and no model is called.
  - `anExactScriptAsksAgain`: a rule saved from `python3 -c 'print(1)'` with the exact choice approves the same command and propagates `python3 -c 'print(2)'`.
  - `aWiderChoiceCoversSiblings`: a rule saved from `pnpm run build` with the `pnpm run …` choice, for a folder `F`, approves `pnpm run test` in `F` and in `F/sub`, and propagates it in a folder outside `F`.
  - `aRuleReachesDotFolders`: the same rule approves `pnpm run test` in `F/.worktrees/x`.
  - `gitAddOfEverythingAsks`: a hand-written `std::git::add` rule `{ cwd: F, paths: "src/**", all: "false" }` approves paths under `src`, propagates a path outside it, and propagates an interrupt with `paths: []`.
  - `anArgumentWithAStar`: a rule saved from `ls *.md` with the exact choice propagates `ls a.md`.

- [ ] **Step 2: Run it.**

Run: `pnpm run agency test tests/agency/exec-always-scope.agency --check-capabilities > /tmp/task7.log 2>&1; tail -20 /tmp/task7.log`

- [ ] **Step 3: Write the docs.** Dev docs describe the mechanism and the rule, with no history of how the design was reached.
  - `approval-policies.md`, "Rule matching": the table from the spec, the empty-list rule and its reason, and the note that list items are compared as written.
  - `approval-policies.md`, "What 'always approve when' pins": the items step, the two lists (`SHARED_APPROVAL_SETS` and `FOLDER_STEP_EFFECTS`) and what each decides, and that `matchDotFolders` is set for a folder picked in the folder step. Rewrite the sentence that ties the flag to effects that only read.
  - `approval-policies.md`, near line 725: rewrite the paragraph that says an interpreter rule "should be keyed on `subcommand`". It now says a hand-written rule for an interpreter should pin `args`.
  - `approval-policies.md`, "Showing an interrupt from TypeScript": this section documents `scopes` and `scope` with an example call to `resolvePromptOption`. Rewrite it for `steps` and `picks`. It is the section the author of a front-end reads.
  - `approval-policies.md`: a command run in the home directory. `folderChoices` lists no folder there, so the saved rule pins `cwd` to the home directory and below, without dot folders. That is no broader than the old rule, which pinned no folder.
  - `approval-policies.md`: the limit on a pattern's length, and that "always approve when" is not offered when a pinned value passes it.
  - `effect-always-tag.md`: the third tag, the `matchPrefix` flag, and the `alwaysPrefixNotList` diagnostic.
  - `safe-bash.md` and `jobs.md`: the places that say a `std::exec` rule pins `command` and `subcommand`, or that an interpreter rule should be keyed on `subcommand`.
  - `CLAUDE.md`: the index line for `effect-always-tag.md` names all three tags. Keep it under 150 characters.

- [ ] **Step 4: Run `make`, then `pnpm run lint:structure` and `pnpm run fmt:ts` on the TypeScript files this branch changed.** Format named files only.

- [ ] **Step 5: Check the branch against `docs/dev/contributing/anti-patterns.md`.**

- [ ] **Step 6: Commit.** Message: `exec always-approve scope: saved-rule test and docs`.

---

## The pull request

Open one pull request into `main`. Its description needs:

- The problem and the two-question prompt, with the example from the spec.
- **For the changelog:** `subcommand` is gone from the `std::exec` question; a policy rule's `match` value may be a list; a string pattern against a list field now means "every item matches" where it used to compare the comma-joined text; the `exec` tool reports the folder the command runs in; `PromptOption.scopes` is replaced by `steps`, and `resolvePromptOption` takes `picks`.
- **Interrupts and handlers:** no raise is added, removed, or moved.
- What was run locally and what was left to CI.

## After the pull request merges

These are not part of the branch.

1. **The owner's saved policy.** `~/.agency-agent/policy.json` holds `std::exec` rules that name `subcommand`. They stop matching, so those commands ask again. `missingPolicyRules` already offers built-in rules that a saved policy lacks, and the new `agency` list rules will count as missing, so the agent should offer them at its next start. Check what that offer shows first. The old `subcommand` rules stay in the file and never match; with the owner's yes, remove them by hand, the `sed -n` rule among them. Show the owner the before and after.
2. **Perry.** It reads `PromptOption.scopes` and sends `scope`. It has to show `steps` and send `picks` when it moves to this version of agency-lang.

## Self-review against the spec

| Spec section | Task |
| --- | --- |
| Part 1, a rule can match a list | 1 |
| Part 2, the tag | 2 |
| Part 3, `std::exec` and the `exec` tool's folder | 6 |
| Part 4, the prompt: the command choices | 3 |
| Part 4, the steps and which effects get the folder step | 4, 5 |
| What happens to existing rules: `recommended` | 6 |
| What happens to existing rules: the owner's policy | after the merge |
| Tests | each task, and 7 |
| Docs | 7 |
