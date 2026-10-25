# Learn Agency functions as session tools

Status: implemented. Created 2026-10-24; revised 2026-10-25 after review
([review](../plans/2026-10-25-session-tools-review.md)).

## Goal

A user can give the Agency agent an Agency module and ask it to learn its exported functions for the current conversation. The agent can then call those functions as ordinary tools. Their descriptions, parameter schemas, aliases, argument errors, validators, and tool-loop protections retain their usual behavior.

For example, the user asks the agent to learn `fredSeriesInfo` from `std::data/finance/fred`. The coordinator gets a tool with the exact `fredSeriesInfo` name, schema, and description, including any parameter aliases, validation etc. The model calls it with `{ "seriesId": "UNRATE" }`. Its implementation runs in an Agency subprocess under the existing parent handlers.

The public library operations are:

| Operation | Responsibility |
| --- | --- |
| `runFunction` | Execute an exported function from Agency source or a file in a subprocess. |
| `learn` | Inspect exported functions and return tools that execute them through the subprocess runner. |

Both belong to `std::agency` and work independently of the Agency agent. A third piece, the factory that turns a compiled function's metadata into a parent-side callable, is a runtime helper that `learn` uses. It is not exported from `std::agency`: its input is the argument binder's own metadata, which nothing outside the runtime can fill in correctly. If a second caller appears, it can be exported then with the contract it has proven.

The coordinator keeps a global array of records describing what was learned and builds the tools from those records on every turn.

## Example

The following uses the proposed API:

~~~agency
import { learn } from "std::agency"

node main() {
  const tools = learn(
    { kind: "module", module: "std::data/finance/fred" },
    names: ["fredSeriesInfo"]
  )
  if (tools is failure) {
    return tools
  }
  return llm("Describe the UNRATE series.", tools: tools.value)
}
~~~

`learn` returns ordinary function values. A caller may invoke one directly or pass it to `llm`. Learning alone does not change another agent's tool list.

## Public API

The signatures below describe the contract. `Tool` denotes the existing callable runtime value; implementation uses the language's existing function-value representation without introducing a new language type.

~~~text
runFunction(source: AgencySource, functionName: string,
            args: Record<string, any> = {}, options: RunOptions = {}): Result

learn(source: AgencySource, names: string[] = [],
      namespace: string = "", options: RunOptions = {}): Result<Tool[]>
~~~

### Source and execution options

`AgencySource` makes the input form explicit:

| Kind | Fields | Meaning |
| --- | --- | --- |
| `module` | `module` | An installed stdlib module, such as `std::data/finance/fred`. |
| `file` | `dir`, `filename` | An Agency file within `dir`. Preserve the file's relative location for its imports. |
| `source` | `source`, optional `dir` | Source text or a complete Template Agency `Code` value. Local imports resolve within `dir`. |

Unfilled template holes are an error. An omitted `dir` permits no local imports. Documentation URLs are read by the agent's existing reading tools; the agent resolves them to code or a module before calling `learn`.

`RunOptions` carries the existing `run` execution settings: `wallClock`, `memory`, `ipcPayload`, `stdout`, `logFile`, `cwd`, `maxDepth`, and `maxCost`. Omitted fields use `run`'s defaults. Learning binds these options into each returned tool. They are not added to the original function's advertised parameters.

`dir` controls import resolution. `cwd` controls the subprocess working directory. Temporary compiled files continue to use the runner's existing managed directory and cleanup.

### runFunction

`runFunction` resolves the requested public export, generates an entry node, compiles the program, and calls the existing `run` operation. It supports functions that have no node in their source module.

The generated entry imports the original function. It preserves that module's private helpers, types, imports, and default expressions. It does not copy the function body into a new scope.

Arguments are a named record. Unknown and missing names, alias conflicts, and variadic errors use ordinary Agency argument binding. External argument aliases are accepted. A programmatic call preserves explicit `null` under canonical parameter names. Null-valued alias keys follow the existing alias rule and count as absent. A model call through a learned tool first applies the existing model-specific null/default normalization.

Return a `Result` using ordinary Agency result normalization. Unwrap the subprocess envelope, preserve an existing function success or failure, and wrap a plain value once. Preserve failure details such as rejection, `neverStarted`, and `destructiveRan`. Do not turn a failed function into a successful tool result.

