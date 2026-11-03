# The workflow designer: an agent that drafts a workflow from a request

Linear ticket ADI-259. The workflows spec
(`docs/superpowers/specs/2026-10-26-workflows-design.md`, decision 9) left
the designer out of the first version. This spec brings it in. A spike of
the design below ran on 2026-11-03 and is described under "What the spike
showed".

## The problem

A workflow is written by hand or by a GUI. Both need the person to know the
format, the tools, and the reference syntax. Most people who want a workflow
can say what it should do in a sentence. BMO's users will say it in chat.
Something has to turn the sentence into checked JSON, show it, take
corrections, and save it.

Two stdlib agents already do this for other artifacts. `designTool` in
`std::toolbox` drafts an Agency module with a coding agent, checks it, shows
it in a review interrupt, and saves it behind a save gate. `designSkill` in
`std::skills` shows a draft the caller wrote, redrafts it on feedback with
one model call, and saves it through `writeSkill`. The workflow designer is
the same loop, and the differences are in what a workflow is: data, not
code, with a checker that already names every problem by step and field.

## How it works

```
designWorkflow(request, tools, dir)
  │
  ├─ catalog, signatures, saved names   once, what the steps may call
  ├─ brief = tutorial + catalog + request
  │
  │  ┌─ round ─────────────────────────────────────────────┐
  │  │  attempt: llm(brief) → JSON → Workflow! → check      │  up to 6,
  │  │     → name not already saved                         │  without the user
  │  │     problems go back into the brief                  │
  │  │                                                       │
  │  │  std::workflow::review { workflow, warnings, … }      │
  │  │     accept → writeWorkflow (std::workflow::save)      │
  │  │     feedback text → next round                        │  up to 3 rounds
  │  │     an edited workflow → _checked → save              │
  │  └───────────────────────────────────────────────────────┘
  └─ Result<WorkflowEntry>
```

The user sees a draft only after it has passed the check. The model sees
the check's problems only when a draft failed it. The save is the one
interrupt a policy can pin, and it is raised for every workflow that
lands, as it is today.

## Decisions, and why

**1. It lives in `std::workflow`, not `std::toolbox`.** *Why:* it is built
from `catalog`, `_checked`, and `writeWorkflow`, and from the tutorial text
that already lives there. Putting it in the toolbox would make the toolbox
import the workflow module for one function.

**2. The task is a sentence, and the tools are the usual list.** The
signature is

```
designWorkflow(request: string, tools: any[], dir: string,
               maxRounds: number = 3, model: string = "", provider: string = "")
  : Result<WorkflowEntry>
```

`request` says what the workflow should do and, where known, what changes
between runs. `tools` and `dir` are what every `std::workflow` function
takes: original exported Agency functions and the project directory. The
designer runs `catalog(tools, dir)` and renders each entry into the brief
(module, name, docstring, each parameter with its type and default, the
return type, the effects), so the model has exactly what a step needs,
including the `module` string. The same list feeds `_checked`, so a draft
that names a tool outside it is a check problem, not something the user
sees. *Why:* the caller holds the context of what was asked. In BMO that is
the chat model passing on the user's words; at the CLI it is the person.
Neither needs to hand over a transcript.

**3. The draft is one structured model call, not a coding agent.** A
workflow is JSON with a zod schema behind it. The model is asked for the
workflow as JSON text inside a structured reply, `{ workflowJson: string }`.
The designer parses it, validates it as `Workflow!`, and runs `_checked`.
*Why:* `designSkill`'s single `redraft` call is the right precedent.
`designTool` needs a coding agent because a tool is code that has to be
written, typechecked, and tested in a loop; a workflow has none of that.
The reply is text rather than `Workflow!` directly because `Workflow`
holds `Json` fields, and the open schemas those produce are refused by
Anthropic and OpenAI (the toolbox hit the same wall with its test cases).
The call is made with one validation retry, so a reply that is not the
structured shape is retried by the client; a reply still malformed after
that ends the call, because the provider and not the draft is wrong, and
the user's earlier feedback is not thrown away for one bad reply.

**4. Check failures go back to the model without the user.** A draft that
is not JSON, has the wrong shape, or fails `_checked` becomes the next
attempt's feedback: the previous draft and the problems, by step and field,
appended to the brief. Up to six attempts per round, the toolbox's
`CHECK_ATTEMPTS`. *Why:* a check problem is a fact, and the user cannot
act on it. In the spike the first draft with an LLM step failed the check
twice over (`context` was not a list, `output` was not a type), the problems
went back, and the redraft passed. The user never saw it.

