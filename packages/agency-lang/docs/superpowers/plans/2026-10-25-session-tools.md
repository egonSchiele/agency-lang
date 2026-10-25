# Session tools implementation plan

Status: implementation in progress. Date: 2026-10-25. Revised the same day after
[review](./2026-10-25-session-tools-review.md).

## Goal

Implement `runFunction` and `learn` in `std::agency`, with a private runtime factory behind `learn`. The Agency agent keeps a record of what it learned in a global array and builds the tools from those records on every turn. Learned functions preserve ordinary parameter handling, validation, and tool-loop behavior while their implementations run in subprocesses.

Contract: [Learn Agency functions as session tools](../specs/2026-10-24-session-tools.md).

Paths below are relative to `packages/agency-lang`. Files marked **new** are proposed locations. Adjust helper filenames to fit adjacent code without changing the public contract.

## Shape of the work

Three stacked PRs in this order: PR 1 targets main, PR 2 targets PR 1, and PR 3 targets PR 2, as requested. A fourth, independent PR fixes a learned-catalog bug the review found and is not part of this feature.

| PR | Delivers | Tasks |
| --- | --- | --- |
| 1 | `runFunction`, and `module` and `function` in the `std::run` gate data | 1, 2, 3 |
| 2 | `learn`, the factory, callable restoration | 4, 5, 6 |
| 3 | Coordinator wiring and docs | 7, 8 |
| separate | The reviver drops `withParamSchema` overrides (learned catalog) | not here |

PR 1 is useful on its own and small. PR 2 cannot start its restoration task until the test in Task 6 has run.

## Implementation boundaries

- Reuse `AgencyFunction` for created callables and the existing prompt loop for their invocation.
- Keep original parameters flat. The executor's argument record is internal.
- Reuse Template Agency, `describe`'s internals, and the existing sandboxed compile (`compileSandboxed`) unchanged. No second compile entry point.
- Read local files the way `compile`, `runFile`, and `runCode` read them. No per-file read interrupt.
- Keep original defaults and executable validators in the child module.
- Use the current child `Run` under a generated node. Preserve the existing subprocess handler and resume path.
- Build definitions from the runtime's existing `FuncParam`, `ToolDefinition`, and `ToolMarkers` types. No parallel types with the same fields.
- Validate with the existing `canonicalKeys`, `assertUniqueToolNames`, and `AgencyFunction.validateForLLM()`. Do not write a second alias or name checker.
- Add no checker of IPC values and no compatibility record; `run` and the fingerprint check already own those.
- Keep the coordinator changes in its learning module and `turnTools()`.
- Use static imports, objects, arrays, and type aliases. Refuse symlinks.
- Every "how" sits behind one function with a declarative name; see the pipeline in Task 1 and the record functions in Task 7.

## Where each anti-pattern was checked

The review checked the earlier plan against `docs/dev/contributing/anti-patterns.md`. The items below are the ones that changed this plan, so a reader can see where each landed.

| Anti-pattern | Where the earlier plan tripped it | Where this plan handles it |
| --- | --- | --- |
| Leaky abstractions | A public `createTool` whose input was the binder's internals; the factory reading the `UNSET` sentinel | Factory is private (Task 4); a new `AgencyFunction` method returns resolved arguments as a named record (Task 4) |
| Duplicating existing code | A second compile entry point; a second `ToolDefinition`; an IPC value checker; definition validation beside existing checks | Boundaries above; Tasks 1 and 4 name the functions reused |
| Order-dependent mutable state | A snapshot accumulated across interrupt-capable reads | Removed with the per-file read step; preparation is a pipeline ending in one value (Task 1) |
| Imperative code everywhere | "Validate and append without an intervening asynchronous operation" | One function from current records and a candidate batch to new records or a diagnostic (Task 7) |
| Inconsistent patterns | `learn` reading per file while `compile` does not; flat and nested tools with no stated reason | Boundaries above; the spec states why the learned catalog stays nested |
| Catastrophic test failures / safeDelete | "Remove temporary artifacts" in the resume test | Task 8 deletes only a test-owned directory through `safeDeleteDirectoryWithin` |

## PR 1: runFunction

### Task 1: Prepare source and generate the invocation node

**Files**

