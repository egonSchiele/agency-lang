# Interrupt prompt options that TypeScript can call

Status: a design for review. No code is written. This changes the code
behind the interrupt prompt, so it needs a yes before any of it is built.

Linear: ADI-332. It blocks ADI-324 (answering interrupts in Perry's Mac
app).

## What these functions are, and what they are not

They are the data layer for a front-end that is about to show an interrupt
to a person. They do two jobs:

1. **Before the person picks:** work out what to show. That is the list of
   options, and for an option that saves a rule, how wide the rule can be.
2. **After the person picks:** work out what the pick means. That is the
   `InterruptResponse` to give the run, and the policy with any new rule.

They do not respond to an interrupt. Responding is `approve()`, `reject()`
and `respondToInterrupts`, which exist and do not change. A program that
uses these functions still responds through those.

## The problem, in one example

The agent wants to read `/p/src/login.ts`. In `agency agent` the prompt
shows these options:

```
(a)   approve once
(aa)  always approve               every std::read
(ap)  always approve when          dir = /p/src and below  ›
(as)  always approve all reads in  /p/src and below  ›
(r)   reject once
(rr)  always reject                every std::read
```

You press `ap`, pick the folder `/p`, and this rule is saved:

```json
"std::read": [{ "match": { "dir": "{/p,/p/**}" }, "action": "approve", "matchDotFolders": true }]
```

The logic for job 1 and job 2 is Agency code inside `cliPolicyHandler`, in
`stdlib/policy.agency`. A program that shows interrupts some other way
cannot reach it.

Perry is such a program. Its engine is TypeScript. It shows an interrupt
after the run has paused and handed the interrupt out with a checkpoint,
which is what lets a second device answer it. TypeScript can import Agency
nodes but not Agency functions, so the engine cannot call `askUserChoices`.
Even from a node it could not save a folder rule, because `recordPromptRule`
is private and reads the handler's module variables.

## A second list already exists

The runtime has its own prompt for a surfaced interrupt, in
`lib/runtime/interruptPrompts.ts`. It is the one `agency run --interactive`
uses. It has its own copy of part of the same logic:

| In the runtime today | The same thing in `std::policy` |
| --- | --- |
| `PromptDecision`: `approve`, `reject`, `approve-always`, `reject-always` | `Decision`: those four and two more |
| `parsePromptAnswer("aa")` → `"approve-always"` | the key lookup in `choiceResult` |
| `approvalQuestion`, which hardcodes `(a)pprove / (r)eject / (aa) approve-always / (rr) reject-always` | the `ANSWERS` table |
| `answer === "approve" \|\| answer === "approve-always"` in `interruptResolution.ts` | `approves` |

So there are two lists of options today. This design ends with one, in
TypeScript, that both prompts and any other front-end read.

## What does not change

- **What `agency agent` shows and saves.** Same options, same order, same
  labels, same rules, same placement. The existing tests are the check (see
  "How to test").
- **What `agency run --interactive` offers.** The same four options, the
  same keys and spelled-out words, and an unrecognized answer is still a
  reject.
- **When a handler runs and what it decides.** `_handler`, `askUser`,
  `applyRule`, the lock, the second policy check under the lock, the policy
  file's load and save, and every message stay in Agency, untouched. No
  handler is registered differently, and nothing about when an interrupt
  reaches a person changes.
- **`std::policy`'s exported functions.** `askUserChoices`,
  `buildScopedMatch`, `recordRule` and `recordScopedRule` keep their names,
  signatures and behaviour. Their bodies become calls into TypeScript.
- **`ChoiceItem` in `std::ui/cli`.** It is a row in a generic menu, and its
  `tone` field is a display hint there. It stays as it is.

## What moves

All of it is computation: no interrupt, no model call, no terminal, no file.

| In `stdlib/policy.agency` today | What it does |
| --- | --- |
| `ANSWERS`, `AnswerRow` | The table of six options |
| `answerOffered` | Whether a row is offered for an interrupt |
| `answerItem` | A row as the item a menu shows |
| `folderField`, `folderOptions` | Whether a rule for this interrupt can cover a wider folder, and which |
| `sharedSetFor` | The effect set an `(as)` rule covers |
| `scopedFieldsFor`, `buildScopedMatch`, `describeScopedMatch` | An interrupt's scope, as fields, as a rule's `match`, and as words |
| `unrejectedEffects` | The effects an `(as)` rule is saved under |
| `recordPromptRule`, and the four cases in `recordAnswer` | The rule each "always" option saves |
| The key lookup in `choiceResult`, and `approves` | A typed key as a decision, and whether a decision approves |
| `stripControlChars` | Removing control and invisible characters from text a prompt shows |

Their neighbours are already TypeScript: `describeScope`, `folderChoices`
and `sharedApprovalSet` in `lib/runtime/alwaysChoices.ts`, and
`insertApproveRule` in `lib/runtime/policyUpdate.ts`.

## The TypeScript API

