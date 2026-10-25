# Learning Agency functions

`std::agency` can run an exported function in a subprocess without a node
in its source module. It can also return ordinary callable values for
those functions. The coordinator uses those values to learn tools for
the current conversation.

## Call an export

`runFunction` takes a source, an export name, and named arguments:

```agency
import { runFunction } from "std::agency"

node main() {
  return runFunction(
    { kind: "module", module: "std::data/finance/fred" },
    "fredSeriesInfo",
    { seriesId: "UNRATE" },
  )
}
```

The function still raises its normal effects. A call to FRED needs its
credentials and the same approvals as a direct call. `runFunction` also
raises `std::run` before starting the child.

The other source forms are `{ kind: "file", dir, filename }` and
`{ kind: "source", source, dir? }`. The latter accepts source text or a
complete Template Agency `Code` value. `dir` confines local imports.
Execution options such as `cwd`, `wallClock`, and `maxCost` go in the
final `options` argument.

## Learn callable values

`learn` prepares the source once and returns tools with the original
parameter names, descriptions, schemas, aliases, and markers:

```agency
import { learn } from "std::agency"

node main() {
  const learned = learn(
    { kind: "module", module: "std::data/finance/fred" },
    names: ["fredSeriesInfo"],
  )
  if (learned is failure) {
    return learned
  }
  return llm("Describe the UNRATE series.", tools: learned.value)
}
```

The library does not change an agent's tools. The caller can pass the
returned functions to `llm`, derive them with `partial` or `rename`, or
call them directly. A namespace advertises `namespace_exportName`.
Without one, the exported name is unchanged.

An empty selection learns public exported defs. Selecting an unsupported
function fails the complete batch. Nodes, handoff functions, required
function arguments, and unresolved generic schemas are not supported.

Learning runs the module's top-level code once to inspect its functions.
That can pause, fail, or be rejected. It does not call the selected
function bodies. Every later invocation starts a fresh child process,
loads the prepared program, and initializes its modules. Separate calls
do not share mutable child globals. The process startup also adds cost
to each call; persistent children are outside this feature.

## Preparation and execution

Preparation resolves the source, selects exports, generates an adapter,
and compiles it with the original modules. Each step returns the input
for the next. The final prepared value contains the compiled code and
the selected export names.

Original local files keep their relative paths. Their private helpers,
imports, types, and default expressions remain in their original scope.
The sandboxed compiler applies its existing import restrictions. It
does not raise a separate read interrupt for each dependency. The
`std::run` gate controls execution, as it does for `runCode` and `runFile`.

Existing compiler limitations still apply. A re-export wrapper can fail
when a checked parameter type exists only in the source module's imports.
For that case, learn the original export directly from its source module.

The generated `invokeLearned` node dispatches named arguments through the
ordinary binder in the current child run. It uses the normal subprocess
runner, including its handlers, resource limits, cancellation, and
checkpoint behavior. An existing failure remains a failure after the
subprocess envelope is removed.

In the host run, the private execution helper supplies the source module
and export name to the `std::run` gate. Its message names the function,
and its data contains `module` and `function` for policy matching.
Source text and ordinary `run` calls leave those fields empty. Calls
from a subprocess also leave them empty: sandboxed Agency code can import hidden helpers
and construct its own prepared record, so its claimed origin is not
trusted. Naming an arbitrary node `invokeLearned` does not assign it a
learned function's identity.

These labels describe how the program was prepared. They do not verify
that saved code still matches the installed module. Checkpoints and
session files contain both the labels and the compiled code. Someone
who edits that state can retain a trusted module label while replacing
its code. A policy that approves a module by name therefore relies on
trusted saved state. See [checkpoint integrity](../runtime/checkpoint-integrity.md)
for optional signing and verification. External hosts must verify
checkpoints before resuming when they rely on that protection.