Split preparation and execution internally. A direct `runFunction` call prepares its source for that call. `learn` prepares once and binds the resulting compiled value into the same execution helper. It does not read and recompile the source on every tool invocation. This internal prepared form is not a public API.

### learn

`learn` obtains the selected exported functions' compiled definitions and passes each to the factory. Each executor is the private execution helper, partially applied to the prepared program, the original export name, and the execution options.

An empty `names` list selects public exported `def` functions. Types, nodes, constants, hidden exports, and internal names are excluded. Nodes are not supported in this version: naming one in `names` fails with a message that says so. Explicit selection of a missing or unsupported export fails the call. An unsupported selected function, including one selected by the default, fails the complete batch with its name and reason. The caller can retry with a narrower selection. An empty selection after discovery is a failure.

An optional namespace advertises `<namespace>_<exportName>`. An empty namespace preserves the original name. Namespace changes do not change the original export that executes. A name longer than the provider cap (`MAX_TOOL_NAME_LEN` in `std::skills`) fails the batch, because one over-long name fails every model call that lists it.

Validate the whole batch before returning it. `learn` returns an array on success and a diagnostic on failure. It does not register tools in a particular agent, install packages, save permanent toolbox entries, or approve execution effects.

### The factory (runtime, not exported)

The factory returns a normal `AgencyFunction`. It takes a serializable definition and an executor: a registered Agency function, or a partial application of one with serializable bound values, that accepts one canonical named-argument record.

The definition is built from the runtime's existing types, not from a parallel set with the same fields:

| Definition field | Type |
| --- | --- |
| `name` | string: the advertised and callable name. |
| `description` | string: shown to the model. |
| `inputSchema` | JSON Schema for the complete parameter object. |
| `params` | the existing `FuncParam[]`, with `defaultValue` left out. |
| `markers` | the existing `ToolMarkers`. |

The factory converts `inputSchema` to a Zod object schema with `z.fromJSONSchema`, the same call `withParamSchema` uses, so `partial` can reduce it with the existing `buildReducedSchema` and the provider sees the compiler's own schema. Validation reuses the existing checks: the ordinary binder uses `canonicalKeys` for alias conflicts, `assertUniqueToolNames` rejects duplicate advertised names, and `AgencyFunction.validateForLLM()` checks tool eligibility. Namespace-derived names also obey the provider character and length limits. A defaulted or variadic field may appear in the schema's `required` list while the binder permits omission; the factory does not equate the two.

The binder resolves the model's arguments as it does for any function. The factory then asks the `AgencyFunction` for those resolved arguments as a canonical named record, through one new method on `AgencyFunction` that leaves omitted parameters absent and keeps a variadic parameter as one array. The factory never reads the binder's internal padding sentinel. It invokes the executor with the current `Run` and returns the result unchanged.

`hasDefault` permits omission. The executor receives no key for an omitted parameter. The factory does not evaluate a default expression or apply a JSON Schema `default` value; the original function supplies its own default in the subprocess.

Created functions support normal derivations, including `partial`, `rename`, and `describe`.

## Preserving ordinary tool behavior

The learned callable has the original flat parameter list. The named record used by `runFunction` is an internal transport value. It does not replace the model-facing signature.

| Behavior | How it is preserved |
| --- | --- |
| Description and schema | Copy the original compiled tool definition. |
| Unknown and missing names | Use the existing parent-side `AgencyFunction` binder. Errors name the original parameters. |
| Parameter aliases | Retain aliases in `params` so the normal tool loop corrects them before dispatch, logging, and repeat-key construction. |
| Defaults | Retain default-presence flags. Omit absent values during transport. Evaluate defaults in the original function. |
| Variadics and failure-valued arguments | Retain their parameter metadata and use normal binding. |
| `!` checks and `@validate` | Invoke the original compiled function, which runs its own checks in the subprocess. |
| Repeated calls, rejection counts, and removal | Offer an ordinary callable under its own name to the existing tool loop. |
| Failure advice and destructive-work tracking | Preserve callable markers and the original returned failure data. |

JSON Schema describes the call to the model. It does not replace executable validators. Keep custom validators and their dependencies in the original module. Do not infer validation behavior from JSON Schema or add runtime type checks that an ordinary unchecked parameter would not perform.

