# Review of the workflows spec and the MVP plan

Reviewed 2026-10-27 against the `adit/workflows` worktree at `003dfd5d2`.

- Spec: `docs/superpowers/specs/2026-10-26-workflows-design.md`
- Plan: `docs/superpowers/plans/2026-10-27-workflows-mvp.md`

Paths below are relative to `packages/agency-lang`. I checked each claim marked "checked" against the code. I ran one typecheck (item 3). After that I stopped running probes and read the code instead, so the claims marked "from the code" have a file and line but were not executed.

## Verdict

The spec's direction is right. Generating an Agency program from the JSON and running it through `runCode` means no new runtime code. Interrupts, policies, checkpoints, and resume all come from machinery that already works. The two rules and the decisions list hold the line against the format turning into a language.

The plan follows the spec closely and is well ordered. But six things in it will fail once someone builds it. Each one either breaks the generator or makes a test assert something the design cannot do. Fix these before execution starts:

1. A function value's `module` is not the string the workflow JSON uses, so every tool step fails the allow-list check.
2. Template hygiene renames the template's `inputs` parameter, so the generated program cannot see its own inputs.
3. A workflow with no `limits` and a plain-valued last step does not typecheck.
4. `runCode` kills the child after 60 seconds whatever `limits.maxTime` says.
5. Nothing validates `inputs`, and the test that expects bad inputs to be refused contradicts the order `runWorkflow` runs in.
6. `writeWorkflow` validates "shape only, with no tools", but the validator refuses every tool step when there are no tools.

Items 1 and 2 also change the spec. The rest are plan fixes.

---

## Blockers

### 1. A function's `module` is a compile-time path, not `std::x` or a path under `dir` (spec decision 6, plan Tasks 1–3)

Checked. `AgencyFunction.module` is the compiler's module id. That id is the source path relative to the compiler's working directory at build time (`lib/compiler/buildSession.ts:505`). In the main checkout, `std::path`'s functions carry `module: "stdlib/path.agency"`. A test fixture imported as `./fixtures/tools/notes.agency` carries something like `tests/agency/workflow/fixtures/tools/notes.agency`.

The workflow JSON says `"module": "std::path"` or `"module": "notes.agency"` (a path relative to `dir`). Task 1's `_toolRefs` returns `fn.module` unchanged, and Task 2 compares the JSON's `(module, tool)` pair against that list. So `stdlib/path.agency` never equals `std::path`, and every tool step gets "not among the tools passed". Task 1's unit test passes only because it builds function values with hand-written module strings.

The stdlib half has a known fix: `moduleIdToOrigin` (`lib/runtime/origin.ts:1`) maps `stdlib/foo.agency` to `std::foo`. Its regex matches any path containing `/stdlib/`, so a user file at `src/stdlib/notes.agency` would also map to `std::notes`. Check for that.

The user-file half has no fix in the code today. Turning a cwd-relative id into a path relative to `dir` needs the compiler's working directory, and a function value does not record it. It works when the same process compiles and runs, as `agency run` does. It breaks for a host that compiled ahead of time and runs from another directory, which is how a deployed BMO would run.

**Recommendation for the spec.** Drop `module` from tool steps. The host's list is the authority, and tool names in it are already required to be unique (plan Task 1). A step then names only `"tool": "searchNotes"`. The generator finds the function value by `name` and works out the import path from it. That has two benefits:

- The GUI and the hand author never write paths. A file move breaks nothing in the saved JSON, which also removes the reason decision 7 considered path aliases.
- The path translation lives in one helper with one test. The spec needs one paragraph saying which directory the module id is resolved against: the run-time `process.cwd()`. It should also say what happens when the result falls outside `dir`. The step should be refused with a message that names the tool and the path.

If `module` stays in the format, the spec needs that same paragraph anyway, and the plan needs a translation helper and a test that uses real imported function values, not hand-built ones.

### 2. Hygiene renames `inputs` in the main template (plan Task 5)