- `stdlib/agency.agency`: `AgencySource` and `RunOptions` types, `runFunction`.
- `lib/stdlib/agencyFunctions.ts` and `agencyFunctions.test.ts`: **new**, the preparation pipeline.
- Existing: `lib/stdlib/agency.ts` (`compileToProgram`, `describeSource`), Template Agency helpers.

**Work**

- [ ] Add `AgencySource` (`module`, `file`, `source` kinds) and `RunOptions` as flat type aliases in `stdlib/agency.agency`. `RunOptions` fields are `run`'s own parameters; omitted fields take `run`'s defaults.
- [ ] Write `prepare(source, names)` in `agencyFunctions.ts` as a pipeline of pure steps, each taking the previous step's value: `resolveEntry` (source kind to an entry: a `std::` import, a file under `dir`, or text; a `Code` value goes through `toSource`, and an unfilled hole is a failure), `selectExports` (parse the closure and pick public exported defs, reusing `describeSource`'s internals so a local re-export resolves), `generateAdapter` (Template Agency, static imports of the selected originals, exports `invokeLearned` and, when asked, `describeLearned`), and `compileToProgram` (the existing sandboxed compile, `strict: true`). The result is one `Prepared` value: the compiled program, the selected export names, and the adapter's node names.
- [ ] Name the generated nodes `invokeLearned` and `describeLearned`. No `__` prefix: `docs/dev/language/reserved-names.md` makes that the compiler's.
- [ ] Reject nodes, handoff defs, required function or block parameters, and unresolved generic schemas in `selectExports`, each with the export's name and the reason. An empty selection is a failure.
- [ ] Keep each original file at its relative path in the mirror by adding the adapter as a new entry beside them, not by flattening.
- [ ] Do not add any read interrupt. `compile`, `runFile`, and `runCode` read local files under `dir` without one; `learn` matches them.

**Verification**

A fixture in a nested directory with a private helper, an imported type, a transitive dependency, and a local re-export. Test a forbidden import, a splice, a JavaScript global outside the allowlist, a nested-directory import that resolves, a `Code` value with an unfilled hole, and a selection naming a node. After preparation, changing or deleting the test-created files must not change execution of the prepared program.

### Task 2: Run an export under the existing subprocess node

**Files**

- `stdlib/agency.agency`: `runFunction` and the private execution helper.
- `lib/stdlib/agencyFunctions.ts`: the named-record dispatch helper the generated node calls.
- `lib/runtime/ipc.ts` or wherever the `std::run` gate data is assembled: `module` and `function` fields.
- `lib/runtime/call.ts`, `toolInvocation.ts`, and `agencyFunction.ts` as reuse points.

**Work**

- [ ] Write the helper `invokeLearned`'s body calls: given the selected imports, an export name, and a named record, dispatch through normal named-call dispatch (`callFromOutside`) in the current child `Run`. Resolve names only against the selected exports.
- [ ] Do not use `runExportedFunction` or the generated serve helpers. They create a separate one-shot root with no checkpoint path.
- [ ] Add a private `executePrepared(prepared, exportName, args, options)` in `stdlib/agency.agency` that calls `run(prepared.compiled, "invokeLearned", ...)` with the options forwarded. `runFunction` is `prepare` then `executePrepared`. `learn` binds `executePrepared` later.
- [ ] Have the prepared execution path supply `module` and `function` to a shared private run helper. Publish those identity fields only for launches from the trusted host; sandboxed descendants and ordinary run calls retain the generic gate. Test both an ordinary node named `invokeLearned` and a child calling the hidden helper with forged labels.
- [ ] Preserve canonical explicit `null` in programmatic calls. Allow normal external alias binding, including null-valued alias keys counting as absent. Omitted parameters are absent from the record; never serialize a padding value or substitute `null`.
- [ ] Unwrap the subprocess envelope and normalize the public `Result` once. Preserve original failures and their rejection, destructive, and never-started data.
- [ ] Add nothing that inspects argument values for IPC. `run` owns that.

**Verification**

Call a function whose source has no nodes. Cover direct defaults and variadics, imported validators, plain and `Result` returns, thrown and binding failures. Pause inside an imported helper and resume. Confirm parent rejection and propagation still apply when the child approves an effect. Assert the gate data carries `module` and `function` and that a policy rule matching them approves the call. Use existing subprocess tests as regressions.