A new file, `lib/runtime/interruptPromptOptions.ts`, exported from
`agency-lang/runtime`. It sits beside `interruptPrompts.ts`, which draws
the runtime's terminal prompt, and uses that file's words: a "prompt" is an
interrupt shown to a person.

```ts
/** What an option does. The existing type, with the two values
 *  std::policy's `Decision` adds. */
export type PromptDecision =
  | "approve" | "reject"
  | "approve-always" | "reject-always"
  | "approve-always-here" | "approve-always-set";

/** How wide a saved rule can be. For a file read, a folder. */
export type PromptScope = {
  /** What the front-end sends back to pick this scope. */
  id: string;
  /** What the user reads: "/p/src". */
  label: string;
  /** A remark shown beside it: "the launch directory". */
  note?: string;
};

/** One option a prompt for an interrupt shows. */
export type PromptOption = {
  /** What the front-end sends back to pick this option: "ap". */
  key: string;
  label: string;
  /** Which way the option answers the interrupt. The same two words as
   *  `InterruptResponse.type`. */
  response: "approve" | "reject";
  /** What a rule saved by this option covers, in words:
   *  "dir = /p/src and below". */
  detail?: string;
  /** The widths the saved rule can have, narrowest first. Empty for an
   *  option that saves no rule, or whose rule has one width. With two or
   *  more, the front-end asks which before it resolves the option. */
  scopes: PromptScope[];
};

/** What the options depend on besides the interrupt. */
export type PromptContext = {
  /** Per-effect scope overrides: `cliPolicyHandler`'s `fields:`. */
  overrides: Record<string, ScopedField[]>;
  /** The scopes effects declare with `@always` / `@alwaysUnder`. */
  registered: Record<string, ScopedField[]>;
  sets: Record<string, EffectSetInfo>;
  dirs: PolicyDirs;
};

/** Job 1. The options to show for `intr`, in the order a prompt lists
 *  them. */
export function promptOptions(intr: Intr, context: PromptContext): PromptOption[];

/** Job 2. What picking an option means: the response for the run, and
 *  `policy` with the rule the option saves (the same policy for an option
 *  that saves none). A failure when `key` is not an option this interrupt
 *  offers, or `scope` is not one of that option's scopes. */
export function resolvePromptOption(args: {
  intr: Intr;
  key: string;
  /** The `id` of the scope picked. Omit it when the option has fewer
   *  than two scopes. */
  scope?: string;
  policy: Policy;
  context: PromptContext;
}): Result<{ response: InterruptResponse; policy: Policy }>;

/** The context for a program that is not inside a run: the declared scopes
 *  and built-in sets of this process, and the directories for `cwd`. */
export function promptContext(args: {
  cwd: string; overrides?: Record<string, ScopedField[]>;
}): PromptContext;
```

`promptOptions` and `resolvePromptOption` are pure. `promptContext` reads
the process's scope registry and resolves directories. `Intr`,
`InterruptResponse`, `Policy`, `PolicyDirs`, `ScopedField` and
`EffectSetInfo` are existing types.

### Why scopes, and not a function for folders

Today the only rule that can be widened is a file read's, from its folder
to a parent folder. An earlier draft had a function that returned folders.
That would mean a new function, and a change in every front-end, for each
new kind of widening. A fetch could later widen from one URL to its whole
domain.

With `scopes` on the option, a new kind of widening is a new producer
inside this file. A front-end already knows what to do: an option with two
or more scopes needs a second question.

```ts
// A file read today:
{ key: "ap", label: "always approve when", response: "approve",
  detail: "dir = /p/src and below",
  scopes: [ { id: "/p/src", label: "/p/src" },
            { id: "/p", label: "/p", note: "the launch directory" } ] }

// A fetch, if we add it later. Nothing above this file changes.
{ key: "ap", label: "always approve when", response: "approve",
  detail: "url = https://a.com/x",
  scopes: [ { id: "https://a.com/x", label: "this URL" },
            { id: "a.com", label: "any URL at a.com" } ] }
```

### How a TypeScript program uses it

This is Perry's engine. Nothing here runs Agency code.

```ts
const context = promptContext({ cwd: session.cwd });

// Job 1: what to show. The engine sends these to its clients.
const options = promptOptions(interrupt, context);

// Job 2: a client picked an option, and a scope if it had to.
const resolved = resolvePromptOption({
  intr: interrupt, key: "ap", scope: "/p", policy, context,
});
if (!resolved.success) { /* not offered: refuse the request */ }

// Responding is the existing API. The new policy goes on the next resume.
await respondToInterrupts([interrupt], [resolved.value.response], {
  invocation: { policy: resolved.value.policy },
});
```

### How `std::policy` uses it

`lib/stdlib/policy.ts` gains thin wrappers that build the context from the
current run, as `_folderChoices` and `_sharedApprovalSet` do today. The
Agency functions become short:

```ts
export def askUserChoices(intr: any): ChoiceItem[] {
  return _promptMenuItems(intr, globalCliPolicyOpts.fields)
}
```

