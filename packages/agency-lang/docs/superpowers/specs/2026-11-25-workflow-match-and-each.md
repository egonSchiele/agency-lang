# Workflows: `match` and `each` steps

The workflows spec (`docs/superpowers/specs/2026-10-26-workflows-design.md`,
decision 3) says conditionals and loops may be added later as step kinds.
This spec adds them: a `match` step for conditionals and an `each` step for
loops.

## The problem

A workflow today is a straight line. Every step runs, in order, every time.
Two requests do not fit that shape:

- "If the email is urgent, text me. Otherwise do nothing."
- "For every note the search found, add its items to the list."

The guide tells an author to put a branch or a loop in an Agency function
and call that function from a step. That works for a person who writes
Agency. It does not work for a person using a visual editor, or for the
designer model, because neither one writes functions.

There is a second reason. The owner plans a visualizer that draws a workflow
as a flowchart. A branch hidden inside a function draws as one box, so the
flowchart would not show the part of the workflow a reader most wants to
see.

## Background: how a workflow becomes a program

A reader who knows `docs/dev/stdlib/workflow.md` can skip this section.

A workflow is JSON with a list of steps. A tool step calls a function. An
LLM step asks a model for a typed value. A later step reads an earlier value
through a reference:

```json
{ "$ref": "steps.note[0].id" }
```

Four stages in `lib/stdlib/workflow/` turn the JSON into an Agency program:

1. `parse.ts` checks the JSON's shape.
2. `resolve.ts` checks tools and references, and works out every name the
   program will declare.
3. `lower.ts` builds each generated statement and records which step and
   field it belongs to.
4. `render.ts` prints the statements into a fixed program text, and records
   which lines each step owns so a type error can name its step.

The program is ordinary Agency. It runs in a subprocess, each tool raises
its own interrupts, and a paused run resumes at its line.

## What a person writes

### A `match` step

```json
{ "id": "triage", "kind": "llm",
  "prompt": "How urgent is this email?",
  "context": [{ "$ref": "steps.email.body" }],
  "output": "{ level: \"urgent\" | \"normal\" }" },

{ "id": "route", "kind": "match",
  "on": { "$ref": "steps.triage.level" },
  "cases": [
    { "is": "urgent",
      "steps": [
        { "id": "text", "kind": "tool", "module": "./send.agency", "tool": "sendText",
          "args": { "body": { "$ref": "steps.email.subject" } } }
      ] },
    { "is": "normal", "steps": [] }
  ] }
```

The `route` step reads one value and runs the steps of the case whose `is`
equals it. Here the value is the model's answer from the `triage` step.

| Field | Meaning |
| --- | --- |
| `on` | A reference to the value to test. It must be a reference. |
| `cases` | A list of at least one case. |
| `cases[n].is` | A string, a number, or a boolean. No two cases may have the same `is`. |
| `cases[n].steps` | The steps to run for that case. The list may be empty. |
| `otherwise` | Optional. The steps to run when no case fits. The list may be empty. |

An if/else is a `match` on a boolean with the cases `true` and `false`.

**A match is exhaustive.** When no case fits and the step has no
`otherwise`, the workflow fails, and the failure names the step:

```text
step route: no case matches "spam"
```

An author who wants other values ignored writes `"otherwise": []`.

### An `each` step

```json
{ "id": "note", "kind": "each",
  "over": { "$ref": "steps.search" },
  "steps": [
    { "id": "text", "kind": "tool", "module": "./notes.agency", "tool": "readNote",
      "args": { "id": { "$ref": "each.note.id" } } },
    { "id": "add", "kind": "tool", "module": "./lists.agency", "tool": "addItem",
      "args": { "text": { "$ref": "steps.text.body" } } }
  ] }
```

The `note` step runs its steps once for every item of a list, in order.
Inside the loop, `each.note` is the current item.

