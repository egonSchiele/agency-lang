# Review of `2026-10-26-workflows-design.md`

Reviewed 2026-10-27 against the worktree at `003dfd5d2`. Paths are relative to `packages/agency-lang`.

## Verdict

The design is at the right altitude and the shape is sound. The one rule, the data-only format, and running steps in-process through the tool loop's own invocation path are the right calls, and the spec answers the owner's standing questions (interrupts, isolation, checkpoints) in the right places. Every name it cites exists except where noted below.

Three things should change or be verified before a plan is written:

1. The LLM step's resumability rests on a path (a TypeScript helper calling `agency.llm`) that has no resumable precedent in the codebase. Either prove it or move the model call into Agency.
2. The checker should run arguments through the tool loop's own alias and null handling before validating them, or a workflow copied from a transcript can fail the check while the real run would have passed.
3. The claim that a new step `kind` is not a breaking change contradicts the reader's own rule that it refuses an unknown kind.

The rest is smaller. The open question at the end gets an answer.

## 1. The LLM step and resume (section "An LLM step", "Resuming")

The spec says each step is an Agency statement, so an interrupt inside a step pauses and resumes like any other, and the only TypeScript is "pure parts". But the LLM step is not pure. It is described as a private helper in `lib/stdlib/workflow.ts` that calls `agency.llm(prompt, { schema })`.

The only existing TypeScript caller of `agency.llm` from the stdlib is `_eagerSummarizeIfNeeded` at `lib/stdlib/threads.ts:217`. That one is explicitly best-effort: it swallows every failure and is never resumed. There is no precedent for a model call made from a TypeScript helper that must survive an interrupt.

What can interrupt inside an LLM step with no tools? The cost guard. `docs/dev/runtime/interrupts.md:305-345` describes the guard gate: a trip raises `std::guard` from inside `runPrompt`, and the doc is explicit that raising "from arbitrary TS-helper contexts inside non-idempotent step bodies has the same replay hazard" as raising inside `_runPrompt`. A workflow with `limits.maxCost` is exactly a guard around LLM steps, so this is the common case, not an edge.

Two ways out, in order of preference:

- **Make the model call an Agency `llm()` call.** The spec's reason for the helper is "Agency code cannot hand `llm()` a schema that exists only at run time". Check that claim before building on it. The runtime options record has `schema: any` (`lib/runtime/prompt.ts:123`), and `llm()` takes its options as an object, so `llm(prompt, options)` where `options` is an `any` built by a pure helper (`_zodFromJsonSchema(json)`, using the same `z.fromJSONSchema` that `lib/runtime/createdTool.ts:44` already uses) may work today. If the typechecker refuses an unknown option key, that is a small checker change, far smaller than a second resumable model-call path. The LLM step then becomes an ordinary `thread { llm(...) }` statement in the runner loop, and `validationRetries: 1` is just an option on the call.
- **If the helper stays,** the plan must carry a test: a workflow whose LLM step trips a cost guard, answered with approve, resumed, and the step's value used by the next step. Without that test the resume claim in the spec is unverified.

## 2. The checker versus the tool loop's argument handling (section "Checking a workflow")

The tool loop does two things to a model's arguments before validating them (`lib/runtime/toolInvocation.ts:238-250`, `toolArgumentsFor`): it renames alias keys to the parameter (`url` to `baseUrl`) and it drops a `null` given for a parameter that has a default. The spec says the checker verifies "every argument name is a parameter of that tool" and "every literal argument matches its parameter's schema".

A workflow is written from a transcript of a model's calls, so its arguments are the model's arguments, aliases and nulls included. If the checker tests names against the parameter list directly, a step copied from a successful call can fail the check. The fix is one line of design: the checker runs each step's `args` through `toolArgumentsFor(handler, { arguments: args })` first and validates the result. That is also the same function the run uses, which the spec already wants ("the same test the tool loop applies").

Related: `callFromOutside` (`lib/runtime/toolInvocation.ts:252`) is the right call shape for the run, as the spec says.

## 3. Adding a `kind` is a breaking change (sections "Fields", "Calls I made")

"A reader refuses a version it does not know" and "every `kind` is one the format knows" are both rules of the format. Then "conditionals or loops can be added as new kinds without a breaking change" is false: a format-1 reader refuses a file with a `kind: "if"` step. Either a new kind bumps `format`, or the spec says that a reader refuses an unknown kind and that is the compatibility story. Say which. The honest version is "adding a kind bumps the format; readers refuse newer formats", and that is fine.

## 4. Altitude pass: what already implements these semantics