`_promptMenuItems` turns each `PromptOption` into the `ChoiceItem` the
terminal menu already takes: `response` becomes `tone`, and "two or more
scopes" becomes `followUp`. The menu, the folder step's second menu, the
lock and `askUser` do not change. `recordAnswer` calls the wrapper around
`resolvePromptOption` and keeps the policy it returns.

### How the runtime's own prompt uses it

`parsePromptAnswer` looks the typed text up in the table, among the four
options that prompt offers. `approvalQuestion` builds its line from the
same rows. The two comparisons in `interruptResolution.ts` read the row's
`response` and whether the row saves a rule.

That prompt keeps its own way of remembering an "always" answer, which is
per effect and for the run only. Moving it onto a policy is a separate
change and is not part of this.

## Also exported, for the same callers

- `SerializedInterrupt` and `withoutCheckpoint` from
  `lib/runtime/ipcChild.ts`: an interrupt without its checkpoint, for a
  program that sends interrupts to a client. Perry derives this type itself
  today.

As built: `promptContext` fills the whole context, so `builtinEffectSets`
and `resolvePolicyDirs` did not need exporting. The table is its own file,
`interruptPromptTable.ts`, which imports nothing, because
`interruptPrompts.ts` must stay a leaf and reads it.

## Safety points I checked the design against

- **No rule is saved for a raise that expects a value.** `promptOptions`
  offers such a raise only the two one-time options, and
  `resolvePromptOption` fails for any other key. An effect-wide rule would
  otherwise answer every later raise of that effect with an empty value.
- **A key that was not offered does nothing.** `resolvePromptOption`
  checks the key against the options for that interrupt, as `choiceResult`
  does today. A client cannot send `aa` for an interrupt that offered only
  `a` and `r`.
- **A scope that was not offered does nothing.** Today the folder always
  comes from the prompt's own list, so this check does not exist. A
  TypeScript caller passes a scope that came from a client, so
  `resolvePromptOption` fails unless it is one of the option's scopes.
- **An empty scope never becomes a catch-all rule.** No rule is saved when
  the scoped match is empty, as in `recordPromptRule`.
- **A reject the user saved is never overturned.** Rules still go in
  through `insertApproveRule`, which places them after an effect's rejects.
- **Text a prompt shows is still cleaned.** `stripControlChars` moves with
  the functions that use it, with the same three patterns.
- **The policy still decides inside the run.** Nothing here answers an
  interrupt. Rules still apply through the handler or the run policy.

## One behaviour difference

`recordAnswer` today marks the policy as needing a save in each of its four
"always" cases. After the move it marks it when the policy changed. The
only case that differs is an option that would save a rule the policy
already has: today that rewrites an identical file, and after the move it
writes nothing.

## What this does not do

- It does not change how Perry, or anything else, shows an interrupt.
- It does not decide where Perry saves its rules. That belongs to ADI-324.
  Agency's own policy file functions raise `std::write`, and how a
  TypeScript host should save a policy is a separate question.
- It does not make the terminal prompt itself reusable. `askUser` draws on
  a terminal and stays as it is.
- It does not change `recordScopedRule`'s placement. That function puts
  its rule first and never matches dot folders, on purpose, and programs
  call it.
- It does not add any new kind of widening. Folders for file reads are the
  only one, as today.

## How to test

One build and one test run for the whole change, not one per step.

1. **New unit tests**, `lib/runtime/interruptPromptOptions.test.ts`. A
   table of interrupts against the options offered: a file read in the
   launch folder, a read under the home directory (no wider folder, so no
   `(as)`), `std::exec`, an effect with no declared scope, an effect with
   an override of `[]`, and a raise that expects a value. Then each option
   against what resolving it returns: the response, the rule, its placement
   after a saved reject, a key that was not offered, a scope that was not
   offered, and the unchanged policy for a repeated pick.
2. **The existing Agency tests must pass unchanged.** These are the proof
   that `agency agent` behaves as before:
   `tests/agency/policy-record-scoped-rule`,
   `tests/agency/policy-build-scoped-match`,
   `tests/agency/policy-always-registry`,
   `tests/agency/policy-ask-value-interrupt`, and
   `lib/agents/agency-agent/tests/envPolicy.agency`. If one needs editing,
   the move changed behaviour, and that is a finding to bring back, not a
   test to update.
3. **The existing runtime prompt tests must pass unchanged**:
   `lib/runtime/runPolicyHandler.test.ts`, which covers `parsePromptAnswer`
   for every key and word, and the tests of `interruptResolution.ts`.
4. `lib/runtime/alwaysChoices.test.ts` and `policyUpdate.test.ts`, which
   cover the functions the new file calls.
5. `pnpm run typecheck`, `pnpm run lint:structure`, and `pnpm run fmt:ts`
   on the files this adds.

## Docs

- `docs/dev/agents/approval-policies.md` says "The answers are one table,
  `ANSWERS` in `stdlib/policy.agency`." That becomes the TypeScript file,
  with a short section on showing an interrupt from TypeScript, and a
  sentence that says plainly these functions do not respond to one.
- A doc comment on each exported function, saying the same.