| Field | Meaning |
| --- | --- |
| `id` | The step's id. It is also the name the current item is read by. |
| `over` | A reference to a list. It must be a reference. |
| `steps` | The steps to run for each item. At least one. |

An empty list runs the steps zero times, and the workflow continues.

`each` is a new reference root beside `inputs` and `steps`. The two step
roots read alike: `steps.<id>` is the value of the step with that id, and
`each.<id>` is the current item of the loop with that id. A reference such
as `each.note.id` is valid only inside the loop whose id is `note`.

An author names a loop after its item, so that references read well. Step
ids are unique across the workflow, so two loops never share a name, nested
or not.

### What a step may reference

A step may read:

1. any input;
2. any step that comes before it in its own list;
3. any step that comes before the block it is inside, at every level of
   nesting;
4. the current item of every `each` step it is inside.

Nothing outside a block may read a step inside it. A step in one case may
not read a step in another case. The workflow's `result` may read top-level
steps only.

In the `each` example, `add` reads `text`, which is rule 2. Both could read
`search`, which is rule 3. `text` reads `each.note`, which is rule 4. A step
after the loop could read neither `text` nor `add`.

### A block has no value

A `match` step and an `each` step produce no value, so no reference may name
one. `steps.route` and `steps.note` are refused.

One consequence follows. A workflow with no `result` returns its last step's
value. When the last top-level step is a `match` or an `each`, there is no
such value, so the check asks the author to set `result`.

### Step ids

A step id is unique across the whole workflow, at every level of nesting.
That keeps every generated name, every guard label, and every entry of
`workflowSchemas` unique with no change to how they are built.

## Decisions, and why

**1. Conditionals are a `match` step. There is no `if` step and no `when`
field.** *Why:* a `match` tests one value against literals, so the format
needs no comparison operators and no `not`. The first spec's rule 2 is "a
workflow is not a second language", and operators are how other workflow
formats became one. Any test that is not an equality is a function or an LLM
step that returns a string or a boolean. A `when` field on a flat step was
set aside because the JSON would not say which steps form one branch, so a
flowchart could not draw the branch.

**2. Loops are an `each` step over a list. There is no "repeat until".**
*Why:* a loop over a list always ends, and its steps need only the current
item. A "repeat until" loop needs a step to read the previous round's value,
which is state carried between rounds, a new idea in the format. It waits
for a user who needs it.

**2a. A loop's current item is read as `each.<id>`, by the loop's own id.**
The owner decided this. *Why:* a loop has no value, so its id is used by no
`steps` reference. A separate field for the item's name would give the loop
two names, and a rule about nested loops reusing one. Ids are already unique.

**3. Blocks nest. Steps do not point at a next step.** *Why:* nested blocks
are what Agency has, so the JSON maps to the program one to one. Every case
rejoins at the end of its `match`, and every loop is one block. A flowchart
of the workflow is the JSON tree drawn top to bottom. A format with `next`
pointers would let an author point into the middle of a loop, and no Agency
program does that.

**4. A step inside a block is visible only inside that block, and a block
has no value.** *Why:* a step in a case that did not run has no value to
read. A value for the block itself would need the generated program to
declare a variable before the block, with a type. The generator does not
know types. It writes `const` declarations and lets the type checker infer
them. The visibility rule is also what Agency's own block scope gives, so
the generated program enforces it a second time.

**5. A match with no fitting case and no `otherwise` fails the workflow.**
The owner decided this. *Why:* a value the author did not plan for should
stop the run. It should not skip the block without a word.

**6. `cases` is a list of `{ is, steps }`. It is not an object keyed by the
value.** *Why:* JSON object keys are strings, so an object could not say
`true` or `3`. A list also keeps the cases in the order the author wrote
them, which is the order the visualizer draws them. The brainstorm sketched
an object, and this is a change from that sketch.