For each new piece, what exists:

| Piece in the spec | Existing code | Verdict |
| --- | --- | --- |
| Tool invocation for a step | `handler.invoke(run, callFromOutside(args))` inside `runAsToolInvocation` on `invokeOnFreshThreadStore` (`lib/runtime/prompt.ts:1051-1071`) | Reuse exactly this. The spec describes it correctly. |
| Argument validation | `toolArgumentsFor` + the tool's Zod schema (`AgencyFunction.validateForLLM`, `lib/runtime/agencyFunction.ts`) | Reuse; see item 2. |
| Offering a workflow as a tool | `createTool(definition, executor)` (`lib/runtime/createdTool.ts:19`), as `learn` uses it (`lib/stdlib/learnFunctions.ts:34`) | Right choice. The executor is an Agency def taking one record, built as a `partial` of `(workflow, tools, record)`. |
| Tools across a resume | `FunctionRefReviver` (`lib/runtime/revivers/functionRefReviver.ts:28-87`) handles `created`, rename, and `partial` | Verified. One thing the plan must test: the executor partial binds `tools`, an array of function values. Confirm the reviver revives function values nested inside partial bindings, not only at the top level. |
| Save gate, review loop, meta.json, name check, root expansion | `std::toolbox` (`checkNameSyntax`, `expandRoot`, the review-answer parse at `stdlib/toolbox.agency:1274-1297`) and `std::skills` (`stdlib/skills.agency:589-602`) | Share the helpers, do not copy them. The review-answer parsing in particular will be the third copy. |
| Transcript | `transcriptBlocks(trace)` and `transcriptText(block)` (`lib/logsViewer/transcript.ts:240,663`) | Right source. Note `transcriptBlocks` takes a `TreeNode`, which the logs viewer builds from a parsed log. The plan needs the path from a file and trace id to that tree; the stdlib readers in `lib/stdlib/statelog.ts` go through `StatelogParser`, so follow them. |
| `@alwaysUnder` | `lib/runtime/alwaysScope.ts`, used at `stdlib/fs.agency:35-40` | Exists. |
| `question` tool | `stdlib/agent.agency:66`, effect `std::question` at line 19 | Exists, in `std::agent` as the spec says. |

Why the runner is an interpreter and not "compile the JSON to an Agency def": the spec should say this in one paragraph, because the anti-goal invites the question. The answer is that the only way to run generated Agency code today is a subprocess (`runFunction`, `runFile`), and a subprocess cannot hold the host's function values. An in-process loader for generated code is a security boundary change this feature should not make. So the loop over steps is written once in Agency, and the format stays small enough that the loop is a dozen lines. Put that in "Calls I made".

## 5. Smaller points, by section

**"Running a workflow", step 1.** The `std::workflow::run` interrupt carries `inputs`. Inputs can be large (a note body, a list). The approval prompt and the policy matcher both get the whole value. Say whether `inputs` is rendered in full or cut, and that a policy glob on `inputs.*` is a supported way to pin a rule.

**"Running a workflow".** Each run raises `run` and then `recordUse`, plus every step's own effects. A CLI user with no policy answers two workflow prompts before the first step. `std::toolbox` has the same pair and `recommended` approves `recordUse` under the agent home (`docs/dev/agents/approval-policies.md:283-293`). Say that `recommended` will approve `std::workflow::recordUse` and `scan` the same way, or the first interactive run will feel like a bug.

**"Limits".** The guard is `guard(cost:, time:)` (`docs/site/guide/guards.md`), a block, not a decorator. The runner loop goes inside the block, so the step values live in the block's scope. Fine, but the resume story ("values of finished steps are in a local the checkpoint carries") should say the local is inside the guard block.

**"Tool across a resume".** "A tool that is not an Agency function value, such as a host-made closure, does not revive." Correct, and `createTool` already throws for a non-Agency executor (`createdTool.ts:25`). The check in `checkWorkflow` should be `AgencyFunction.isAgencyFunction(tool)` plus `validateForLLM()`, which is what `learn`'s path does.

**"References".** `steps.note[0].id` where `searchNotes` returns an empty array is a run-time failure naming the step, per the spec. Good. But a reference's *type* is "checked at run time" by whom? By the tool's Zod schema when the step is invoked, so the failure message will be the tool's validation message, not a workflow message. Say so, and say the runner wraps it with the step id, since the spec promises every failure names the step.

**"Writing a workflow from a run", the designer.** "The model has those tools, so it can call one to see what it returns." The transcript already contains every tool's full output. The designer needs a live call only for a lookup the run did not make. That weakens the case for giving the designer the full set; see the open question.