`learn` also generates a metadata node. Agency's compiler emits schema
code rather than a finished JSON Schema, so the node reads the compiled
function objects inside a child. It returns their schemas and parameter
metadata. For a file or installed module, this inspection uses the same
module label as later calls, with `function: "<inspect>"`. A policy that
approves the module covers its initialization during both inspection
and invocation. Executable validators stay in the child and run when
the original function is invoked.

The parent factory is private to the runtime. It needs the binder's
parameter metadata, which a general caller should not have to construct.
Its callable has the original flat parameters. After binding, it turns
the resolved arguments into a named record for the executor. Omitted
defaults remain absent; the child evaluates the original defaults.

This callable enters the ordinary tool loop. Alias correction, repeated
calls, failure counts, and tool removal use its advertised name and
original parameters. The factory adds no validator inferred from JSON
Schema. The original `!` checks and custom validators run in the child.

## Coordinator records

The coordinator's learning module keeps `learnedState` in an Agency
global. Its `programs` array stores each learning batch's prepared code
once. Each entry in `records` contains a `programIndex` plus the
advertised name, definition, export name, and execution options. These
values contain no functions. `getGeneratedTools()` looks up each
record's program and rebuilds the callables when the coordinator
assembles its tools.

The private helpers in `lib/stdlib/sessionTools.ts` convert the values
returned by `learn` into records. They keep executor bindings out of the
Agency coordinator code. Extraction checks that all executor bindings
are present before saving a record. The batch check returns either a
complete new state or a failure. The coordinator replaces its global immediately
after a successful check. A name collision never replaces an existing
tool. The default namespace is `session`.

Agency globals already persist between user turns and in session
checkpoints. Rebuilding from records makes a between-turn restore use
the saved prepared program, even if the original source files disappear.
A fresh run starts with empty program and record arrays.

The coordinator's `learnTools` is a handoff. It learns the functions and
continues the caller's conversation with a freshly assembled tool list.
It uses the same model and memory options as the main agent. When that
continuation finishes, `endTurn()` returns its answer to the caller. A
failed learning request returns its failure to the ordinary loop.
The scripted spike confirmed that the continuation sees the original
request and system prompt, calls the new tool in the same turn, and
leaves it available on the next user turn. No tool-loop refresh was
needed.

## Checkpoints during a call

A checkpoint inside `llm` contains the active tool list as well as the
coordinator's globals. Those callable values must survive independently
of the JSON records. The baseline test showed that an unregistered
`new AgencyFunction` restored as a stub with no parameter metadata. It
failed only when invoked. That is also the shape the MCP adapter builds;
records alone do not fix a checkpoint inside an active prompt.

A created callable carries its definition and a
registered, partially applied executor. The function reviver rebuilds
the callable and reapplies its normal derivations. It does not inspect
the source or run the metadata node again. These active tool values
still include a bound copy of their prepared program in a checkpoint
inside `llm`. Sharing programs in the coordinator global reduces the
between-turn session data; it does not deduplicate active callables.

An interrupted child resumes through the existing subprocess checkpoint
path. The prepared value carries its local module code, so restoration
does not reread or recompile those files. The existing code fingerprint
check remains responsible for refusing incompatible runtime code.

## Tests

- `tests/agency-js/coordinator-session-tools` exercises learning from an
  actual model tool call, using a scripted client. It checks the handoff's
  tool list and history, alias calls, the next user turn, failed batches,
  and a fresh conversation.
- `tests/agency-js/learned-tools-resume` learns two functions and checks
  that the between-turn session stores one program with two record
  references. A new process rebuilds both tools and calls them through
  aliases after the fixture's source directory has been deleted.
- `tests/agency-js/learned-call-resume` pauses inside an imported helper
  after a completed write. A new process resumes with both parent and
  child handlers, using saved code after the fixture's sources disappear.
  The completed write does not repeat.
- `tests/agency-js/learned-tool-parity` compares ordinary and learned
  schemas, aliases, argument errors, repeat detection, and tool removal.
- Runtime factory and function-reference tests cover derivations and
  callable restoration. Subprocess fixtures cover invocation, metadata,
  handlers, and interrupted child restoration.
