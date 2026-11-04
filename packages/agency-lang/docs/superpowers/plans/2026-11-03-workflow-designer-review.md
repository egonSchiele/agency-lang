# Review: the workflow designer spec and plan

Reviewed:

- `docs/superpowers/specs/2026-11-03-workflow-designer.md`
- `docs/superpowers/plans/2026-11-03-workflow-designer.md`
- the spike in the working tree (`stdlib/workflow.agency` from line 691, and the edit to `docs/site/guide/workflows.md`)

## Verdict

The design is sound and the plan can be built from it once four things
change. The loop (draft, check, feed problems back, review, save) is the
right shape. The split between `designWorkflow` and `draftWorkflow` fits
BMO. The `raises` clause in the spec is correct: tracing `writeWorkflow`
and `catalog` gives exactly `std::workflow::review`, `std::workflow::save`,
`std::read`, and `std::run`. Every helper and line number the plan cites
exists where it says (`describeProblem` at `lib/stdlib/workflow/index.ts:59`,
`CHECK_ATTEMPTS` at `stdlib/toolbox.agency:799`, the renderers at
`stdlib/policy.agency:768` and the field table at `:847`, `round`'s
`precision: number = 0` at `stdlib/math.agency:8`).

The four things to change before building:

1. The tutorial teaches two things the brief's rules then forbid.
2. The plan runs `catalog` once per round and the tool lookup once per
   attempt, and each lookup asks for approval to read every local tool
   module.
3. The model picks the name, and a name that is already saved gets
   replaced.
4. Two of the planned tests cannot fail the way they are meant to.

The rest are smaller API and wording points.

## Change before building

### 1. The tutorial contradicts the rules that follow it

The brief's rules say: reply "without the outer `workflow` wrapper and
without `limits`". The tutorial above them shows the opposite:

- Its first example is the saved-file form, `{ "workflow": { ... } }`.
- It has a whole "Setting limits" section with
  `"limits": { "maxTime": 300000, "maxCost": 1 }`.

Decision 5 gives the reason this matters: "small models copy examples."
Task 1 removes only the filename sentence.

Fix, in task 1:

- Show the first example as the bare workflow object, the thing the model
  is asked to write.
- Drop the "Setting limits" section from the designer's tutorial. The
  guide keeps it.
- Task 2's brief test checks for no `"workflow": {` and no `limits`, as it
  already checks for no `workflows/`.

### 2. The tool lookup runs on every attempt, and asks to read each local module every time

The spike computes the catalog once, in `designWorkflow`. The plan moves
`expandRoot` and `catalog` into `draftWorkflow` (task 3), and
`designWorkflow` calls `draftWorkflow` once per round (task 4), so the
catalog is rebuilt every round.

Separately, every attempt runs `_checked`, and `_checked` rebuilds the
signatures: `_compileWithRanges` → `_signatures` → `describeGroup`, which
calls `read(group.module, dir)` for each local module
(`stdlib/workflow.agency:156-162`). That `read` raises `std::read`.

So with 3 rounds of 6 attempts, plus the check inside `writeWorkflow`,
there can be 19 checks, and each one raises `std::read` once per local
tool module. The spike used only `std::math`, which is described from its
re-export line and reads nothing, so it never saw this. BMO's tools are
local modules.

Two consequences:

- Decision 4 says check failures go back to the model "without the user".
  In an interactive run with local tools, the user is asked to approve a
  read on each attempt, unless they answered "always" the first time.
- Each check repeats the `describe` work for every module. Over BMO's
  hundred-plus tools that may be most of the time a round takes.

Fix:

- Split `_checked` into the signature lookup and the rest: a hidden
  `_checkedWith(workflow, refs, signatures, dir)` that `_checked` calls
  after computing `refs` and `signatures`.
- A private `draftFrom(request, entries, refs, signatures, root, revise, options)`
  holds the attempt loop. `draftWorkflow` computes the catalog and
  signatures once and calls it. `designWorkflow` computes them once before
  the round loop and calls it every round.