A renamed partial application of the generic runner (the shape `learnedToolFromEntry` uses for the learned catalog) would still receive tool-loop protections, but its parameter metadata would describe the runner, so alias correction, per-parameter errors, and repeat keys would describe `request` rather than the original parameters. That is why this feature builds flat parameters. The learned catalog keeps its nested `request` on purpose: a toolbox tool has exactly one parameter, so flat parameters gain it nothing.

## Preparation and imports

Preparation uses the same import rules and the same reads as `compile`, `runFile`, and `runCode`: the sandboxed compiler reads `.agency` files under `dir`, with `dir` as the confinement boundary, and refuses symlinks, escapes, JS/TS modules, Node imports, `pkg::` imports, and compile-time splices anywhere in the closure. No per-file read interrupt is raised, because none of those functions raises one; the gate is the `std::run` interrupt before any code executes. Making `learn` the one function that asks per file would buy no safety (a model can already `runCode` the same file) and would need a second compile entry point. If per-file approval is ever wanted, it is a change to `compile` for every caller, made separately.

Reuse `describe`'s internals, the AST utilities, Template Agency, and the compiler's existing schema generation. Resolve exports against the parsed closure, including local re-exports; the public `describe(source)` cannot resolve a local re-export from a bare string, so the implementation calls the same internals with the closure in hand rather than introducing a second signature parser.

Preparation performs these steps, each consuming the previous step's output and ending in one prepared value:

1. Resolve the source kind to an entry (a `std::` import line, or a file under `dir`, or source text).
2. Resolve the selected public exported defs against the parsed closure.
3. Generate an adapter that statically imports the selected original functions and exports the invocation node (and, for `learn`, the metadata node).
4. Compile the adapter and original modules together with the existing sandboxed compile.
5. For `learn`, run the metadata node in a subprocess to obtain the compiled descriptions, schemas, parameter metadata, and markers.
6. For `learn`, create the parent callables from those definitions.

A direct `runFunction` call stops after step 4 and runs the invocation node. It does not need a separate metadata run that would initialize the module a second time.

Keep each original file at its relative position in the compiler's validated mirror, so `nested/tools.agency` still finds `./helper.agency`. Add the generated adapter as a new entry. Do not flatten the original module into the adapter.

The compiled program already carries the local module code, and the existing resume path re-materializes from that code rather than recompiling. Retain the compiled value in the prepared value so later calls and resumes do not depend on the original local files. The existing checkpoint code fingerprint check (`docs/dev/runtime/checkpoint-code-fingerprints.md`) is what refuses a resume across changed code; this feature adds no second mechanism.

### Metadata execution

There is no compile-time way to produce a JSON Schema from an Agency type: the generator emits schema code into the compiled module (`typeToZodSchema.ts`), and the schema exists only once that module runs. So `learn` runs a metadata node once, in a subprocess, the way `std::toolbox` runs a saved tool's `requestSchema` node. The node reads the original compiled function objects and returns their `toolDefinition` and `params` data, with default expressions and validators left out. Import originals directly so generated re-export wrappers do not discard descriptions. Preserve source export names separately from generated import aliases. Read markers from the actual callable re-export wrapper when it adds an override.

Metadata execution uses `run` and its normal gate, limits, handlers, and checkpoint behavior. Loading a module runs its top-level code, so `learn` can pause, be rejected, or fail before any function is called. The `learn` docstring says so. Learning does not invoke the selected function bodies.

## Subprocess invocation

Generate an exported invocation node, named `invokeLearned`, that takes the export name and a named-argument record and dispatches to the selected imported function through normal named-call dispatch in the current child `Run`. Resolve names only against the selected exports. Keep the call inside the generated node's resumable execution. Do not use the served-function entry point, which creates a separate root invocation and has no checkpoint/restore loop. The generated node's name does not start with `__`, because that prefix belongs to the compiler (`docs/dev/language/reserved-names.md`). Generated nodes never become learned tools.

The parent adapter uses the existing `std::agency.run` path. Preserve the `std::run` gate, cost accounting, cancellation, callbacks, and resource limits. Do not bypass it with a direct call to the low-level subprocess implementation.

Every learned call raises the `std::run` gate, and the function's own effects raise inside the child, so a user approves both. The gate's message today says "Running agent-generated code in subprocess", which is wrong for a stdlib function and gives a policy nothing to match on. The prepared execution path supplies `module` (the source module or file) and `function` (the export name), and the message names them. Only launches from the trusted host program carry these policy hints. A sandboxed descendant always raises the generic gate with empty identity fields: it can import hidden stdlib helpers and construct their arguments, so its claimed identity is not authoritative. Naming an ordinary node `invokeLearned` supplies no identity. This lets a parent policy approve its own prepared calls without trusting a child's labels.