The catalog and the tool signatures are computed once per call, before the
first attempt, and every attempt checks against them. `_checked` as it
stands rebuilds the signatures each time, and that reads every local tool
module through `std::read`; with up to six attempts a round, the user would
be asked to approve the same reads on each one, and the describe work would
be repeated over BMO's hundred-plus tools. The check is split so the attempt
loop reuses what the call already has.

**5. The brief is three parts in a fixed order.** The tutorial, the
rendered catalog, the request with its rules. The tutorial is the text now
in `stdlib/workflow.agency` as `WORKFLOWS_TUTORIAL`, with these changes:
the first example is the bare workflow object, not the saved-file form
`{ "workflow": { ... } }`, and the "Setting limits" section comes out, since
the rules below ask for exactly the opposite of both and a tutorial should
not teach what the rules forbid; the "Adding an LLM step" section from the
guide goes in (the spike's first LLM-step draft failed for want of it); the
filename rule comes out (a designer never names files, and BMO stores
rows); the `"Hello, ${name}!"` example is escaped (unescaped it is
interpolated by the `"""` string, and the module failed to load). The brief says outright that the tutorial's
`std::math` examples are about the format and the only callable tools are
the ones listed. *Why:* small models copy examples. The rules are: values
that change from run to run are inputs and everything else is a literal;
pick a short camelCase identifier and a one-sentence description; reply
with the workflow object only, without the outer `workflow` wrapper and
without `limits`.

**6. The review takes accept, feedback, or an edited workflow.** The
`std::workflow::review` effect carries the draft, the previous draft (so a
host can diff), the check's warnings, the attempt count, and the round
number with the maximum, so a host or the prompt can say that feedback in
the last round will not be drafted. The answer is
a bare approval or `accept` to save; text for a redraft; or a workflow
object, which is checked and, if it passes, saved without another model
call. An edited workflow that fails the check goes to the model as the
previous draft with the problems as feedback. Up to `maxRounds` reviews,
three by default. *Why:* the toolbox takes only text because its CLI prompt
is a typed line. A workflow is data a GUI can edit, and BMO already has the
precedent: the recipe import review returns the edited draft on the
approval, and the tool re-checks what came back before writing. A rejection
fails the call and writes nothing. A GUI host should run `checkWorkflow` on
an edit before sending it back, so the person fixes their own edit rather
than seeing the model's version of it.

**7. Accept raises two interrupts.** The review, then `std::workflow::save`
from `writeWorkflow`. *Why:* the same reasoning as the toolbox and skills.
The review is where the user shapes the workflow; the save is the one
effect a policy can pin, and it is raised for every workflow that lands
whichever way it was made. The review expects a value, and a policy rule
cannot approve a raise that expects one (`stdlib/policy.agency` refuses it,
because a bare yes would accept a draft nobody looked at), so
`--approve std::workflow::review` does not auto-accept drafts. Only a
handler or a person answers the review.

**8. A missing fact becomes an input, not a guess.** The brief tells the
model that when the request leaves out something a step needs, such as
which list or which folder, it makes that an input and says so in the
description. *Why:* the toolbox gives its coding agent a `question` tool,
which works because the agent has a tool loop. The designer's draft is one
structured call with no tools. An input the user did not expect is visible
at the review, and feedback fixes it in one round. A `question` tool for
the drafting call is a later piece if this proves too blunt.

**9. No trial run in the first version.** The designer checks, reviews,
and saves. The first real run, with the steps' own approvals, is the test.
*Why:* the toolbox generates tests only for pure tools, and almost no
workflow is pure. A later version can run a draft before saving when every
step's effects are reads, which the check can tell from the effects list.

**10. The host's storage is the host's.** `designWorkflow` saves through
`writeWorkflow`, into `<dir>/workflows/`. A host that stores workflows
elsewhere, as BMO does in a table, uses the exported `draftWorkflow`,
which is the brief, the model call, and the check loop with no interrupts
of its own beyond the reads `catalog` and `_checked` raise, and runs its own
review and save. *Why:* `std::skills` is split the same way, and BMO's save
path already applies rules the stdlib cannot know (the session step, name
clashes with chat tools, a 422 with problems).

**11. Optional fields nobody wrote are not saved.** `Workflow!` validation
fills `limits` and `raises` with `null` when they are absent, and every
save path validates: the designer, `loadWorkflow`, BMO's own. So
`writeWorkflow` strips null optionals before its check, and the designer
strips them again before the review so the payload a host shows is clean.
*Why:* the spike's saved files carried `"limits": null, "raises": null`
that no one wrote, and a workflow loaded and saved again would carry them
too.

**12. The designer does not resume drafts across calls.** *Why:* the
toolbox keeps an unaccepted draft for the session because a tool costs
minutes to write. A workflow draft is one model call.

**13. A designed workflow is always new.** The model picks the name, and
`writeWorkflow` replaces a saved workflow with the same name without
saying so; with an `always` answer on the save for that name there is no
prompt at all. So after a draft passes the check, `designWorkflow` checks
the name against the files in `<dir>/workflows/`, and a taken name is one
more problem fed back to the model, like a check failure. *Why:* revising
a saved workflow is a non-goal, so a design must never replace one by
accident. `draftWorkflow` cannot know a host's names; BMO checks clashes
in its own save path (decision 10).

## Goals

- From a sentence and a tool list, a checked workflow the user has seen.
- Every problem the checker can name is fixed before the user is asked.
- The user can accept, redirect in words, or hand back an edited workflow.
- A host with its own storage can reuse the drafting without the saving.

## Non-goals

- A trial run before saving (decision 9).
- Writing a workflow from a past run's log. Still later, as the workflows
  spec said.
- An `agency workflow design` CLI command. It is a thin wrapper over
  `designWorkflow` and can follow once the function is in.
- Revising a saved workflow. `designWorkflow` with the same name replaces
  it through `writeWorkflow`, as any save does; a "revise this one"
  entry point that starts from the saved JSON is a later piece.

## Public API

```
export def designWorkflow(request: string, tools: any[], dir: string,
                          maxRounds: number = 3, model: string = "", provider: string = "")
  : Result<WorkflowEntry>
  raises <std::workflow::review, std::workflow::save, std::read, std::run, std::guard>

export def draftWorkflow(request: string, tools: any[], dir: string,
                         revise: DraftProblem | null = null,
                         model: string = "", provider: string = "")
  : Result<WorkflowDraft>
  raises <std::read>

export type WorkflowDraft = {
  workflow: Workflow;
  warnings: WorkflowProblem[];
  /** Model calls the draft took to pass the check. */
  attempts: number
}

effect std::workflow::review {
  name: string;
  workflow: Workflow;
  /** The draft the previous round showed, or null on the first. */
  previous: Workflow | null;
  warnings: WorkflowProblem[];
  attempts: number;
  round: number;
  maxRounds: number
}

/** One shape for every "revise from this": a failed attempt's draft as
  the model wrote it and what was wrong with it; the user's feedback with
  the draft they saw; an edited workflow that failed the check with its
  problems. A host with its own review passes
  `{ draft: JSON.stringify(shown), problems: userText }`. */
export type DraftProblem = { draft: string; problems: string }

export def workflowDesignBrief(request: string, entries: CatalogEntry[],
                               problem: DraftProblem | null = null): string
```

`workflowDesignBrief` is exported so a host can read what the model will
be told, and so BMO can measure the brief over its full catalog.
`draftWorkflow` carries `@capabilities(fileRead)`; `designWorkflow`
carries `fileRead, fileWrite, subprocess`, as `writeWorkflow` does.

## What the spike showed

Run on 2026-11-03 with Gemini 3.8 Flash over `add`, `subtract`,
`multiply`, `divide`, and `round` from `std::math`, with the review
auto-accepted.

| Request | Model calls to pass the check | Design and save | Run | Result |
| --- | --- | --- | --- | --- |
| Average of three numbers, rounded to two places | 1 | 13.9 s | 0.3 s | 2.33 |
| Percentage price change, plus one sentence | 2 | 55 s | 4.8 s | "The price went up by 25 percent." |

Both workflows were right: the right inputs, the right steps, the right
references. The second needed a redraft because the tutorial had no LLM
step section (decision 5). Two things to watch:

- **The brief grows with the catalog.** Five tools is a small prompt. BMO's
  `workflowTools()` is fourteen apps and over a hundred tools. The plan
  measures the brief's size and the first-draft time over BMO's catalog
  before the BMO side is built.
- **An LLM step with `output: "string"` returns a JSON string** of
  `{"response": "..."}` rather than the sentence. Traced on 2026-11-03 to
  the compiler, not the generator: `const x: string = llm(...)` gets no
  response schema, while `type Aliased = string; const x: Aliased = llm(...)`
  gets `{ response: Aliased }` and the text comes back wrapped. Every
  workflow LLM step is declared through such an alias. The designer makes
  that step common, so the fix lands first, as its own small PR.

## Left to the builder

- The exact text of the brief's rules. The spike's wording is in
  `stdlib/workflow.agency` and worked for both requests.
- How the interactive prompt renders the review payload. `stdlib/policy.agency`
  has renderers for the toolbox and skills reviews; the workflow one prints
  the workflow as indented JSON on the first round and a diff against the
  previous draft after that, with the warnings under it.