### Task 3: PR 1 tests and docstrings

**Files**

- `tests/agency/subprocess/run-function.agency` and `run-function.test.json`: **new**.
- `tests/agency/subprocess/function-fixtures/`: **new** test modules.
- `stdlib/agency.agency` docstrings for `runFunction` and the two types.

**Work**

- [ ] Write the fixtures and cases from Tasks 1 and 2 as Agency execution tests. No LLM calls.
- [ ] Docstrings: what `runFunction` does, the three source kinds with one example each, the import rules in the same words `runCode` uses, and that the call runs in a fresh subprocess.

## PR 2: learn

### Task 4: The factory and the named-arguments method

**Files**

- `lib/runtime/createdTool.ts` and `createdTool.test.ts`: **new**, not exported from `std::agency`.
- `lib/runtime/agencyFunction.ts`: one new method.
- `lib/runtime/index.ts`: export the factory for `lib/stdlib/agencyFunctions.ts`.
- Existing tests in `lib/runtime/agencyFunction.test.ts` and `toolLoopGuards.test.ts`.

**Work**

- [ ] Define `CreatedToolDefinition` from existing types: `name`, `description`, `inputSchema` (JSON Schema), `params: FuncParam[]` without `defaultValue`, `markers: ToolMarkers`. No new field that duplicates one of those.
- [ ] Add `AgencyFunction.namedArguments(resolved)`, which turns the binder's resolved positional values into a canonical named record: omitted parameters absent, explicit `null` kept, a variadic as one array. The padding sentinel is read only inside `agencyFunction.ts`. Add a unit test beside `resolveNamed`'s.
- [ ] Write `createTool(definition, executor)`. It builds the Zod schema with `z.fromJSONSchema(definition.inputSchema)`, the call `withParamSchema` already makes, so `partial` reduces it through the existing `buildReducedSchema`. Its body binds through the ordinary `AgencyFunction` path, calls `namedArguments`, and invokes the executor with the current `Run`, returning the result unchanged.
- [ ] Validate with the existing functions: `canonicalKeys` for alias conflicts, `assertUniqueToolNames` for the name, `AgencyFunction.validateForLLM()` for eligibility. Treat the schema's `required` list and `hasDefault` separately.
- [ ] The executor contract: a registered `AgencyFunction`, or a partial application of one, taking one named record. Check that it has no other unbound required parameter.
- [ ] The factory evaluates no defaults and synthesizes no `!` checks.

**Verification**

Compare an ordinary Agency function with a factory-created function built from the same metadata. Cover unknown and missing names, alias corrections and conflicts, default omission, explicit `null`, variadics, and failure-valued parameters. Round-trip the fixture types Zod → JSON → Zod → JSON and compare the two JSON documents. Test schema derivation after `partial`. Verify two renamed tools receive separate repetition and removal counts while alias spellings produce one repeat key.

### Task 5: The metadata node and learn

**Files**

- `stdlib/agency.agency`: `learn`.
- `lib/stdlib/agencyFunctions.ts` and its test: the metadata extraction helper and `describeLearned`'s body.
- `tests/agency/subprocess/learn-functions.agency` and `learn-functions.test.json`: **new**.

**Work**

- [ ] Write the helper `describeLearned` calls: for each selected compiled `AgencyFunction`, return `name`, `toolDefinition.description`, `toolDefinition.schema.toJSONSchema()`, `params` without `defaultValue`, and `markers`. Nothing executable crosses.
- [ ] Implement `learn`: `prepare` once with the metadata node requested, `run` the metadata node through the normal gate, then one `createTool` per export with the executor `executePrepared.partial(prepared:, exportName:, options:)`.
- [ ] Apply the namespace as `[namespace, exportName]` joined by `_` after dropping empty parts, so an empty namespace is not a branch. Fail the batch if any advertised name exceeds `MAX_TOOL_NAME_LEN`.
- [ ] Validate the whole batch before returning it. Return an array on success, a diagnostic naming the export and the reason on failure. Do not touch any agent global.
- [ ] Docstring: that learning runs the module's top-level code once in a subprocess and can pause or be rejected there; that each call forks a fresh process; the unsupported signatures; the namespace rule.