Omitted defaults remain absent across IPC. Do not serialize the binder's padding sentinel or substitute `null`. Arguments and results travel the way every `run` argument travels; this feature adds no checker of its own, and a value `run` mishandles is fixed in `run`.

Each invocation starts a fresh child run: a Node process is forked, the program is materialized, the runtime loads, and the module's top-level code runs, which costs on the order of a second before the function body starts. Two learned functions do not share mutable module globals between separate calls. An interrupted call resumes its own saved state. Metadata inspection also has its own run.

## Agent integration and lifetime

The coordinator's learning module keeps records, not function values:

~~~agency
type LearnedRecord = {
  advertisedName: string;
  definition: any;
  prepared: any;
  exportName: string;
  options: any
}

let learnedRecords: LearnedRecord[] = []

export def getGeneratedTools(): any[] {
  return map(learnedRecords, toolFromRecord)
}
~~~

`toolFromRecord` calls the factory, which is pure and runs in-process, so rebuilding on every turn costs nothing and matches how `learnedExtras()` rebuilds from `meta.json`. A between-turn session restore then needs nothing from the function reviver: the global holds JSON.

The agent-facing `learnTools` calls the library `learn` and uses the namespace `session` by default, with an optional user-supplied namespace. Names are checked against the records already held and the other tools the turn offers; a collision fails the batch without renaming or replacing anything, and a repeated request for the same names reports that they already exist. The check and the append are one function from the current records and the candidate batch to either the new records or a diagnostic, with no call between them that can raise an interrupt, so two loads cannot interleave.

Spread `getGeneratedTools()` into the existing `turnTools()` result. The handoff experiment succeeded: `learnTools` is a coordinator-local `handoff def` that continues the caller's conversation with a rebuilt tool list. It preserves the main model options and the original turn clock, then calls `endTurn()` when the continuation finishes. The tools are available immediately and on subsequent user turns. A failed learning request returns to the ordinary tool loop.

Agency globals already survive turns and participate in checkpoints. Do not clear the array during coordinator initialization for a resumed run. A fresh conversation starts with the empty declaration.

## Callable restoration