**7. A `match` lowers to an if/else-if chain. It does not lower to Agency's
`match`.** *Why:* inside an Agency `match` arm, `return` returns from the
arm. Every step is followed by a check that returns a failure from `main`.
Inside a `match` arm that check would end the arm and the workflow would
carry on after a failed step. Inside an `if` block, `return` returns from
`main`, which is what the check needs.

**8. A failure in one round of a loop stops the workflow.** *Why:* this is
the first spec's decision 5, unchanged. "Skip the failed item and continue"
belongs to the failure-handling step kind that decision already defers.

**9. A `match` step and an `each` step take no `limits`.** *Why:* a step's
limits become a `guard` block around its call, and `return` inside a guard
block returns from the guard. A guard around a whole block would change what
the failure checks inside it do. The workflow's limits still cover the
block, and each step inside it may set its own.

**10. `format` stays 1.** *Why:* the change adds step kinds and changes no
existing field. An older Agency that reads a new file reports that `kind`
must be `"tool"` or `"llm"`, which is the right message.

## The generated program

The `match` example becomes:

```
const step_route_on = step_triage.level
const step_route_case1 = step_route_on == "urgent"
const step_route_case2 = step_route_on == "normal"
if (step_route_case1) {
  const step_text_body = step_email.value.subject
  const step_text = sendText(body: step_text_body)
  if (step_text is failure) {
    return failure("step text (sendText): ${step_text.error}", { step: "text", cause: step_text })
  }
} else if (step_route_case2) {
} else {
  return failure("step route: no case matches ${JSON.stringify(step_route_on)}", { step: "route" })
}
```

The value is bound to a local first, so a type error in the reference lands
on a line the `on` field owns. Each case's test is bound to a local of its
own, on a line its `is` owns, before the first `if`. The `if` lines then
hold generated names and nothing else. With an `otherwise`, its steps go in the last
`else` block and the program has no "no case matches" line.

The `each` example becomes:

```
const step_note_over = step_search.value
for (step_note_item in step_note_over) {
  thread {
    const step_text_id = step_note_item.id
    const step_text = readNote(id: step_text_id)
    if (step_text is failure) {
      return failure("step text (readNote): ${step_text.error}", { step: "text", cause: step_text })
    }
    const step_add_text = step_text.value.body
    const step_add = addItem(text: step_add_text)
    if (step_add is failure) {
      return failure("step add (addItem): ${step_add.error}", { step: "add", cause: step_add })
    }
  }
}
```

Each round runs inside a `thread` block, so it starts with an empty
conversation. A tool that calls a model appends to the conversation it is
called in. Without the block, round 10 would resend rounds 1 to 9. A
`return` inside a `thread` block returns from the enclosing function, so the
failure checks still end the workflow. Nothing outside the loop reads a step
inside it, so no value has to leave the block.

The loop variable's name is the step id with the `step_` prefix every
generated name has. A loop with the id `failure` declares
`step_failure_item`, which shadows nothing.

A program of this shape was written by hand and run on 2026-11-25. It had an
if/else-if chain on a string, another on a boolean, and a `for` loop holding
a guarded step, all inside the scaffold's `handle` block. It passed the type
checker. A failure in the loop's third round ended `main` at that round.

The review type-checked three more facts with a second hand-written program:

- An LLM step's `let` and `thread` block inside a `for` body type-check as
  they do at the top level.
- An `over` that is not a list or a record is reported as `AG2006: For-loop
  iterable must be an array or Record`, on the `for` line. That line belongs
  to `over`, so the problem names the right field with no extra mapping.
- A case that can never equal the value gets no diagnostic. See "Calls I
  made".

## How each stage changes

One helper is shared by every stage. `allSteps(workflow)` returns every step
in the tree, in document order. Every reader of `workflow.steps` below moves
to it. A reader left on the top-level list would skip a check for a nested
step.

