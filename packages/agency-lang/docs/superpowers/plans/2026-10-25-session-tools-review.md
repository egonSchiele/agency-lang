# Review: session tools spec and plan

Reviewed on 2026-10-25:

- `docs/superpowers/specs/2026-10-24-session-tools.md`
- `docs/superpowers/plans/2026-10-25-session-tools.md`

## The short answer

The core shape is right and I would keep it: compile a small generated
entry around the original module, run it through `std::agency.run` so the
parent handler chain and the subprocess pause and resume path do all the
safety work, and rebuild each function in the parent as an ordinary
`AgencyFunction` with its original flat parameter list so aliases, binding
errors, and the tool-loop guards keep working. Those are the right reuse
points, and the spec's argument for flat parameters over the nested
`request` shape the learned catalog uses today is correct.

What I would change is the amount built around that core. About half of
the plan is new machinery the goal does not need, and some of it makes
`learn` stricter than the functions it wraps. The spec also leaves two
TODOs open on its public surface, which a plan should not be written
against. My recommendation is three smaller PRs that drop five pieces of
the design, listed under "What to cut". The sections after that cover
the places where the plan should make a decision it currently defers,
and a few things the spec gets wrong or leaves unsaid.

## What to cut

### 1. Per-file read approval during preparation (the biggest cut)

The spec says every local dependency read "must occur after its normal
read approval", that the synchronous compiler cannot be used because it
reads without raising those interrupts, and that preparation therefore
needs "a checkpointable collection step" plus a new way into
`compileValidatedClosure` that accepts pre-read bytes. That is most of
Task 3, and it is the hardest code in the plan.

Nothing else in the language works this way. `compile(source, dir)`,
`runFile`, `runCode`, and the toolbox's `runTool` all let the sandboxed
compiler read `.agency` files under `dir` with no `std::read` interrupt.
The gates are the `std::run` interrupt before the child starts and, for
the toolbox, one `std::toolbox::scan` interrupt that names the directory.
A model that cannot get `learn` to read `./helper.agency` can already read
it with `runCode(dir: ...)`. Making `learn` the one function that asks per
file buys no safety and costs a second compile entry point that has to
stay in step with the first.

Do what the toolbox does: one interrupt per `learn` call that names the
source (the module id, or `dir` and the filename), then the existing
`compileSandboxed` path unchanged. If per-file approval is wanted, it is
a change to `compile` and `runFile` for everyone, in its own PR with its
own argument.

### 2. `createTool` as a public `std::agency` function

Only `learn` needs the factory. Its executor contract ("an existing
registered Agency function or a partial application of one with
serializable bound data; arbitrary closures are outside this API") is a
runtime detail an Agency author cannot see or check, and a model reading
the docstring will try to pass a closure and get a confusing failure.
Keep the factory in TypeScript (`lib/runtime/createdTool.ts` is a fine
home) and call it from the `learn` implementation. If a second caller
turns up later, export it then with the contract it has proven.

`runFunction` is different: calling an export that has no node around it
is useful on its own and small. Keep it public.

### 3. The data-boundary checker

"Detect values JSON would silently alter, such as nested functions,
symbols, cycles, and non-finite numbers. Return a diagnostic rather than
dropping fields." `run(compiled, node, args)` already sends `args` over
IPC. Whatever it does with `NaN` today, it does for every caller. If that
is wrong, fix it once in `run`; do not add a checker that only learned
calls pass through.

### 4. The prepared-form compatibility record

"Record its compatibility information and refuse unsupported reuse rather
than silently recompiling a paused call." A `CompiledProgram` already
carries its own code, resume re-materializes from that code and never
recompiles, and `checkpoint-code-fingerprints.md` already refuses a resume
across changed code. Name which of those the plan reuses, or drop the
sentence. As written it reads as a new mechanism.

### 5. Fixing the `withParamSchema` loss in the same change

Task 2 says to "fix the existing loss of `withParamSchema` overrides as
part of this path". That is a real bug (the reviver serializes the
description but not the schema, so a learned-catalog tool comes back
from a mid-turn resume with its `request` typed as `any`), but it belongs
to the learned catalog, not to this feature. Fix it first in a two-file
PR, or after. Bundling it makes the reviver change harder to review.