A mid-turn checkpoint (an interrupt raised while the coordinator's `llm` call is running) holds the turn's tool list in frame locals, so a created callable must come back from a checkpoint. The function reviver finds a function by its registered `module:name`, and a factory-built value is not registered.

Before designing anything, pin down what happens today to an unregistered tool in a tool list across a mid-turn resume. MCP tools are built with `new AgencyFunction` (`packages/mcp/src/toolAdapter.ts`), which does not register, and they sit in an Agency global. Either a test shows them surviving, and the mechanism it relies on is the one to reuse, or they come back as throwing stubs, and this feature and MCP share one bug.

The baseline test found that an unregistered tool becomes a throwing stub and loses its parameter schema. A fresh-process test confirms this behavior. Arbitrary MCP closures remain outside this fix; the created-tool recipe requires a registered executor. The implemented restoration path is: the executor is a partial application of a registered `std::agency` helper, which the reviver already restores with its bound values, and the serialized form carries `{ definition, executor }`. The executor keeps the partially bound prepared program and execution options. Revive calls the factory with the restored executor and the definition. Derivations (`rename`, `partial`, `describe`) restore through the reviver's existing path. Restoring a handle must not reexecute the metadata node or recompile.

The reviver's existing loss of `withParamSchema` overrides is a separate bug in the learned catalog and is fixed in its own change, not here.

## Safety

Learning grants no permission to execute the learned function or its effects. Metadata execution and calls use their existing effect paths.

Preserve the current distributed handler rules: rejection wins; otherwise propagation requires a user decision; otherwise an approval permits execution. A parent handler that passes still permits an inner approval. Parent and child handlers must both be registered before a paused action resumes.

The feature inherits `run`'s security guarantees and limitations. It does not introduce an operating-system sandbox or broaden the allowed import kinds.

## Scope and deferred work

The first version supports exported Agency `def` functions whose model-callable inputs and results can cross the subprocess boundary. Ordinary imported helpers, imported types, concrete schemas, defaulted parameters, and variadics are supported. Functions with required function/block arguments, unresolved generic tool schemas, or handoff behavior return explicit unsupported-signature errors. Nodes are not supported.

Persistent child processes, live file watching, tool removal APIs, propagation to subagents, and (unless the handoff spike succeeds) refresh inside an active `llm` call are deferred.

Saving permanent wrappers or exporting a reusable bundle is deferred. The original module remains reusable, and a program can call `learn` again explicitly.

External agents can already use `agency serve mcp file.agency` for a fixed module. Dynamic MCP loading and an external approval/resume protocol are separate work. The library functions here remain independent of the coordinator so those integrations can reuse them later.

## Acceptance criteria

Use deterministic fixtures and scripted model clients.

| Case | Required result |
| --- | --- |
| Public APIs | `runFunction` calls an exported function with no source node; `learn` returns callable values without changing agent globals. |
| Schema parity | Direct and learned tools advertise equivalent original parameter schemas and descriptions, including imported aliases and schema annotations; the Zod → JSON → Zod → JSON round trip of the fixture types is equal. |
| Argument parity | Missing/unknown names, alias corrections/conflicts, null/default handling, variadics, and failure-valued arguments behave like ordinary calls. |
| Validation parity | Original `!` and custom validators reject the same inputs and prevent the function body from running. Unchecked parameters keep their existing behavior. |
| Tool-loop parity | Corrected aliases produce the same repeat key. Independently named tools retain separate failure/removal counts. Markers and failure flags retain their meaning. |
| Imports | Nested paths, private helpers, imported types, and transitive dependencies work. Prepared calls still work after original local files change or disappear. |
| Refused code | A forbidden import, a splice, or a JavaScript global outside the allowlist fails `learn` and adds no tools. |
| Gate data | The `std::run` interrupt for a learned call carries `module` and `function`, and a policy rule matching them approves it. |
| Result transport | Plain values and existing Results return correctly. Nested failures retain their data. |
| Handler chain | Child approvals cannot defeat parent rejection or propagation. Test an imported helper and a nested subprocess. |
| Callable restoration | A created and derived tool survives JSON serialization and fresh-process restore with its full schema, aliases, bindings, and executor. |
| Subprocess restoration | Pause inside the learned function, remove the test's own temporary artifacts, and resume in a fresh process. Completed side effects do not repeat. |
| Coordinator | A scripted model learns in one user turn and calls the tool in the next. Inspect the actual second-turn model request. |
| Names | A namespace or export name over the provider cap fails the batch; a collision with an offered tool fails it. |
| Session isolation | The same conversation retains tools after restore; a fresh conversation starts empty. Separate calls have fresh child globals. |
| Batch failure | Unsupported exports or name collisions leave the existing records unchanged. |

The implementation plan is [Session tools implementation plan](../plans/2026-10-25-session-tools.md).

## Existing code to reuse

| Area | Reference |
| --- | --- |
| Public compile/run, inspection, and templates | [stdlib/agency.agency](../../../stdlib/agency.agency) |
| Callable metadata, binding, and derivation | [agencyFunction.ts](../../../lib/runtime/agencyFunction.ts) |
| Alias/default normalization and tool results | [toolInvocation.ts](../../../lib/runtime/toolInvocation.ts) |
| JSON Schema to Zod | `withParamSchema` in [agencyFunction.ts](../../../lib/runtime/agencyFunction.ts) |
| Existing dynamic callable example | [MCP toolAdapter.ts](../../../../mcp/src/toolAdapter.ts) |
| Sandboxed compile and the validated mirror | [compileValidatedClosure.ts](../../../lib/compiler/compileValidatedClosure.ts) |
| Metadata-node precedent | `requestSchema` in [stdlib/toolbox.agency](../../../stdlib/toolbox.agency) |
| Subprocess handlers and resume | [subprocess-ipc.md](../../dev/runtime/subprocess-ipc.md) |
| Parent function restoration | [functionRefReviver.ts](../../../lib/runtime/revivers/functionRefReviver.ts) |
| Name cap | `MAX_TOOL_NAME_LEN` in `std::skills`, `maxLearnedToolName` in [learned.agency](../../../lib/agents/agency-agent/lib/learned.agency) |
| Coordinator learning and tool list | [learn.agency](../../../lib/agents/agency-agent/brains/coordinator/learn.agency), [coordinator.agency](../../../lib/agents/agency-agent/brains/coordinator/coordinator.agency) |