| Reader | What it does |
| --- | --- |
| the limits check in `parse.ts` | Checks each step's `limits` against the workflow's |
| `toolSteps` in `resolve.ts` | Feeds the tool rule |
| `importGroups` in `resolve.ts` | Builds the import lines |
| `collisionRule` in `resolve.ts` | Refuses two generated names that coincide |
| `referencedSteps` in `resolve.ts` | Decides which untyped tools get a warning |
| the step list in `resolveWorkflow` | Builds the resolved steps, now as a tree |
| `stepEffects` in `effects.ts` | Feeds the `raises` check and the CLI's "can raise" list |
| the `StepsById` map in `lower.ts` | Holds every step a reference can name |
| `guardLabels` and `typeDecls` in `lower.ts` | Collect each step's guard label and each LLM step's output type |

Two readers run on JSON that is not yet known to be well formed: `toolSteps`
in `lib/cli/workflow/toolImports.ts`, which plans the CLI's imports before
parse, and `problemAt` in `parse.ts`, which finds the step an issue belongs
to. So the walk underneath `allSteps` is `locatedSteps(workflow: unknown)`.
It returns every object in every step list with its JSON path, and it skips
anything with the wrong shape. It is the one function that knows where a
step list can be: the workflow's `steps`, a case's `steps`, `otherwise`, and
an `each` step's `steps`. Both readers use it, and parse reports what it
skipped.

### 1. Parse

The step schema becomes recursive: a `match` case and an `each` step hold
step lists. Parse adds these checks:

- `on` and `over` are references;
- each `is` is a string, a finite number, or a boolean, and no two cases of
  one step share an `is`;
- a step id is not used by any other step in the tree;
- a `match` or `each` step has no `limits`.

`REF_PATH` in `types.ts` accepts `each` as a third root beside `inputs` and
`steps`.

The rule that a step's limit may be no larger than the workflow's applies to
a nested step as it does to a top-level one.

`problemAt` finds a problem's step from the issue's path. Today it reads
`steps[i]`. It will walk the path to the innermost step, so a bad argument
three levels down is reported on its own step id.

A problem's `field` for the new kinds is `on`, `cases[1].is`, `otherwise`,
or `over`. A nested step too malformed to have an id is reported on the
block that holds it, with the field `cases[1].steps[0]`, `otherwise[0]`, or
`steps[0]`.

### 2. Resolve

`referenceRule` decides today whether a step may read another by comparing
positions in one list. It will carry a scope down the tree instead: the ids
of the steps visible so far, and the ids of the enclosing loops. The four
rules under "What a step may reference" are that scope.

New problems, each named by step and field:

- a reference to a step inside a block, from outside it;
- a `steps.<id>` reference to a `match` or `each` step;
- an `each.<id>` reference that is not inside the loop with that id, or
  whose id is not a loop;
- no `result` when the last top-level step is a `match` or an `each`.

`ResolvedRef` gains a third kind for a loop's item, beside `input` and
`step`. `resolveRef` produces it from an `each.<id>` path.

Two warnings change:

- The untyped-tool warning reads `on` and `over` as references, and reads
  nested steps. An `over` that points into an untyped tool's value is then
  warned about like any other reference into it.
- A new warning is reported on an `each` step when the workflow has no
  `limits.maxCost` and the loop holds an LLM step or a tool the catalog
  marks `handoff`. Such a workflow's cost depends on the length of a list.

`names(id)` gains names for the new kinds: `step_<id>_on` and one
`step_<id>_case<n>` per case for a match, and `step_<id>_over` and
`step_<id>_item` for a loop. `declaredBy` lists them, so `collisionRule`
refuses a step id that would produce the same local.

### 3. Lower

A fragment today is one statement and its owner. A block cannot be one
statement, because its opening line, such as `for (a in b) {`, does not
parse without its body. So a fragment becomes one of two things: a
statement, as today, or one line of a block's own text. The list of
fragments stays flat. Every fragment has a depth, which is the number of
blocks it is inside. A loop at depth 0 is its `for` line at depth 0, its
`thread` line at depth 1, its steps at depth 2, and two closing lines.

A case's test is a statement built from a new shape:

```
caseTest: "const {{local}} = {{on}} == #is"
```

`{{local}}` and `{{on}}` are generated names. `#is` is filled with
`literal(value)`, so a case's value enters the program the way every other
workflow value does, and it is never parsed.

A block's own lines are fixed text that holds generated names and nothing
else. Each name passes `isIdentifier` where the line is written:

```
if ({{test}}) {
} else if ({{test}}) {
} else {
for ({{item}} in {{over}}) {
thread {
}
```

So the dev doc's rule stands as written: every statement comes from
`SHAPES`. The block lines are a second fixed text beside the scaffold.

`reference()` writes an item reference as the loop's `step_<id>_item` and
the path. It never adds `.value`, because an item is not a `Result`.
`refLabel` learns the new root, so a context value read from an item reaches
the model labelled `(each.note.body)`.

Child fragments are filled and printed one at a time, as they are today. The
loop variable is therefore never bound by a template that a child is filled
into, and template hygiene has nothing to rename.

The "no case matches" line and the `on` and `over` bindings are ordinary
shapes in `SHAPES`.

### 4. Render

Render prints each fragment and indents it by its depth. The line ranges
come from the same flat list of prints, as they do today. A
block's opening line belongs to the block step: `cases[n].is` for a case
line, `otherwise` for the last `else`, `over` for the loop line and its
`thread` line. With no
`otherwise`, the last `else` and its "no case matches" line belong to
`cases`.

`workflowSchemas` needs no change. It is keyed by step id, and ids are
unique across the tree.

## Interrupts, handlers, and checkpoints

Nothing new is raised, and no handler changes.

- **Interrupts.** A step inside a block raises what its tool raises, when it
  runs. A step in a loop raises once per round, with that round's real
  arguments. An "always" answer or a policy rule covers later rounds the way
  it covers any repeated call.
- **Handlers.** The scaffold's handler wraps the whole body, so it encloses
  every block. A guard trip from a step inside a loop is rejected by the
  same label check as today.
- **Checkpoints.** A run paused inside a block resumes at its statement. For
  a `for` loop the runtime records the round and the statement within it,
  and for an `if` it records which branch was taken
  (`docs/dev/runtime/interrupts.md`). The generator adds nothing.
- **Isolation.** The program still runs in the subprocess `runWorkflow`
  starts. Nothing about the child changes.

## What changes for a reader of the first spec

The first spec says "No model chooses which tool to call or in what order."
With a `match` on an LLM step's value, a model does choose, among the routes
the author wrote. No model adds a route or a tool.

An `each` over a list that an LLM step produced gives the model a second
choice: how many times the loop's steps run, and with which item each time.

Each action is still gated by its own interrupt when it runs, with that
round's real arguments, so the safety argument is the same. The guide and
the dev doc will say both things in these words.

## The visualizer

The visualizer is not part of this change. The format is shaped so it can be
built from the JSON alone:

- A `match` step draws as one node with one labelled path per case, plus an
  "otherwise" path when the step has one. Each label is the case's `is`. All
  paths rejoin below the block.
- A `match` with no `otherwise` can draw a path that ends in a failure mark,
  because the format says what happens.
- An `each` step draws as a box around its steps, labelled with its id and
  `over`.
- The reference rules match the picture: a step can read anything above it,
  and nothing is read from outside a box or a branch.

## Other places that change

- **The designer.** `DESIGN_TUTORIAL` in `stdlib/workflow.agency` gets one
  `match` example and one `each` example, and the reference rules. Its
  examples use names no test uses, as the existing ones do.
- **The CLI.** `agency workflow check` lists what each step can raise. A
  nested step is listed by its id, as a top-level step is.
- **Docs.** The guide page `docs/site/guide/workflows.md` gets a section for
  each kind, and its sentence that sends branches and loops to a function is
  rewritten. The module doc comment at the top of `stdlib/workflow.agency`
  says the same thing and generates the stdlib reference page, so it is
  rewritten too. `docs/dev/stdlib/workflow.md` gets the mechanism: the scope
  rule, the if/else-if lowering and why, and a fragment's depth.

