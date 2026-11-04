# Workflow designer — Implementation Plan

**Goal:** `designWorkflow(request, tools, dir)` in `std::workflow` drafts a workflow from a sentence with one structured model call, feeds check problems back to the model without the user, shows a checked draft in a `std::workflow::review` interrupt that takes accept, feedback, or an edited workflow, and saves through `writeWorkflow`. `draftWorkflow` and `workflowDesignBrief` are exported for hosts with their own storage.

**Architecture:** Everything is in `stdlib/workflow.agency`, below the saving functions, as pure defs plus two functions with interrupts. The tutorial becomes the first part of the brief; `renderCatalog` turns `catalog`'s entries into the second; the request and its rules are the third. The catalog and the tool signatures are computed once per call and handed down: `_checked` is split so the attempt loop checks a draft against signatures it already has, without rereading the tool modules. `attemptDraft` is one attempt (parse, `Workflow!`, strip null optionals, check, name clash) and reports a failure as a `DraftProblem`; `draftFrom` loops it over one model call per attempt, carrying one problem between attempts; `draftWorkflow` wraps `draftFrom` for hosts, and `designWorkflow` is the round loop over it (review, then `writeWorkflow`). The review's rendering for the interactive prompt goes beside the toolbox and skills renderers in `stdlib/policy.agency`.

**Tech Stack:** Agency in `stdlib/workflow.agency` and `stdlib/policy.agency`; `agency test` fixtures under `tests/agency/workflow/` with `llmMocks`; docs under `docs/dev/stdlib/`, `docs/site/stdlib/`, `docs/site/guide/`.

**Spec:** `docs/superpowers/specs/2026-11-03-workflow-designer.md`. Review: `docs/superpowers/plans/2026-11-03-workflow-designer-review.md` (every point is folded in below). Linear ticket ADI-259.

**Depends on:** task 0, a separate small PR that lands first. The designer PR is based on main after it. The spike code now in the working tree (`designWorkflow` and the tutorial at the end of `stdlib/workflow.agency`, and the edits to `docs/site/guide/workflows.md`) is the starting point, not a finished task.

## Background