## Decisions the plan defers that it can make now

### The schema representation

Task 1 says "check emitted-schema fidelity before selecting a conversion"
and warns that a `toJSONSchema`-only wrapper (the MCP adapter's trick)
cannot support `partial`. Both true, and the answer is already in the
codebase: `withParamSchema` builds a Zod schema from JSON Schema with
`z.fromJSONSchema` (`lib/runtime/agencyFunction.ts:448`). The factory can
call `z.fromJSONSchema(definition.inputSchema)` for the whole object. The
result is a `ZodObject` with a `.shape`, which is exactly what
`buildReducedSchema` walks when `partial` removes a bound parameter. Write
that decision into the task, and add one test that round-trips the
fixture types Zod → JSON → Zod → JSON and compares the two JSON documents.

### Where the metadata comes from

The spec runs a metadata node in a subprocess to read each compiled
function's `toolDefinition`. I looked for a way to avoid that run.
`typeToZodSchema.ts` emits schema *code* into the generated TypeScript;
nothing produces a JSON Schema from an Agency type at compile time. So the
subprocess run is the pragmatic choice, and the toolbox's `requestSchema`
node is the precedent. Say so in the spec in one sentence, so the next
reader does not repeat the search. Also note the consequence plainly in
the `learn` docstring: learning a module runs its top-level code once,
which can raise interrupts, before any function is called.

### How a created tool survives a checkpoint

The spec is right that this needs a reviver change: the global array and
the `options.tools` local in the coordinator's turn both hold function
values, and the reviver finds a function by its registered
`module:name`, which a factory-built value does not have. But before
designing the "versioned creation description", the plan should pin down
what happens today to a tool that is not in the registry. MCP tools are
built with `new AgencyFunction` (`packages/mcp/src/toolAdapter.ts`), which
does not register, and they sit in an Agency global (`mcpTools`) and in
every turn's tool list. On the reviver's own logic they come back from a
checkpoint as throwing stubs. Either there is a mid-turn resume test that
shows MCP tools surviving, in which case the mechanism it relies on is the
one to reuse here, or there is not, in which case this feature and MCP
share one bug and one fix. Add that test to Task 2's first step.

Given that, the smallest design that works: make the executor a partial
application of a registered `std::agency` helper, with the prepared
program, the export name, and the run options as bound values. The
existing reviver already restores a registered function plus its bound
values. The only new field is the definition, and revive calls the factory
with the restored executor and that definition. That is what the spec
sketches; the plan should say it this concretely and stop there.

### The coordinator's global: hold records, not functions

The spec stores `AgencyFunction` values in `generatedTools`. Store the
records instead (`{ advertisedName, definition, prepared, exportName,
options }`, all JSON) and have `getGeneratedTools()` build the callables
each turn from those records. The factory is pure and runs in-process, so
this costs nothing per turn, it matches how `learnedExtras()` rebuilds
from `meta.json` every turn, and a between-turn session restore then
needs nothing from the reviver at all. The reviver change is still needed
for a mid-turn checkpoint, but the global stops depending on it.

## Things the spec gets wrong or leaves out

### The `std::run` gate fires on every learned call, with a misleading message

Every call of a learned tool goes through `run`, so every call raises
`std::run` with the message "Running agent-generated code in subprocess",
and then the function's own effects (`std::env`, `std::fred`, and so on)
raise inside the child. For a stdlib function nothing is agent-generated.
The spec says "preserve the gate" but does not say how a user's policy
tells a learned `fredSeriesInfo` call from arbitrary model-written code.
Two small additions fix that: put `module` and `function` fields in the
gate's interrupt data when the node is a generated invocation node, and
give the generated node a stable, documented name so a policy rule can
match it. Do not start the name with `__`; `reserved-names.md` makes that
the compiler's prefix and generated Agency text trips the check.

### Next-turn availability is a UX wart with an existing cure

The spec accepts that a learned tool is usable only on the next user
turn, and defers "refresh inside an active llm call". A `handoff def`
already exists for "continue the caller's conversation from a tool"
(`docs/dev/language/handoff-functions.md`). If `learnTools` is a handoff
that, after learning, calls `llm` again with `turnTools()` including the
new records, the model can use the tool in the same turn. I have not
checked this against the one-handoff-per-round rule or the coordinator's
thread setup, so treat it as a lead, not a plan item, but it is worth an
hour before accepting "ask me again".

### The two TODOs

"TODO: what about nodes?" and "TODO: how would custom validation for args
work?" sit in the public API section. The second is answered two sections
later (validators run in the child, inside the original function), so
delete it. The first needs a one-line decision: nodes are excluded in the
first version, and `names` naming one fails with "nodes are not
supported". A plan written against a spec with open TODOs on its surface
will be re-planned.

### "Without an intervening asynchronous operation"

The agent-integration section says to validate and append "without an
intervening asynchronous operation so concurrent successful loads cannot
overwrite one another". Agency has no notion of synchronous versus
asynchronous statements that an author can rely on. What is meant is:
between the collision check and the append, make no call that can raise
an interrupt. Say that, because it is the property a reviewer can check.

### Tool name length

`session_fredSeriesInfo` is fine, but the learned catalog already guards
its prefix against the provider cap (`maxLearnedToolName`). Reuse that
check for the `session` namespace and for user-supplied namespaces, and
list it in the acceptance criteria. One over-long name fails every model
call that lists it.

### The cost of a fork per call

Each learned call forks Node, materializes the program, loads the
runtime, and runs the module's top-level code. For `fredSeriesInfo` that
is on the order of a second before the HTTP request starts, on every
call. The spec should state this where it says "each invocation starts a
fresh child run", because it is the thing a user will notice. It is the
right trade for the first version (there is no dynamic import, and the
parent did not load the module), but it is a trade, not a free property.

## Recommended shape

Three PRs, each based on main:

1. **`runFunction`.** Prepare the source with the existing
   `compileSandboxed` path, generate the invocation node with Template
   Agency, call `run`. Add `module` and `function` to the gate data.
   Tests in `tests/agency/subprocess/`. This PR is small and useful on
   its own.

2. **`learn`.** The metadata node, the TypeScript factory with
   `z.fromJSONSchema`, the reviver's creation description over a
   registered executor partial, and the mid-turn resume test that first
   establishes what happens to an unregistered tool. No public
   `createTool`.

3. **Coordinator wiring.** The records global, `getGeneratedTools()`
   building callables each turn, `learnTools` with the collision check
   and the name-length check, spread into `turnTools()`. Try the handoff
   route for same-turn use before documenting next-turn.

Dropped from the plan: per-file read approval and the second compile
entry point, the public `createTool`, the data-boundary checker, the
compatibility record, and the `withParamSchema` fix (its own PR).

## Small things in the plan

- Task 4 says "do not use `runExportedFunction` or generated serve
  invocation helpers". Good call, and the reason given (a separate root
  with no resume loop) is the right one. Keep that sentence in the dev
  doc too.