## Not in this change

- A value coming out of a `match` or an `each`.
- "Repeat until", and any loop that is not over a list.
- Comparison operators, `not`, or a case that matches several values.
- A case whose `is` is `null`, a list, or an object.
- `limits` on a `match` or `each` step.
- Continuing a loop after a failed round.
- Running the rounds of a loop in parallel.
- The visualizer.

## Tests

Unit tests, one file per stage, beside the existing ones:

- parse: each new field's shape problems, a duplicate `is`, a duplicate id
  across levels, a problem three levels down named by its own step, and a
  nested step with `limits.maxTime` refused when the workflow sets none;
- resolve: each of the four new reference problems, a valid reference for
  each of the four visibility rules, a loop inside a loop whose inner step
  reads both items, a nested step whose generated name
  collides with a top-level one, a tool inside a case that raises an effect
  `raises` does not allow, and both warnings;
- lower and render: the two examples above print as shown, and each line's
  owner is the step and field this spec names.

Agency tests in `tests/agency/workflow/`, with no model calls beyond a
mocked LLM step:

- a `match` on a mocked LLM value takes the fitting case;
- a `match` with no fitting case fails with the step's name, and with
  `"otherwise": []` it continues;
- an `each` over three items calls its tool three times in order, and over
  an empty list calls it zero times;
- a failure in round 2 stops the workflow and names the step;
- an interrupt raised in round 2 is left unanswered, and the resumed run
  finishes round 2 and round 3 without repeating round 1;
- a step with `limits` inside a loop trips its guard, and a caller that
  approves the trip does not extend it;
- a `match` inside an `each`, with `on` reading a mocked LLM step that runs
  inside the loop and reads `each.<id>`: "for every email, if it is urgent,
  text me";
- a tool that fails when its conversation already holds a message runs in
  every round of a loop without failing.

One spawn test in `lib/cli/workflow/workflow.spawn.test.ts`: `agency
workflow check` passes on a workflow whose only tool step is inside a case.

## Calls I made

The owner did not decide these. Each can be struck in review.

1. **No cap on how many items a loop runs over.** The workflow's `limits`
   is the cap on time and cost. The check warns when a loop holds an LLM
   step or a `handoff` tool and the workflow has no `limits.maxCost`.
2. **Each round of a loop runs in its own `thread` block.** Agent steps
   share `main`'s conversation today, and in a loop the cost would grow with
   the square of the list's length. The dev doc's follow-up, a `thread`
   block around every tool step, is not a prerequisite. That follow-up needs
   a typed value to leave the block, and a spike on 2026-11-25 found no way
   to keep the type. Two agent steps in one round still share that round's
   conversation, as two top-level agent steps do today.
3. **A case whose `is` can never equal the value is not reported.** The
   type checker accepts `step_route_on == "spam"` against the type
   `"urgent" | "normal"`. With no `otherwise`, a misspelt `is` fails the run
   with "no case matches", which a person sees. With `"otherwise": []`, the
   misspelt case is skipped and nothing reports it. The guide warns about
   this beside its `otherwise` example. A check in resolve was set aside: it
   would cover only an `on` that reads an LLM step's literal union, and it
   would have to follow the reference's path through the type text.
4. **An `over` that points at a record is accepted.** The type checker
   allows a `for` over a record, and the steps run once per key. The type
   checker cannot tell a record from a list of unknown items, so the check
   does not refuse one.
5. **An `each` step must hold at least one step, and a case may hold none.**
   An empty loop does nothing. An empty case is how an author says "do
   nothing for this value".

## Left to the builder

- How to make the zod step schema recursive. `step` is a
  `z.discriminatedUnion`, and a case holds a list of steps. The plan checks
  how a discriminated union takes a lazy member in zod 4 before it relies on
  one.
