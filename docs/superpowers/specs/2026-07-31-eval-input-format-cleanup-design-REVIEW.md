# Review: Eval input format cleanup

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-31-eval-input-format-cleanup-design.md`
against the code on `main` plus the open PR #738 branch.

## Verdict

The problem statement is right and well argued. "A test defines what the input
is; the person running the eval defines how it reaches their agent" is the same
line the seeding rule already draws (tests must not ship agent files), and
`node`/`args` are on the wrong side of it. Grounding the argument in the
regex-log port — where the instruction ended up duplicated across `goal` and
`args.task` purely because there was nowhere agent-agnostic to put it — is the
kind of concrete motivation that makes a format change easy to agree with.

I checked the spec's code references. `subprocess-bootstrap.ts`'s
`executeRun` does map named args positionally via `__<node>NodeParams`
(`paramNames.map((p) => msg.args[p])`, lines 84–116), `reflectionFeedback.ts:18`
is the `Args:` line, and `foo.agency:356` is `node main(task: string = "")`.
`evals-demo/writer.agency:5` is `node main(): string`, so the zero-parameter
case is real and covered.

Three things are wrong or missing, one naming question is worth settling before
implementation, and two design points deserve an explicit ruling rather than
being decided at the keyboard.

---

## Wrong or missing

### 1. `evals-demo/tests/hello-world/test.json` is not "unchanged"

The migration list says it is "already goal-only; unchanged". It is not
goal-only — the file is:

```json
{
  "goal": "Write a hello world Agency program to hello.agency",
  "args": {}
}
```

Under the new loader rule ("Inputs still carrying `args` or `node` are
**rejected** with a migration error"), this file fails to load. So the demo
suite is part of the migration, and — worse for a demo — it is the file most
likely to be copied by someone starting a new suite.

While fixing that, one clarification the spec should make: `args` is already
optional *in the JSON* — `normalizeInput` defaults it (`loadInputs.ts:150`,
`args: (spec.args ?? {})`) — and required only *in the type*. So "delete
`args`" means two different things (drop the required type field; start
rejecting the JSON key) and the spec should say both, because a reader could
reasonably implement only the first and leave old suites silently loading with
an ignored `args`.

### 2. The "one parameter, no task" case is not specified

The delivery convention enumerates 0 parameters, 1 parameter, and 2+ as though
that covers everything. It does not cover the other axis: the task can be
absent.

`input.task ?? input.goal ?? undefined` resolves to `undefined` whenever a
suite has neither — which is legal, and the spec itself restates the rule that
makes it legal ("a goal is required exactly when the default LLM judge would
run"). So a suite with custom graders and no goal, run against a one-parameter
agent, calls that node with `undefined`.

That is not a regression — today `paramNames.map((p) => msg.args[p])` produces
`undefined` for a missing key, so the same thing already happens. But the spec
is writing down a convention, and this cell of the table is blank. Pick one and
say it: an error at load time ("this suite has no task and the agent takes
one"), or `undefined` passed through with the agent author responsible for a
default (which is what `foo.agency`'s `task: string = ""` already does, and is
probably the right answer).

### 3. `--goal` starts sending the goal to the agent, and that is a behavior change

Today `inputFromGoal` produces `{ id: "input-1", goal, args: {} }`
(`loadInputs.ts:29`), so `agency eval run --goal "..."` against a
one-parameter agent calls that node with `undefined` — the goal is
grading-only, exactly as the Background section says ("The agent never sees
it").

After this change, the goal fallback means the agent *does* see it. For
zero-parameter agents nothing changes; for one-parameter agents the goal text
becomes the instruction.

I think that is the intent and it is a good default. But the spec presents it
only as "the goal fallback exists for the simple cases where criterion and
instruction coincide", which reads as a convenience rather than as a change to
what an existing flag does. It belongs in a short list of user-visible changes
alongside the rejected `args`/`node` keys — partly because it quietly
contradicts the Background's flat statement that the agent never sees the goal,
and that sentence will need editing too.

---

## Naming: `task` is the word this codebase deliberately removed

This is the point I would most like settled before anyone writes code.

PR #309 was a dedicated effort to unify eval and optimizer vocabulary, and its
decision was a hard rename of **task → input** across every user-facing
surface, with no back-compat aliases: `--tasks` became `--inputs`, `task_id`
became `id`, the artifact directory `runs/<id>/tasks/<id>/` and its `task.json`
became `inputs/<id>/` and `input.json`, and the `EvalTask` type became `Input`.
The reason was precisely that "task" and "input" named the same concept in two
places.

This spec reintroduces `task` one level down, as a field inside `Input`. The
result is phrases like "the input's task" and a fresh version of the question
#309 answered: is a task the test case or the thing the agent is told?

It gets more crowded with #738 on the branch: the per-test file is `test.json`,
the type is `Input`, and the field would be `task`. Three words across two
concepts, in the same directory.

The better name is in the spec already. The Harbor paragraph says: *"a task
carries a single **instruction**"*. `instruction` is Harbor's own word for
exactly this field, it cannot be misread as the test case, it reads correctly
for both the string form and the object form, and it carries no history in this
codebase. Renaming the field costs nothing now and cannot be done cheaply after
suites exist in the wild.

If `task` is kept anyway, the spec should spend a paragraph on why — otherwise
the next person to read it will assume the #309 rename was simply forgotten,
and re-litigate it.

---

## Two design points that need an explicit ruling

### The IPC half goes the opposite direction from the input half

The spec's framing is "one field replaces both". At the input layer that is
what happens. At the IPC layer it does the reverse: `RunInstruction` ends up
carrying **both** `args` and `taskArg`, with `executeRun` branching on which is
present — two ways to deliver arguments in one message type, which is the shape
this repo's house rules are most consistently against.

The justification given (other subprocess users pass named args and should be
untouched) is real, and I do not think a positional signal can be avoided:
the parent cannot name the parameter because it never loads the compiled
module, so "here is a value, place it positionally" has to be said somehow.

But there is a single-field way to say it. The bootstrap already holds
`paramNames`; let `args` be `Record<string, any> | unknown[]`, where an array
means positional. `std::agency.run` and hoisted calls keep passing objects and
never notice; eval passes a one-element array; `executeRun` branches on
`Array.isArray(msg.args)` instead of on the presence of a second field. One
field, one rule, and the wire stays as small as it is today.

Either shape is defensible. What the spec should not do is add the second field
without noting that it considered and rejected the one-field version — the
"one field replaces both" sentence sets up an expectation the wire change
quietly breaks.

### `input.json`'s contents change, and "what deliberately does not change" says otherwise

That section lists "the run-directory layout" as unchanged. The *layout* is
unchanged; the *contents* of `input.json` are not — `args` and `node` leave,
`task` arrives. That is a persisted-artifact change, the same class of thing
#734 and #735 both called out explicitly for `agentLabel`, `inputsSource`, and
`InterruptEntry.outcome`.

Two concrete consequences worth a sentence each:

- Run directories written before this change keep `args`/`node`. Graders
  receive the parsed spec as `ctx.input`, so a grader reading `input.args`
  against an old run gets `undefined` rather than an error. None of ours do
  today (the spec says so, and I did not find a counterexample), but grader
  modules are user-authored.
- `judgeSuite`'s fallback literal `{ id, args: {} }` (`judge/suite.ts`) stops
  type-checking when `args` leaves `Input`. Mechanical, but it is in the
  "everything downstream" list only by implication.

---

## Scope and testing

**The migration bullet undersells the size.** "Unit tests across `lib/eval/`
and `lib/optimize/` that construct `Input` values" is one line for a change
that touches `args: {}` **85 times across 25 files** in those two directories
alone (174 across 44 files in `lib/` overall, though many of those are unrelated
`args` bags). Not a problem — it is a mechanical rename — but the number belongs
in the spec so the PR's size is expected rather than alarming, and so nobody
tries to squeeze it in beside something else.

**One trap for the implementer, worth naming in the spec:**
`lib/eval/grading/graders/llmJudge.ts:44` has its own `options.node ?? "main"`
— that is the *judge program's* entry node, nothing to do with `Input.node`. A
mechanical sweep for `.node` in `lib/eval` will hit it.

**Testing gaps**, beyond the good list already there:

- The one-parameter-no-task case from finding 2, once its behavior is decided.
- The `--goal` delivery change from finding 3: a one-parameter agent under
  `--goal` receives the goal text. This is the cheapest possible regression
  test for the fallback and it pins a user-visible behavior.
- One assertion about a pre-migration run directory: either it still grades
  (because grading reads only `goal`/`expected`/`metadata`), or it does not and
  that is stated. Right now the spec is silent, and "old runs still grade" has
  been an explicit property of every change in this series so far.

## Smaller notes

- The Background's "The agent never sees it" (about `goal`) becomes false under
  the fallback rule. Needs editing in the same pass.
- The 2+-parameter error message should name the agent file and the node, not
  just the convention — this failure lands on someone pointing an existing
  agent at a suite for the first time, and "eval entry nodes take at most one
  parameter" without a filename means a hunt.
- `metadata` survives and is described as "free-form extra data for graders".
  Worth one sentence saying it is *not* an escape hatch for agent-shaped data,
  or the coupling this spec removes will grow back inside `metadata`.