From the code. The plan fills the step statements into `#steps` inside a template that declares `node main(inputs: Inputs)`. The step statements mention `inputs` (`const note_query = inputs.noteTitle`). Template hygiene treats a node's parameters as binders (`lib/runtime/template/hygiene.ts:91-92`). When a filler's free name matches a binder that the hole can see, hygiene renames the template's binder (`docs/dev/language/template-agency.md:126`). So the output is:

```ts
export node main(__hyg1_inputs: Inputs): Result {
  ...
  const note_query = inputs.noteTitle   // unbound
```

The same rule bites any step id that matches a template binder. Separately, the template uses `Inputs` (in `schema(Inputs)`) without declaring it. The guide says a template "can use the prelude and the built-in functions, plus whatever it declares or imports itself" (`docs/site/guide/template-agency.md:220`). So expect AG8015 when `workflow.agency` itself compiles.

**Recommendation.** Do not use an outer template. Every part of the program except the literals is already a validated identifier, a reference path that `_refExpression` builds from identifiers, or a type that `describe` printed. Build the program as text from those parts. Use Template Agency only to print each literal, by filling `[| const #name = #value |]` and calling `toSource` on that one fragment. The security property holds, because no literal is parsed. You also get three more things:

- No hygiene, because nothing is filled into a template that declares names.
- An exact line map. The plan counts newlines "as each piece is appended", but the pieces then go through `fill` and `toSource`, which reprint the whole program. The counts would not match the final text. With plain text, the counts are the final text.
- One less concept for the reader of the generator.

The spec's sentence "filled and joined, then filled into a `#steps` statement hole in a main template" should change to match.

### 3. No guard and a plain last step: AG2001 (plan Task 5)

Checked with `agency tc`:

```ts
export node plainReturn(inputs: Inputs): Result {
  const joined = plainJoin(a: "a", b: "b")
  return joined
}
// error AG2001: Type 'string' is not assignable to type 'Result'
```

With `limits`, `return guard(...) { ... }` returns a `Result`, so it typechecks. Without `limits`, the plan uses "a second template without the `guard`", and `return #result` of a plain value fails. A `result` reference into a Result step's value (`steps.add.count`) fails the same way. Task 5's `plainReturnHasNoValue` test checks substrings only, so it passes on code that would not typecheck.

**Fix.** Always end with `return success(<result expression>)`, and keep the explicit `return failure(...)` lines for step failures. For a Result-typed last step with no `result` field, return `<id>.value` wrapped in `success`. Add a check in Task 5 or 6 that the no-limits workflow passes `checkWorkflow`, not only a substring test.

The guard part is fine. A block that returns a `Result` comes out of the guard unwrapped once, not as a success holding a failure (`lib/runtime/result.ts:327`, `normalizeForeignResult`). So a step failure reaches `runCode` as a failure.

### 4. `runCode`'s 60-second wall clock overrides `limits.maxTime` (plan Task 7)

From the code. `runCode` defaults `wallClock` to `60s` (`stdlib/agency.agency:749`) and kills the child when it runs out. Task 7 calls `runCode(source, "main", { inputs: inputs }, dir: dir)`, so the meal plan's `maxTime: 300000` never applies. A run that takes 61 seconds dies with `limit_exceeded`, not the guard's message.

**Fix.** Pass `wallClock` from `limits.maxTime`, plus a margin so the guard trips first and its message reaches the user. Pass `maxCost` too. With no `limits`, choose a default and state it in the spec. Add a sentence to the spec's "Running a workflow" saying which limit wins.

### 5. Inputs are never validated, and one test expects them to be (plan Task 7)

`badInputsFailBeforeRunning` passes `{ noteTitle: 5 }` and expects a failure that mentions `inputs`, with `std::workflow::run` never raised. Nothing in the plan does that:

- `runWorkflow` raises `std::workflow::run` first, then checks (spec "Running a workflow", step 1; plan Task 7 step 2). So the effect is raised before anything could look at inputs.
- `checkWorkflow` takes no inputs.
- A node parameter typed `Inputs` is not checked at run time unless it is marked `!` (`docs/dev/language/validation-annotations.md`). So `{ noteTitle: 5 }` reaches `searchNotes(query: 5)` in the child.

**Fix.** Decide where inputs are checked and write it into the spec. Here are two options:

- Generate `main(inputs: Inputs!)`. Check first that `!` is honoured on node parameters reached through `runCode`. The failure would then come from the child, after `std::workflow::run` and `std::run`.
- Validate in the parent against the inputs JSON schema before raising anything. This is the better choice if the schema is saved in `meta.json` (see item 9).

Separately, reorder `runWorkflow` to check, then raise, then run. Asking the user to approve a workflow that will fail its own check wastes a prompt.

### 6. `writeWorkflow`'s shape-only validation refuses every tool step (plan Task 10)

`writeWorkflow` "runs `_validateWorkflow` with no tools (shape only)". Task 2's `_validateWorkflow(workflow, refs)` reports a problem for every tool step whose pair is not in `refs`. With `refs = []`, that is every tool step. So nothing with a tool step can be saved.

**Fix.** Give `_validateWorkflow` a way to skip the allow-list rule: a separate `_validateShape`, or a `refs: ToolRef[] | null` where `null` means skip. Then say in the spec that saving checks shape only and running checks everything.

---

## Spec issues

### 7. A tool not typed `Result` can still fail, and the failure loses its step name (decision 5, "Results")

The guide says "Agency also adds an automatic try-catch around every function definition, and if an error is thrown, it returns a `Failure` type" (`docs/site/guide/error-handling.md:170`). So a tool declared `: string` can return a failure. The generator emits the `is failure` check only for `Result`-typed tools. For other tools, the failure goes into the next step's argument, skips that step, and comes out of the workflow with no step name.

The plan already notes that `x is failure` typechecks on a value that is not a `Result`. So emit the check after every tool step, and use the return type only to decide whether to add `.value`. Decision 5's promise, that every failure names the step, then holds for all tools.

### 8. "An empty array fails the step with a message naming the step and the path" has no mechanism ("References")

`steps.note[0].id` on an empty array makes `note.value[0]` undefined, and reading `.id` from it throws. The node's automatic try-catch turns that into a failure with a JavaScript message such as "Cannot read properties of undefined". Nothing in the plan adds the step name or the path, and no test covers it.

Either generate a guard per index access, or drop the promise from the spec and say the failure is a plain run-time error. If you keep the promise, a small test fixture is `searchNotes` returning `success([])`.

### 9. Refusing partials drops the host's scoping (decision 6, "Tools and modules")

The spec says the host passes "the same list it would hand to `llm(tools:)`". A host's model list often contains partials, because a partial is how a host scopes a tool. For example, `read.partial(dir: notesDir)` lets the model read only that directory. The spec refuses partials and asks for "the original def". So the workflow author gets `read` with any `dir`.

Interrupts still gate the read, so this does not open a hole by the spec's own argument. But the host loses a restriction it had in conversation, and the spec does not say so. Two options:

- Say it in the spec, and say the list is "the original defs, not the scoped copies you hand the model".
- Support a partial whose bound values are JSON. Emit each bound value as a fixed literal argument, and refuse a step that also sets that argument. This keeps the narrowing, and it uses only machinery the generator already has (literals filled through expression holes).

I recommend the second. `rename` can stay refused.

### 10. Step ids can collide with names the generated code uses

The identifier regex `^[A-Za-z_][A-Za-z0-9_]*$` accepts all of these, and each one breaks the generated program in its own way:

| Step id | What breaks |
| --- | --- |
| `failure`, `success`, `llm`, `JSON`, `schema` | Shadows the builtin that later generated lines call |
| `searchNotes` (a tool's own name) | `const searchNotes = searchNotes(...)` shadows the import |
| `inputs`, `main`, `Inputs` | Collides with the generated parameter, node, or type |
| `note_query` next to a step `note` with an argument `query` | Two `const note_query` lines |
| `meals` and `Meals` | Both produce `type Meals_output` |
| `const`, `thread`, `return` | Keywords; parse error in the generated text |
| `__x` | Reserved-name refusal from the parser (`docs/dev/language/reserved-names.md`) |

None of these is an injection. They produce confusing compile errors, or worse, a program that typechecks and calls the wrong thing. The `failure` row, for example, makes every later failure check call the step's value.

**Fix.** Give every generated name a fixed prefix that cannot be a step id, and build the derived names from the step's position, not its id: `s1`, `s1_a1`, `s1_out` (or `step_note`, `step_note_query`). Refuse `RESERVED_WORDS` (`lib/parsers/parsers.ts:252`) and the `__` prefix in validation. Error messages still say `step "note"` because the line map carries the id.

### 11. Smaller spec points

- **"Typed returns matter"** says `checkWorkflow` reports an untyped return as a warning. `WorkflowProblem` has no severity and the plan has no warnings, so this is not built. Either add `severity` or cut the sentence. Related: a tool with no printed return type, or one whose return type is an alias of `Result`, makes `_returnsResult` return false. The generator then leaves out `.value`, and the user gets a type error that blames their reference. I recommend refusing a tool with no declared return type, with a message saying why.
- **Answer to open question 1, about the double gate.** Keep both, as the toolbox does: `runTool` raises `std::toolbox::scan`, then `std::run` through `runFile`, then `recordUse` (`stdlib/toolbox.agency:1883-1904`). `std::run`'s payload names a generated module, and a policy cannot pin that to a workflow, so `std::workflow::run` is the gate a person reads. Say in the spec which of the two `recommended` approves, as `approval-policies.md:283-295` does for the toolbox.
- **Answer to open question 2.** Send a string context value as plain text and anything else as JSON. A note body as JSON arrives with every newline escaped as `\n`, which is harder for the model to read.
- **Prompt count per run.** With the plan as written, one run raises `std::workflow::run`, then `std::read` once per user module from `_signatures` in `checkWorkflow`, then `std::read` again from the second `_compileWithMap`, then `std::run`. Compile once per run, and read each module once. Following the toolbox, the reads that fulfil an approved `run` can use the primitive `_read` (`stdlib/toolbox.agency` lines 111-112 explain the pattern).
- **Which model an LLM step uses.** The child is a fresh process. A host that sets its client or default model in code (`setLLMClient`) does not pass that to the child. The spec should say where the child's model and keys come from when `model` is unset, because BMO is that kind of host.
- **Tools that depend on host state.** The child imports the tool modules fresh, so their top-level code runs again and they get their own globals. A tool that reads a global the host set at startup behaves differently in a workflow than in conversation. One sentence under "Isolation" covers it.
- **Public API drift.** The plan adds `dir` to `compileWorkflow`, `checkWorkflow`, and `catalog`. It makes `catalog` return a `Result`, and it adds `broken` and nullable fields to `WorkflowEntry`. Bring the spec's Public API section in line.
- **Two names.** `writeWorkflow(name, workflow, dir)` takes a name, and `workflow.name` is a second one. The spec says "The directory name is the only name." Drop the parameter, or refuse a mismatch.

---

## Plan issues, by task

### Task 1

- The tests need at least one function value imported from a real `.agency` file, so they exercise item 1. With hand-built module strings the test cannot fail for the bug it should catch.
- If item 9's partial support is adopted, the partial test changes from "refuses" to "emits bound values".

### Task 2

- Parsing input names out of the `inputs` text with `([A-Za-z_][A-Za-z0-9_]*)\s*:` also matches nested fields. `{ a: { b: string } }` declares `b` as an input. The typechecker catches the wrong reference later, so this check adds a second, partial parser of type text. Either drop the input-name rule and let the typechecker report it (the line map already attributes it to the step), or take the field names from `describe`'s parse.
- Add the refusals from item 10.

### Task 3

- `describe` prints a type's whole declaration as its `signature`: `type Inputs = { noteTitle: string }` (`lib/backends/agencyGenerator.ts:1264-1276`). Task 5 writes `type Inputs = ${signature}`, which would produce `type Inputs = type Inputs = ...`. Use the signature as the whole line.
- `describe` leaves out `@hidden` and underscore-prefixed exports. A host tool with either gets "exports no function named". That is fine, but put it in the message so the author knows why.
- A user module that re-exports its tools from another relative file returns entries of kind `"reexport"` with no signature. Say what `_signatures` does then.
- `signatures.agency` imports `join` and `searchNotes` and uses neither.

### Task 4

- The description says `steps.meals` becomes `meals`. The test "maps a bare step" passes `["meals"]` and expects `meals.value`. Both follow the rule, but the example in the description reads as if `meals` were never a Result step. State the rule and drop the example, or use an LLM step for it.

### Task 5

- Items 2, 3, and 10 change this task the most.
- The expected substrings disagree with the stated design. The design binds each reference to a local before the call (`const note_query = inputs.noteTitle`, then `searchNotes(query: note_query)`). But the test expects `const text = readNote(id: note.value[0].id)` inline. Pick one. Locals give better line attribution: a bad path is reported on the `const text_id = ...` line, which belongs to field `args.id`.
- The paragraph about the docstring ("bound through an expression hole into a `const` that the generated `main` returns as part of its docstring is not possible, so…") is one garbled sentence. Rewrite it as: "The description is not written into the source. It is set on the tool value in Task 8."
- Handle `limits` with only one of `maxCost` and `maxTime`. The template as written needs both.

### Task 6

- The rule for mapping a wrong argument name to `args.querry` parses `'<name>'` out of the diagnostic's message. Diagnostics carry `params`, a structured payload of the values rendered into the message (`stdlib/agency.agency:136-147`). Read the argument name from `params`. Then a change to the message wording cannot break the mapping.
- "Warnings are not problems, except AG3009 is ignored entirely" contradicts itself, because AG3009 is a warning. Drop the exception, or pass `ignoreCodes: ["AG3009"]` to `typecheck` and say why.

### Task 7

- Items 4 and 5.
- `rejectedStepStopsTheWorkflow` expects `data.step` on the failure. `runCode` returns `success(envelope.data)` (`stdlib/agency.agency:801-803`), so the plan's "unwrap the way `_executePrepared` does" is needed. Keep it, and cover it with this test.

### Task 8

- `_withInputsSchema` is not needed. Agency code already calls `.withParamSchema` on a function value: `lib/agents/agency-agent/lib/learned.agency:78`. Call it from `workflowTool` and delete the TypeScript binding and its test.
- The same may hold for `_toolFacts`. Try `t.name` and `t.description` from Agency first (`description` is a getter at `lib/runtime/agencyFunction.ts:191`).
- Computing the inputs schema with `runCode(source, "inputsSchema", ...)` every time `workflowTool` runs costs a subprocess and a `std::run` prompt per workflow. `workflowTools` would do that for every saved workflow, each time a host builds its tool list. The toolbox computes its request schema once, at save time, and stores it in `meta.json` (`stdlib/toolbox.agency:1327-1349`). `learned.agency` attaches it from there. Do the same: `writeWorkflow` stores `inputsSchema`, and `workflowTools` reads it. `workflowTool` on an unsaved workflow can still compute it once.
- A schema set by `.withParamSchema` is not serialized. `FunctionRefReviver.serialize` keeps the name, module, bound params, and description (`lib/runtime/revivers/functionRefReviver.ts:22-48`). After a resume, the model sees `inputs` as a plain object. The learned tools have the same gap. Note it in the dev doc, or rebuild the tool list on resume.
- Add the test the first review asked for, which is still missing: a workflow tool called by `llm()`, a step that pauses, and a resume in a fresh process. That checks that the partial's bound `tools` array, which holds function values, revives.

### Task 10

- Item 6.
- `collidingNameIsRefused` builds the collision with "a function renamed to `good`'s workflow name". `_toolRefs` refuses renamed functions, so the test gets the "renamed" message, not "already a tool named". Use a stub `def` whose own name matches the workflow's name.

### Task 11

- This is the existing `nested-pause-resume` test with a workflow as the program, which is fine as a smoke test. The resume path the feature adds is the one in the Task 8 note, through `workflowTool`.

### Throughout

- The Review Focus list points at the wrong tasks in two places. The `${` and `"""` case is pinned in Task 5 (`literalIsNeverCode`), not Task 6. The unknown-tool case is pinned in Tasks 2 and 6, not Task 3.
- The commit trailers name a specific model. Use the attribution of whoever executes the plan.
- The plan sends test output to `/tmp/wf-*.txt`. That is fine for logs, but keep the `.agency` probes inside the package, since CLAUDE.md says they cannot run from `/tmp`.

---

## What I would change first

1. Spec: tool steps name a tool, not a module. Add the paragraph on how a function value becomes an import path (item 1).
2. Plan Task 5: build the program as text, using Template Agency only for literals. Use prefixed, position-based local names, and always end in `return success(...)` (items 2, 3, 10).
3. Plan Task 7: check, then raise, then run. Pass the wall clock and cost from `limits`. Decide where inputs are validated (items 4, 5).
4. Plan Tasks 8 and 10: save the inputs schema in `meta.json`. Split shape validation from tool validation. Fix the collision test (items 6, Task 8, Task 10).

---

# Second review, 2026-10-27, after the revision to fragments

The plan was revised in the same session. The lower stage now produces Template Agency `Code` fragments instead of text pieces, the scaffold is fixed text, and all four stages are TypeScript. This section records what the revision settled from the first review, what it added, and what is still open. The plan's MVP cut has no `runWorkflow`, `writeWorkflow`, or `workflowTool`, so the first review's items 4, 5, 6, 9, and the Task 7 to 11 notes do not apply to it; they apply when that work is planned.

## Settled by the revision

- **Item 1, module ids.** `toolRefs(tools, dir)` now maps a function value's module id through `moduleIdToOrigin` and rewrites a local path relative to `dir`, refusing one outside it. The `/stdlib/` false positive is named. The question the first review raised, whether a user file's id is absolute or relative to the compile-time working directory, is written into Task 3 as a thing to confirm before writing the rewrite. Its recommendation to drop `module` from the format is not taken; that is a spec decision for the owner (see Open below).
- **Item 2, hygiene.** Verified again by running `_fill` on the scaffold: `node main(__hyg1_inputs: Inputs)`. The scaffold is fixed text. The remaining fills are `const <local> = #value` and the prompt fold, and Task 4's naming rules guarantee no filler mentions the name its fragment binds. The `Inputs`-undeclared-in-template point is moot with no template scaffold.
- **Item 3, AG2001 without a guard.** The result line is `return success(<expr>)` in every program. Two new tests pin it: `noLimitsTypechecks` and `plainReturnHasNoValue` (now asserting a typecheck, not only substrings).
- **Item 7, non-Result tools can fail.** The check is emitted after every tool step; the return type only decides `.value`.
- **Item 10, step-id collisions.** Every generated name has the `step_` prefix (`step_<id>`, `step_<id>_<arg>`, `Step_<id>_output`) from one function in resolve. The one collision the prefix cannot remove (two steps producing the same local) is refused. `stepNamedFailureIsHarmless` pins it.
- **Task 2 regex.** Nested-field false positives are accepted and the reason is written down.
- **Task 3 signature.** Render writes `describe`'s signature as the whole type line.
- **Task 6 payload.** The argument name comes from `params.name`, the field `TypeCheckDiagnostic` actually has.
- **Task 6 AG3009.** The contradictory clause is gone; warnings are not reported.
- **Review Focus pointers** were corrected and two items added (hygiene, `success` wrap).
- **Line map.** Each fragment is printed once, the prints are joined by the renderer, and ranges come from those same prints. There is no second print that could disagree.

## Open, for the owner

1. **`module` in the format.** The first review's recommendation stands as the simpler design: a step names only `"tool"`, the host's list is the authority, and the import path is derived. The plan keeps `module` and adds the translation. Either works; the translation is the part that can go wrong on a host that compiled elsewhere.
2. **What a user file's module id holds at run time.** Not verified in this session (a hook stops local `agency run`). Task 3 says to check with `pnpm run compile` before writing the rewrite.
3. **The spec's section 3 ("Lower")** still describes text pieces and a `#steps` hole. Update it when this merges; the plan's self-review notes the departure.

## Not re-checked

The first review's spec items 8 (empty-array message) and 11 (prompt count, child model, partials) were not revisited; none of them changes the MVP plan.