- **The spike.** `stdlib/workflow.agency` in the working tree ends with `WORKFLOWS_TUTORIAL` and a `designWorkflow` that ran twice on 2026-11-03 (the spec's table). It reads as the shape of tasks 2 to 4 and has these known gaps: the tutorial lacks the LLM step section and shows two things the rules forbid (the saved-file wrapper and `limits`); `Workflow!` leaves `limits: null, raises: null` in the saved file; the review accepts only text; `draftWorkflow` is not exported with a clean signature; the catalog is built once but `_checked` rereads every local tool module on every attempt; a draft can take the name of a saved workflow. The host program that drove it is in a scratch directory, not the repo.
- **Precedents.** `designSkill` in `stdlib/skills.agency` (around line 676, `redraft`, `askUser`, and the `ACCEPT` constant) is the loop shape: one structured `llm()` call, a review interrupt whose answer is null for a bare approval or text for feedback, `maxRounds`. `designTool` in `stdlib/toolbox.agency` has `CHECK_ATTEMPTS` (line 799) and `feedbackSection` (line 515) for feeding problems back, and `progress` (line 790) for the `print` lines.
- **The check.** `_checked(workflow, tools, dir)` is `_compileWithRanges` (which computes `_toolRefs` and `_signatures`, then `_compileWorkflowSource(workflow, refs, signatures)`) followed by `_typecheckTrusted` and `_compileTrusted`. `_signatures` calls `describeGroup` per module, and `describeGroup` calls `read(group.module, dir)` for each local module (`stdlib/workflow.agency:156-175`), which raises `std::read`. `std::` modules are described from their re-export line and read nothing, which is why the spike never saw a prompt. On failure `_checked`'s `data.problems` is a `WorkflowProblem[]` or null (then `error` is the message). `catalog(tools, dir)` returns `CatalogEntry[]` with `module`, `name`, `description`, `params` (`name`, `type`, `default`, `description`, `schema`), `returns`, `effects`. `exists(path, root)` raises nothing; `loadWorkflow` uses `exists(savedFile(name), root)` before its prompt (line 640).
- **Structured output.** `const reply: T! = llm(brief, options)` returns a `Result`; `failure(shapeErr)` binds the message. `llmOptions(model, provider, validationRetries)` in `std::agents/lib/shared` (line 41) builds the options; with `validationRetries: 1` the client retries a malformed structured reply once itself. `try JSON.parse(text)` returns a `Result`. `const workflow: Workflow! = value` validates data the same way and fills absent optional fields with null.
- **Interrupt answers.** `const answer = interrupt std::x::review(message, data)` yields the approval's value: null for a bare `approve()`, the value for `approve(value)`. A policy rule cannot approve a raise that expects a value (`stdlib/policy.agency:1130-1144`), so only a handler or a person answers the review.
- **Tests.** `tests/agency/<dir>/<name>.agency` with `<name>.test.json`: one row per node, `useTestLLMProvider: true` and `llmMocks: [{ return: {...} }]` per row for model calls (see `tests/agency/skills-design.test.json`). A test node handles its own interrupts with `handle ... with (intr)`. When the code makes more `llm()` calls than there are mocks, `DeterministicClient` throws "no mock provided for llm() call #N" (`lib/runtime/deterministicClient.ts:263`), which is a failure like any other, so a test about "no second call" must assert on the failure message. The mock client records nothing about the prompt it was given. Workflow tests live in `tests/agency/workflow/`; `catalog.agency` is the one that already passes `std::math` tools.
- **Already there.** `describeProblem(problem)` in `lib/stdlib/workflow/index.ts:59` prints a problem as `step X, field: message` (the CLI's `formatProblems` uses it), so the stdlib reaches it through `agency-lang/stdlib-lib/workflow/index.js`. `llmOptions` is in `std::agents/lib/shared`; `std::workflow` is not in that module's import closure, so there is no cycle. `shared.agency` imports `std::skills`, which `designSkill` avoids on purpose (`stdlib/skills.agency:664`); that is a different cycle and does not apply here. `llmOptions` is used rather than a local copy because `validationRetries` is needed.
- **Rendering interactive prompts.** `stdlib/policy.agency:768` renders `std::skills::review` and `std::toolbox::review` payloads; the toolbox one diffs `previous` against `source` with `renderSourceDiff` (lines 771-779). `PROMPT_HIDDEN_FIELDS` (line 844) lists the fields each effect prints above the prompt so the generic field table leaves them out.
- **Docs indexes.** `CLAUDE.md:349` and `.claude/skills/agency-stdlib-docs/SKILL.md:28` already list `docs/dev/stdlib/workflow.md` with one line each; `docs/site/stdlib/workflow.md` is the reference page; `docs/site/guide/workflows.md` the guide.
- **Build and test.** `make stdlib` compiles the stdlib with the built compiler; `node dist/scripts/agency.js test tests/agency/workflow` runs the workflow fixtures; `pnpm run typecheck`; `pnpm run fmt:ts` before pushing (CI fails without it; it does not touch `.agency` files).
- **BMO.** BMO depends on the published package (`agency-lang: "0.37.0"` in `package.json`, bumped by a commit like `b18f5aaa bump agency to v0.36.0`). Anything BMO measures or builds against this work follows a release.

## Global constraints

- Nothing new reaches disk except through `writeWorkflow`. A rejected review or save writes nothing.
- The user is shown only a draft that passed the check and whose name is not already saved.
- `draftWorkflow` raises nothing of its own: the reads `catalog` and `_signatures` raise, once each, are the only interrupts, so a host can call it under a policy that approves reads.
- One model call per attempt, plus at most one client-side retry for a malformed structured reply. The accept path and the edited-workflow path make no model call.
- No `limits` in a draft. The brief says so, and null optionals are stripped; a host adds limits at its own save, as BMO's `DEFAULT_WORKFLOW_LIMITS` does.
- `@capabilities` on every new function that reads or writes: `fileRead` on `attemptDraft`, `draftFrom`, `draftWorkflow`, and `_checkedWith`; `fileRead, fileWrite, subprocess` on `designWorkflow`, because it calls `writeWorkflow`.

## Task 0: an `llm()` declared with an alias of a primitive type (separate PR, first)

**Files:** `lib/backends/typescriptBuilder.ts` (around line 3826, where `zodSchemaFor(_variableType)` is compared with `DEFAULT_SCHEMA`), a test beside the existing codegen tests for `llm()` schemas, `changelog.md`.

- Repro, six lines: `type Aliased = string`, then `const plain: string = llm("Reply with exactly the word hello")` prints `"hello"` while `const aliased: Aliased = llm(...)` prints the JSON text `"{\"response\":\"hello\"}"`. The compiled output shows why: the alias gets `responseFormat: z.object({ response: Aliased })` and the plain `string` gets no `responseFormat` at all.
- Every workflow LLM step is declared through an alias (`type Step_<id>_output = <output>` and `const reply: Step_<id>_output = llm(...)`, `lib/stdlib/workflow/lower.ts:147-176` and `shapes.ts:38`), so a step with `output: "string"` always hits this. The designer's tutorial teaches that step, and "one sentence about the result" is the first LLM step most requests ask for, so this lands before the designer and not after.
- Fix in the compiler, not the generator: resolve the declared type through its aliases before deciding whether the call gets a schema, so an alias of a primitive compiles the way the primitive does. The alias resolution already exists for `mapTypeToValidationSchema(resolved, aliases, aliasesFull)` (line 1095). Leave `extractStructuredResponse` alone.
- **Test:** a codegen test that an `llm()` declared with an alias of `string` emits no `responseFormat`, and one that an alias of an object type still does.

## Task 1: the tutorial is the first part of the brief

**Files:** `stdlib/workflow.agency` (the `WORKFLOWS_TUTORIAL` constant), `docs/site/guide/workflows.md`.

- Show the first example as the bare workflow object, the thing the model is asked to write. The saved-file form `{ "workflow": { ... } }` does not appear in the tutorial.
- Drop the "Setting limits" section. The guide keeps it.
- Add the "Adding an LLM step" section from the guide, after "Passing values between steps": the step object with `prompt`, `context`, `output`, the three facts (prompt text is literal, context values are labelled, `output` is a type as text), and `context: []` when there is none.
- Remove the sentence about the name matching the filename and the `workflows/doubleSum.json` reference. The tutorial describes the format only.
- Keep the `\${name}` escape in the `greet` example. Add a comment above the constant saying the text is interpolated and `${` must be escaped.
- Rename it `DESIGN_TUTORIAL` and keep it `static const`, not exported; `workflowDesignBrief` is the export.
- In the guide, restore the sentence the working tree removed: "The outer `workflow` field is the saved-file format. The object inside it is the workflow itself." A person writing a file by hand needs it; the designer's tutorial is a separate text now. Keep the other working-tree edits.

**Test:** none of its own; task 2's brief test checks the sections and the absences.

## Task 2: the catalog rendering and the brief

**Files:** `stdlib/workflow.agency`, `tests/agency/workflow/design-brief.agency` and `.test.json`.

- `renderParam(param: CatalogParam): string` → `  - name: type = default — description`, with `any` for a null type and the default and description left out when null.
- `renderEntry(entry: CatalogEntry): string` → a `###` heading with the name and `(module "...")`, the description, `Parameters:` with the rendered params or `(none)`, `Returns:`, `Effects:` with `none` for an empty list.
- `export type DraftProblem = { draft: string; problems: string }`: a draft as text and what was wrong with it. One type for every "revise from this": a failed attempt, the user's feedback on a draft they saw, an edited workflow that failed the check.
- `revisionSection(problem: DraftProblem | null): string` → empty for null, else the previous draft, what was wrong with it, and "write a new draft that fixes every point above and keeps what was right". The toolbox's `feedbackSection` is not reused: it is about a reviewer agent and a coding brief, and shares no text with this.
- `export def workflowDesignBrief(request, entries, problem: DraftProblem | null = null): string` → the tutorial, the catalog under a heading that says the examples above use tools that may not exist here and a step may call only the tools below by the exact module and name, the request, the rules (inputs are what changes between runs; a fact the request leaves out becomes an input named in the description; a short camelCase name and a one-sentence description; the workflow object only, no outer wrapper, no `limits`), then the revision section.

**Tests:** a node that builds the brief from `catalog([add, round], "")` and checks it contains `std::math`, `add`, `round`, `precision: number = 0`, the LLM step heading, and none of `workflows/`, `"workflow": {`, or `limits`; a node with a `DraftProblem` checks the revision section is last.

## Task 3: the check without rereads, `attemptDraft`, `draftFrom`, `draftWorkflow`

**Files:** `stdlib/workflow.agency`, `tests/agency/workflow/design-draft.agency` and `.test.json`.

- Split `_checked`: a hidden `_checkedWith(workflow, refs, signatures, dir): Result<Checked, WorkflowFailure>` does `_compileWorkflowSource`, the typecheck, and the compile; `_checked` computes `_toolRefs` and `_signatures` and calls it. `_compileWithRanges` stays for `compileWorkflow`. Nothing else changes behavior.
- `type WorkflowDraftReply = { workflowJson: string }`, `export type WorkflowDraft = { workflow: Workflow; warnings: WorkflowProblem[]; attempts: number }`, `static const DESIGN_ATTEMPTS = 6`.
- `withoutNullOptionals(workflow: Workflow): Workflow` removes `limits`, `raises`, and `result` when null. Steps are untouched. It sits beside `writeWorkflow`, which calls it before its check, so every save is clean, including `loadWorkflow` round trips and BMO's save path; the designer also calls it before the review so the payload a host shows is clean.
- `problemsText(failed): string`: one `- ` line per problem through `describeProblem` from `agency-lang/stdlib-lib/workflow/index.js`, or the failure's `error` when `data.problems` is null. No new formatter.
- `attemptDraft(text, refs, signatures, root, savedNames): Result<WorkflowDraft, DraftProblem>`: `JSON.parse`, `Workflow!`, strip nulls, `_checkedWith`, then the name: when `savedNames` says the name is taken, the problem is "a workflow named X is already saved; choose another name". Each failure point returns a `DraftProblem` with the text the model wrote. This is the one place that knows the stages. The model call is not in here, so every failure it returns is a `DraftProblem` and the type is honest.
- `draftFrom(request, entries, refs, signatures, root, savedNames, revise: DraftProblem | null, options): Result<WorkflowDraft>`: a loop of at most `DESIGN_ATTEMPTS` over one `let problem: DraftProblem | null` seeded from `revise`: build the brief, `const reply: WorkflowDraftReply! = llm(brief, options)` with `?` (a reply still malformed after the client's own retry ends the call, since the provider and not the draft is wrong), `attemptDraft`, return a success with `attempts` set, or print one line and carry the new problem. After the last attempt, fail with the last problem's text. The loop holds no other state.
- `savedNames: string[]` is the names in `<root>/workflows/`, listed once at the start of the call. `draftWorkflow` passes an empty list because it cannot know a host's names (BMO checks clashes in its own save path); `designWorkflow` passes the listing.
- `export def draftWorkflow(request, tools, dir, revise: DraftProblem | null = null, model = "", provider = ""): Result<WorkflowDraft>`: `expandRoot(dir)`, `catalog`, `_toolRefs`, `_signatures`, `llmOptions(model, provider, validationRetries: 1)`, then `draftFrom`. A host with its own review passes `{ draft: JSON.stringify(shown), problems: userText }`.
- The spike's narrowing: after `if (x is failure(...)) { continue }` the typechecker does not narrow, so use `if (workflow is success(drafted)) { ... }`.

**Tests, each with `useTestLLMProvider` and `llmMocks`:** one mock whose `workflowJson` is a valid two-step `std::math` workflow → a draft with `attempts: 1`, no `limits` key; a first mock that names a tool not in the list and a second that is valid → `attempts: 2`; a mock that is not JSON then a valid one → `attempts: 2`; six mocks that each fail differently (not JSON, wrong shape for `Workflow!`, unknown tool, bad reference, wrong argument type, a taken name) → failure whose message holds the sixth problem and not the first; a mock reply of the wrong structured shape → failure whose message names the shape error, not "no mock provided for llm() call #2". A pure test of `withoutNullOptionals` and of `attemptDraft` with a taken name.

## Task 4: the review and `designWorkflow`

**Files:** `stdlib/workflow.agency`, `stdlib/policy.agency`, `tests/agency/workflow/design.agency` and `.test.json`.

- `effect std::workflow::review { name; workflow; previous: Workflow | null; warnings; attempts; round; maxRounds }` with a docstring saying the answer is a bare approval or `accept`, feedback text, or an edited workflow, and that a policy rule cannot approve it. `round` and `maxRounds` let a host or the prompt say "last round: accept or reject", since feedback given in the last round is never drafted.
- `static const ACCEPT_DESIGN = "accept"`.
- `reviewAnswer(answer: any): Result<ReviewAnswer>` where `ReviewAnswer` is `{ kind: "accept" } | { kind: "feedback"; text: string } | { kind: "edited"; workflow: Workflow }`: null or `accept` → accept; a string → feedback, refused when blank; an object → `Workflow!`, refused with the shape error otherwise; anything else refused.
- `editProblem(edited: Workflow, failed): DraftProblem`, pure: the edit as JSON and `problemsText(failed)`. `feedbackProblem(shown: Workflow, text): DraftProblem` the same for feedback. Both are what the next round's `revise` is made of, and both are tested directly, since the mock client cannot show what brief the model saw.
- `export def designWorkflow(request, tools, dir, maxRounds = 3, model = "", provider = ""): Result<WorkflowEntry>`: `expandRoot`, `exists` (as `writeWorkflow` checks), then once: `catalog`, `_toolRefs`, `_signatures`, the saved-name listing, `llmOptions`. Then up to `maxRounds` rounds over one `let revise: DraftProblem | null`: `draftFrom`; print the round line; raise the review. Accept → `writeWorkflow` (which checks once more and raises the save). Feedback → next round with `feedbackProblem`. Edited → strip nulls, `attemptDraft` on its JSON with the same refs, signatures, and names; pass → `writeWorkflow` without a model call; fail → next round with that `DraftProblem`, counting as a round. A rejection → failure, nothing written. After the last round, fail with the last problem's text.
- `stdlib/policy.agency`: a renderer for `std::workflow::review` beside the toolbox one. On the first round (`previous` null) it prints the workflow as indented JSON; on later rounds it prints `renderSourceDiff` of the previous and current workflows as indented JSON; the warnings go under either, one per line through `describeProblem`. Add `workflow`, `previous`, and `warnings` to `PROMPT_HIDDEN_FIELDS` so the field table does not print them a second time. The `std::workflow::save` prompt that follows prints the whole workflow again through the generic table; that is outside this PR.

**Tests:** accept saves (file exists, `WorkflowEntry` returned, one mock consumed); bare approval accepts; feedback redrafts (two mocks, the second's name is what lands); an edited workflow saves without a second mock; an edited workflow that fails the check draws a second mock and the second mock's draft is what lands; `editProblem` and `feedbackProblem` directly, checking the draft text and the problem text; a draft whose name is already in `workflows/` is redrafted (two mocks, the second's name lands, the first file is untouched); rejection at the review writes nothing; rejection at the save writes nothing; `maxRounds: 1` with feedback fails. Each test node cleans up its `workflows/` output under `test-output/`, as the toolbox tests do.

## Task 5: measure the brief and the check over BMO's catalog

**Files:** none committed. A scratch host program in BMO's checkout, after the designer PR is released and BMO's `agency-lang` is bumped to it.

- From `/Users/adit/bmo`, after `pnpm run build-agent && pnpm run build-backend`, a program that imports `workflowTools` from `dist/agent/workflows.js`, calls `rememberUser` for a real user, builds `workflowDesignBrief("...", catalog(workflowTools(), cwd()))`, and prints its length in characters and the time `catalog` took.
- Time one `checkWorkflow` call over the full list with a small valid workflow, since the signatures lookup inside it is what each check paid before task 3 and what `designWorkflow` now pays once.
- Then one `draftWorkflow` over the full list for the meal-plan request, timed.
- Record the numbers in the spec under "What the spike showed". If the brief is over roughly 60k characters or the first draft takes over a minute, note the options for the BMO ticket: a catalog narrowed to the apps the request names, or a two-call design that first picks apps.

## Task 6: docs

**Files:** `docs/dev/stdlib/workflow.md`, `docs/site/stdlib/workflow.md`, `docs/site/guide/workflows.md`, `CLAUDE.md`, `.claude/skills/agency-stdlib-docs/SKILL.md`, `changelog.md`.

- `docs/dev/stdlib/workflow.md`: a "Designing a workflow" section with the loop diagram from the spec, the attempt and round counts, the three review answers, why the reply is text and not `Workflow!`, why the catalog and signatures are computed once, why a taken name is a problem, why null optionals are stripped at save, and the split between `designWorkflow` and `draftWorkflow`.
- `docs/site/stdlib/workflow.md`: reference entries for `designWorkflow`, `draftWorkflow`, `workflowDesignBrief`, `WorkflowDraft`, `DraftProblem`, and the review effect, with the sentence that a policy rule cannot accept a draft.
- `docs/site/guide/workflows.md`: a short "Letting an agent draft a workflow" section with a `designWorkflow` host program, after "Saving workflows and offering them as tools", with one sentence for GUI hosts: run `checkWorkflow` on an edit before sending it back, so the person fixes their own edit instead of seeing the model's version of it.
- Extend the existing index lines for the dev doc in `CLAUDE.md:349` and `.claude/skills/agency-stdlib-docs/SKILL.md:28`; do not add new ones. The changelog entry.

## Verification

- `make stdlib`, then `node dist/scripts/agency.js test tests/agency/workflow` for the four new fixture files and the existing ones (the `_checked` split must leave them green).
- `pnpm run typecheck` and `pnpm run fmt:ts`.
- One real run of the spike's host program with `agency run`, with one local tool module in the list, to see the interactive prompt render the review and to see that the read prompt appears once and not once per attempt.

## Tickets

ADI-259 becomes the parent. One ticket per PR or per piece of work in another repo, in order:

1. The alias bug (Agency): task 0, its own small PR, first.
2. The designer (Agency): tasks 1 to 4 and 6, one PR, then a release and a BMO bump.
3. The BMO measurement: task 5, after the bump, blocking the next ticket.
4. The BMO designer (in the BMO repo): `designWorkflow` as a chat tool over `workflowTools()`, with BMO's own review interrupt that returns the edited draft and BMO's `saveWorkflow`.