- Task 5 also times one `_checked` call over BMO's catalog, since that
  cost is paid up to six times per round.

### 3. A designed workflow can silently replace a saved one

The model chooses the name, and `writeWorkflow` replaces a saved workflow
with the same name. The save prompt says "Save the workflow mealPlan?",
which does not say it replaces anything. If the user once answered
"always" for that name (`@always(name)` on `std::workflow::save`), there is
no prompt at all.

Example: the project has `workflows/mealPlan.json`. The user asks for "a
meal plan for a dinner party for eight". The model names the draft
`mealPlan`. The user accepts the draft, and the old workflow is gone.

The spec's non-goals say a revise entry point is later, so a designed
workflow should always be new. Fix: in `designWorkflow`, after a draft
passes the check, test `exists(savedFile(name), root)`. `exists` raises
nothing; `loadWorkflow` uses it the same way before its prompt
(`stdlib/workflow.agency:640`). A taken name becomes one more problem fed
back to the model ("a workflow named mealPlan is already saved; choose
another name"). `draftWorkflow` cannot know a host's names; BMO already
checks name clashes in its own save path (decision 10).

### 4. Two planned tests pass whether or not the code is right

**The wrong-shape test.** Task 3: "a mock reply of the wrong shape →
failure without a second call." If the code wrongly retried, the second
`llm()` call would find no mock, and `DeterministicClient` throws "no mock
provided for llm() call #2" (`lib/runtime/deterministicClient.ts:263`).
That is also a failure, so the test passes either way. Assert on the
failure message (it names the wrong shape), not just that it failed.

**The edited-workflow-fails test.** Task 4 wants to check that the second
model call's brief "carries the problem", "captured through a third test
hook or the printed line". The mock client records nothing about the
prompt, and no third hook exists. Fix: put the conversion from a failed
edit to a `DraftProblem` in a small pure function, and test that function
directly. The `designWorkflow` test then only checks that a second mock
was used and its draft is what lands.

Related: in "six invalid mocks → failure whose message holds the last
problem", make the six mocks fail in different ways, so the test can tell
the last problem from the first.

## Smaller points

### 5. The LLM step bug lands on the designer's first users

Task 7 files the `output: "string"` bug (the step returns
`{"response": "..."}` as text) and leaves it out of this PR. The designer
makes that bug common. Task 1 adds an LLM step section to the tutorial,
and "summarize this in one sentence" is the first LLM step most requests
ask for. Fix the generator first, or at least land the fix before the
guide section that tells people to use the designer.

### 6. The API has two ways to say "revise from this draft"

- `draftWorkflow` takes `previous: string` and `feedback: string`.
- `workflowDesignBrief` takes `problem: DraftProblem | null`.
- `designWorkflow` carries a `DraftProblem` between rounds (task 4), so it
  has to unpack it to call `draftWorkflow`.

`previous` also means two things: JSON text in `draftWorkflow`, a
`Workflow` object in the review payload. Use the one type everywhere:

```
export def draftWorkflow(request: string, tools: any[], dir: string,
                         revise: DraftProblem | null = null,
                         model: string = "", provider: string = "")
  : Result<WorkflowDraft>
```

A host with its own review then passes
`{ draft: JSON.stringify(shown), problems: userText }`.

### 7. `attemptDraft` has two kinds of failure in one type

Task 3 gives `attemptDraft` the type `Result<WorkflowDraft, DraftProblem>`,
then says a wrong-shape structured reply "is a plain failure". The caller
can tell the two apart only by checking whether the failure data is null,
and the type says it is never null.

The simplest fix: `llmOptions` already takes `validationRetries`
(`stdlib/agents/lib/shared.agency:41`). Pass `validationRetries: 1`, so
the client retries a malformed structured reply itself. A reply that is
still malformed is a plain failure that ends the call. Every other
failure from `attemptDraft` is a `DraftProblem`, and the type matches.

As it stands, one malformed reply in round 3 throws away two rounds of the
user's feedback. One retry costs little against that.

### 8. Tell the reviewer which round it is

The review payload has no round number. With `maxRounds: 3`, feedback
given in round 3 is never drafted: the loop ends and the call fails with
"no draft was accepted in 3 rounds". `designSkill` behaves the same way,
so this follows precedent. Adding `round` and `maxRounds` to
`std::workflow::review` lets a host or the prompt say "last round: accept
or reject", which costs two fields.

### 9. Say that a policy rule cannot accept a draft

The review is a raise that expects a value, and `stdlib/policy.agency:1130-1144`
refuses to let a policy rule approve one. So `--approve std::workflow::review`
does not auto-accept drafts. Only a handler or a person can. The
workflows spec review asked for this sentence
(`docs/superpowers/specs/2026-10-26-workflows-design-REVIEW.md`, "Interrupts
that expect a value"). Add it to decision 7, since it is why the save, and
not the review, is the interrupt a policy pins.

### 10. Strip null optionals in `writeWorkflow`

Decision 11 strips `limits: null` and `raises: null` in the designer. Every
`Workflow!` validation fills them, including the one inside `loadWorkflow`
(`const saved: SavedFile! = parsed.value`). So loading a workflow and
saving it again writes `"limits": null` too, and so would BMO's save path.
Put `withoutNullOptionals` beside `writeWorkflow` and call it there, so all
saves are clean. The designer can still call it before the review, so the
payload a host shows is clean too.

### 11. The interactive renderer can show a diff

The payload carries `previous` "so a host can diff". The toolbox renderer
already diffs its previous and current source with `renderSourceDiff`
(`stdlib/policy.agency:771-779`). Do the same on the two workflows as
indented JSON, and print the full JSON only on the first round, when
`previous` is null. Add `workflow`, `previous`, and `warnings` to
`PROMPT_HIDDEN_FIELDS`, or the field table prints them a second time.
Also, the `std::workflow::save` prompt that follows prints the whole
workflow again through the generic table. That is outside this PR but
worth knowing when trying the prompt in the verification step.

### 12. Capability tags on the new functions

The plan lists `raises` clauses (in the spec) but no `@capabilities` tags.
The spike has them. `attemptDraft`, `draftFrom`, and `draftWorkflow` need
`fileRead`, because they call `catalog` and `_checked`. `designWorkflow`
needs `fileRead, fileWrite, subprocess`, because it calls `writeWorkflow`.
Name them in tasks 3 and 4.

### 13. `llmOptions` adds `std::skills` to what `std::workflow` imports

There is no cycle: nothing that `std::agents/lib/shared` imports imports
`std::workflow`. But `shared.agency` imports `std::skills`, which
`designSkill` avoids on purpose (`stdlib/skills.agency:664`). The spike's
local `designOptions` is nine lines. Either is fine. If you keep
`llmOptions`, point 7 gives it a use the local copy does not have.

### 14. The guide edit drops a sentence people need

The working-tree edit to `docs/site/guide/workflows.md` removes "The outer
`workflow` field is the saved-file format. The object inside it is the
workflow itself." Task 1 says to keep the working-tree edits. A person
writing a file by hand needs that sentence, and the designer's tutorial is
a separate text now. Restore it in the guide.

### 15. An edited workflow that fails the check

Decision 6 sends a failed edit to the model as the previous draft, so the
user next sees the model's version, not their own edit with the problems
listed. That is a fair choice for a first version. Add one sentence to the
guide section: a GUI host should run `checkWorkflow` on the edit before
sending it back, so the person fixes their own edit.

### 16. Task 5 and the tickets

- Task 5 runs in BMO "after `pnpm run build-agent`". BMO needs the
  unreleased `draftWorkflow` and `workflowDesignBrief`. Say whether that is
  a local link to this checkout or a release first.
- The plan is one PR, but tickets 1 to 3 split it three ways. One ticket
  for the PR, plus the BMO measurement and the BMO designer, matches the
  work.
- The dev doc is already listed in `CLAUDE.md:349` and
  `.claude/skills/agency-stdlib-docs/SKILL.md:28`. Task 6 extends those
  two lines. It does not add new ones.