**Verification**

Use the same original function as a direct model tool and as a learned tool under a scripted model client. Compare schema, alias correction, argument errors, null and default handling, and failure and removal behavior. Include an imported type with `!` and a custom validator whose failure prevents body execution, and an unchecked parameter. A FRED example may inspect definitions without a network request; keep automated verification independent of FRED credentials and the network.

### Task 6: Callable restoration

**Files**

- `tests/agency-js/unregistered-tool-resume/`: **new**, the test that comes first.
- `lib/runtime/revivers/functionRefReviver.ts` and its test.
- `lib/runtime/createdTool.ts` and `agencyFunction.ts`.

**Work**

- [ ] First, write the test: a tool built with `new AgencyFunction` (not registered, the MCP adapter's shape) in a turn's tool list, an interrupt raised mid-`llm`, a fresh-process resume, then a call to that tool. Record what happens. If it survives, the mechanism it relies on is the one to use below, and the rest of this task shrinks to a test. If it comes back as a throwing stub, say so in the PR description: MCP tools share the symptom, but arbitrary MCP closures need their own restore recipe; do not claim this fix restores them.
- [ ] Serialize a created tool as the reviver's existing function reference plus a `created` field holding `{ definition, executor }`. The executor is a registered partial, so the existing bound-params path restores it. Revive calls `createTool(definition, restoredExecutor)`, then re-applies rename, further bindings, and description through the reviver's existing steps.
- [ ] Carry the definition through `options()` and `derive()` so a renamed or partially applied created tool keeps it.
- [ ] Reject an unrecognized `created` shape with a diagnostic. Do not evaluate source or run the executor while restoring.
- [ ] Leave the `withParamSchema` loss alone. It is the separate PR in the table above.

**Verification**

Round-trip a created tool whose executor is a registered partial with bound data. Compare its schema and parameter metadata before and after restore, then invoke it. Cover further partial application, renaming, and description changes. Existing function-reference tests still pass.

## PR 3: Coordinator

### Task 7: Records in the coordinator, tools built each turn

**Files**

- `lib/agents/agency-agent/brains/coordinator/learn.agency`.
- `lib/agents/agency-agent/brains/coordinator/coordinator.agency`.
- Their existing `tests/learn.agency` and `tests/toolWiring.agency`.
- `tests/agency-js/coordinator-session-tools/`: **new** scripted-client fixture.

**Work**

- [ ] Add `LearnedRecord` and the global `learnedRecords: LearnedRecord[] = []` to the learning module. The global holds JSON only.
- [ ] Add `getGeneratedTools()`, which maps records through `toolFromRecord`, a function that calls the factory with the record's definition and `executePrepared.partial(...)`. Pure; runs every turn.
- [ ] Add `addLearnedRecords(current, candidates, offeredNames)`, a function that returns either the new record list or a diagnostic. It fails on a name already in `current` or in `offeredNames`, and on a name over `maxLearnedToolName`'s equivalent for the namespace. `learnTools` calls it and assigns the result to the global in the next statement, with no call between that can raise an interrupt.
- [ ] Add the agent-facing `learnTools(source, names, namespace)`. Default namespace `session`. It calls `learn`, then `addLearnedRecords`. Its reply states when the tools become available.
- [ ] Pass the offered names in from coordinator wiring to avoid a circular import.
- [ ] Offer `learnTools` and spread `getGeneratedTools()` in `turnTools()`. Do not clear the global on resumed initialization.
- [ ] Spike, half a day at most: make `learnTools` a `handoff def` whose body, after learning, calls `llm` with `turnTools()` including the new records. If the model can call the new tool inside that `llm` and the one-handoff-per-round rule and the coordinator's thread setup allow it, keep it and change the reply text. If not, write two sentences in the dev doc saying what blocked it and keep next-turn availability.

**Verification**

Within one Agency run, call `brain.runTurn` twice. In the first turn the scripted model invokes `learnTools` and completes its reply. In the second, inspect the actual request's tools and call the new tool. Verify a failed batch leaves the records intact, a collision fails without replacing anything, an over-long name fails, and a fresh run starts empty.

### Task 8: Fresh-process restore test and documentation

**Files**

- `tests/agency-js/learned-tools-resume/`: **new**, modeled on `subprocess-durable-resume` and `agent-session-resume`.
- `stdlib/agency.agency` docstrings.
- `docs/dev/stdlib/agency-function-tools.md`: **new**.
- `CLAUDE.md` index and the `agency-stdlib-docs` skill.

**Work**

- [ ] Save records in the global, serialize, resume in a fresh process, and verify the rebuilt schema and aliases before calling a tool.
- [ ] Separately, pause during a learned call, delete only a directory the test created, through `safeDeleteDirectoryWithin`, and resume in a fresh process. Never touch the shared `.agency-tmp` root. Verify parent and child handlers and that completed side effects do not repeat.
- [ ] Confirm restored calls use the prepared code after the test-created sources change or disappear.
- [ ] Write the dev doc: the two public functions with one example each, the prepare pipeline and its one value, why the factory is private, why the metadata node exists (no compile-time schema), the gate data, the fork-per-call cost, the records global, what the Task 6 test found, and the handoff spike's outcome.
- [ ] Add the doc to the `CLAUDE.md` index. The `agency-stdlib-docs` skill was removed from the current repository and is absent from installed skills, so there is no skill index to update.
- [ ] Regenerate stdlib reference pages through the existing build. Do not edit generated Markdown.
- [ ] Review the diff for any argument, alias, name, or validation logic that duplicates `agencyFunction.ts` or `toolInvocation.ts`.

## Validation commands

Run from `/Users/adit/agency-lang/packages/agency-lang` after the referenced implementation and fixtures exist. Save output once and inspect failures from those logs. Use deterministic model clients. Do not run the full Agency execution suite.

Build after modifying stdlib files:

~~~bash
make > /tmp/agency-session-tools-build.log 2>&1
~~~

Targeted unit tests:

~~~bash
pnpm exec vitest run lib/runtime/createdTool.test.ts lib/runtime/agencyFunction.test.ts lib/runtime/revivers/functionRefReviver.test.ts lib/runtime/toolLoopGuards.test.ts lib/runtime/prompt.test.ts lib/stdlib/agencyFunctions.test.ts > /tmp/agency-session-tools-unit.log 2>&1
~~~

New execution and restore fixtures:

~~~bash
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/subprocess/run-function.agency > /tmp/agency-session-tools-run-function.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/subprocess/learn-functions.agency > /tmp/agency-session-tools-learn.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/unregistered-tool-resume > /tmp/agency-session-tools-unregistered.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/coordinator-session-tools > /tmp/agency-session-tools-coordinator.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/learned-tools-resume > /tmp/agency-session-tools-resume.log 2>&1
~~~

Affected existing integration tests, once after the implementation settles:

~~~bash
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test lib/agents/agency-agent/brains/coordinator/tests/learn.agency > /tmp/agency-session-tools-existing-learn.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency > /tmp/agency-session-tools-wiring.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/subprocess/pause-then-parent-handler.agency > /tmp/agency-session-tools-parent.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/subprocess/pause-then-child-handler.agency > /tmp/agency-session-tools-child.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/subprocess-durable-resume > /tmp/agency-session-tools-existing-resume.log 2>&1
~~~

Formatting and structural checks, chained so a failure is not swallowed:

~~~bash
pnpm run fmt:ts > /tmp/agency-session-tools-format.log 2>&1 && pnpm run lint:structure > /tmp/agency-session-tools-lint.log 2>&1
~~~

If compiler templates change, edit their `.mustache` sources and regenerate them. Regenerate compiler fixtures only when the implementation changes their output, then inspect that diff.

## Completion

- [ ] `runFunction` and `learn` satisfy the spec and have source docstrings; the factory is not exported.
- [ ] Learned tools pass the ordinary schema, binding, validator, and tool-loop tests.
- [ ] The `std::run` gate names the module and function for a learned call.
- [ ] A next-turn (or, after the spike, same-turn) coordinator call and a fresh-process restore both use the learned tool.
- [ ] The Task 6 test's finding about unregistered tools is recorded in the dev doc.
- [ ] The permanent toolbox and the active prompt loop are unchanged.
- [ ] Build, targeted tests, formatting, and structural checks pass.