- The validation commands write logs to `/tmp`. That is fine for logs;
  the repo rule is about running `.agency` files from there.
- Task 7 adds `docs/dev/stdlib/agency-function-tools.md`. Add it to both
  the `CLAUDE.md` index and the `agency-stdlib-docs` skill, as the index
  asks.
- The "Existing code to reuse" table in the spec is the best part of the
  document. The plan should link each task back to a row of it.

## Checked against the anti-pattern catalog

Read `docs/dev/contributing/anti-patterns.md` after the review above and
checked the plan against each entry. The question that matters most is
whether the plan puts imperative complexity behind declarative
interfaces, so that section comes first.

### Declarative interfaces over imperative work: yes at the top, no one layer down

The public surface is declarative in the way the catalog asks for.
`learn(source, names, namespace)` says what you want (these exports from
this module, under this prefix) and hands back functions. `runFunction`
says "call this export with these arguments". `AgencySource` is a tagged
record that describes where code comes from, not how to read it. All of
the "how" (snapshot, mirror, adapter generation, metadata run, fork,
factory) sits behind those two calls, and the prepare-then-execute split
means `learn` and `runFunction` share one pipeline. A future change to how
a tool executes should touch the executor and nothing a caller sees.

The layer below leaks, in two places.

**`createTool`'s definition is the binder's internals written out.** A
caller must supply, per parameter, `hasDefault`, `variadic`, `aliases`,
`isFunctionTyped`, and `acceptsResult`, plus `markers`, plus a JSON
Schema whose property names must match, and the spec then explains that a
defaulted parameter may appear in the schema's `required` list while the
binder permits omission. That is the "Leaky abstractions" entry: to use
the interface you have to know how `AgencyFunction` resolves arguments.
Inside the runtime that is fine, because the one producer of a definition
is the metadata node reading a real `FuncParam[]`. Exposed from
`std::agency` it is a contract nobody outside the runtime can fill in
correctly. That is a second reason, beyond the one above, to keep the
factory private.