**"Saving a workflow".** `meta.json` holds "a hash of its parameter schema at save time". `std::toolbox` keeps no hashes, so this is new. It is reporting only, and the spec says so twice. Fine, but then `toolsChanged` is advisory output a host has to decide what to do with. Consider cutting it from this version: `checkWorkflow` on every run is the real check, and the hash adds a field format, a comparison, and a result field for a warning nobody has asked for yet.

**"Public API".** `workflowTool` returns `any`. `learn` returns `Result<any[]>` for the same reason, so this matches. `listWorkflows(dir, tools = [])` with an empty default means `toolsChanged` is always empty unless the caller passes tools, which is another reason to cut it.

**"Duplicate tool names".** `assertUniqueToolNames` (`lib/runtime/toolInvocation.ts:263`) exists and throws. `checkWorkflow` returns problems rather than throwing, so it needs its own check with the same message. Also: a saved workflow's `name` can collide with a tool in the host's list once `workflowTools` is added. That collision is caught by the tool loop at the next `llm()` call, not by `workflowTools`. Say that `workflowTools(dir, tools)` refuses a workflow whose name is already in `tools`, since it has both lists in hand.

**"Anti-goals".** "A review step the user cannot change anything in." The CLI renders the review as a numbered list and "takes a line of text". A line of text cannot be an edited workflow object, so on the CLI the anti-goal is met only by giving feedback for a redraft. That is acceptable, but the anti-goal should say "accepts an edited workflow where the host can send one".

**Interrupts that expect a value.** The approval-policies doc says interrupts that expect a value (a question, a review) get no "always" answer (`docs/dev/agents/approval-policies.md:275-280`). `std::workflow::review` is one of those. A policy rule can still match it and a bare approve means accept, as with `std::toolbox::review`. Worth one sentence, since a host that writes an "approve everything under the agent home" rule would be auto-accepting drafts.

## 6. The open question: which tools may the designer call

Pass a separate list for design, and default it to none.

- The transcript carries every output the run produced, so the designer rarely needs a live call. When it does, it is for a lookup it wants to add (a `findLists` the run never made), and the host knows which tools are lookups.
- "The whole set with a brief that says look up, never change" is a prompt-level safety rule, which is the thing this language exists to avoid.
- "The set minus tools reported as destructive" relies on the `destructive` marker (`lib/runtime/agencyFunction.ts:97`), which is set only on `destructive def`. BMO's `addListItems` is unlikely to carry it. The filter would pass the tools it is meant to stop.

So: `designWorkflow(name, purpose, transcript, tools, dir, ..., designTools: any[] = [])`. `tools` is what the workflow may call and what `checkWorkflow` validates against. `designTools` is what the model may call while writing. The `question` tool is always present. The dev doc's safety paragraph then says: the designer can run only what the host handed it for design, and every such call still raises its own effects.

## 7. Things the plan will need that the spec leaves open

These are fine to leave to the builder, but the plan should name them:

- How a file path and trace id become the `TreeNode` that `transcriptBlocks` wants.
- Whether `llm()` accepts a runtime `schema` option (item 1). Try it first.
- The test for a guard trip inside an LLM step, resumed.
- The test for a tool step interrupt rejected by policy: the workflow fails, nothing after it runs, and the failure names the step.
- The test that a paused workflow's checkpoint, resumed in a fresh process, revives `tools` including a partial and a rename.
- Where the module lives: `lib/stdlib/workflow/` as a directory from the start, since it will have a checker, a reference resolver, a renderer, and a designer brief, and the owner asks for feature directories.

## Addendum, 2026-10-27, after discussion

The owner's direction: a workflow is run by generating Agency code from the JSON and running it through `runCode`, the way a toolbox tool runs. No new runtime code. Also, workflows are built from scratch first; writing one from a statelog transcript comes later.

This supersedes items 1, 2, and 4 above. The LLM step is an ordinary `llm()` in generated code. The checker is the typechecker plus a line-to-step map for messages. The runner loop does not exist. Items 3, 5, and 6 still apply.

Two things the codegen version changes in the format:

- A tool is named by module and name (`std::notes::searchNotes`), because the generated code imports it.
- `inputs` is an Agency type, not a JSON Schema, because it becomes the node's parameter type.

One question to settle before the plan: `runCode` refuses TypeScript, Node modules, and `pkg::` imports in the closure. A host's tool is usable from a workflow only if it is a `std::` module or an `.agency` file under `dir`. Confirm BMO's tools meet that rule.