**The factory reaches for `UNSET`.** The spec says the factory "omits
`UNSET` values" when it turns the binder's resolved positional values
back into a named record. `UNSET` is the padding sentinel
`resolveNamed` uses internally (`agencyFunction.ts:20`). The plan should
instead add one method to `AgencyFunction` that returns the resolved
arguments as a canonical named record with omitted parameters absent, and
have the factory call it. Then the sentinel stays where it is defined,
and the next caller that needs a named view (the debugger's argument
panes are a candidate) gets the same answer.

**The coordinator side is a "how" written as a rule.** "Validate and
append without an intervening asynchronous operation" tells the
implementer how to order statements. The declarative version is a
function that takes the current records and a candidate batch and
returns either the new records or a diagnostic, with the append being the
only mutation. The record-based global recommended above gives that shape
for free.

### Duplicating existing code

Four places in the plan would write a second copy of something that
exists:

- A second way into the validated-closure compiler that accepts pre-read
  bytes, beside `compileValidatedClosure`'s own reads. Removed by the
  first cut above.
- "Keep its definition type distinct from the existing TypeScript
  `ToolDefinition`." The runtime already has `ToolDefinition`,
  `FuncParam`, and `ToolMarkers`. A definition should be built from those
  three, not from a parallel set with the same fields.
- The data-boundary checker beside `run`'s IPC serialization.
- Definition validation ("reject invalid names, duplicate or ambiguous
  parameter names/aliases") beside `canonicalKeys`,
  `assertUniqueToolNames`, and `validateToolForLLM`. The spec says to
  reuse them; the plan's task list reads as if they are being written.
  Name the existing functions in the task.

### Order-dependent mutable state

The preparation pipeline is six steps that each consume the previous
step's output and end in one prepared value, which is the good shape. The
exception was the checkpointable read-collection step, which accumulates
a snapshot across interrupt-capable reads in a fixed order; cutting it
removes the only order-dependent part. The global array in the
coordinator is mutable by nature (it is how `mcpTools` and the learned
catalog work too) and is acceptable as long as there is one writer.

### Inconsistent patterns

After this lands there will be two ways to offer an Agency function to a
model: flat parameters through `learn`, and the nested `request`
parameter with `withParamSchema` that `learnedToolFromEntry` uses for
the learned catalog. The spec argues for flat and the argument is right,
but the plan should say whether the catalog moves over later or stays
nested on purpose (a toolbox tool has one `request` parameter, so the
gain there is small). Leaving both without a sentence invites a third
way.

The per-file read approval was also an inconsistency with `compile`,
`runFile`, and `runCode`; it is covered under the cuts.

### Useless special cases

Two to watch for in implementation rather than in the plan text. A
namespace of `""` meaning "keep the original name" is a special case the
code can avoid by always joining `[namespace, exportName]` after
filtering empty parts. And `runFunction` skipping the metadata node is
not a special case but a different pipeline exit; keep it as the
prepare-then-execute split, not as an `if` inside one function.

### Tests where failures are catastrophic, and safeDelete

Task 7 pauses inside a learned call, "removes temporary artifacts", and
resumes in a fresh process. `subprocess-durable-resume` already does this
wipe. Make sure the new test deletes only a directory the test created,
through `safeDeleteDirectoryWithin`, and never the shared `.agency-tmp`
root, so a wrong path in the test cannot remove another run's materialized
program.

### Entries with nothing to report

Dynamic requires: the generated adapter uses static imports, as it must.
Nested ternaries, one-line ifs, magic numbers, single-letter names, silent
catches: these are code-level and the plan does not prescribe any. Nested
objects in types: `AgencySource` and `RunOptions` are flat.
