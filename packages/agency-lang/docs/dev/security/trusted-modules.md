# Trusted modules and the sandbox

Trusted modules let a workflow call a host's tools when those tools import
TypeScript. This doc records how the feature changes what the sandbox
protects, and the decisions made to keep that change small. How the feature
works is in `docs/dev/runtime/trusted-modules.md`. The goal it is measured
against is in `docs/dev/security/goal.md`.

## What does not change

A host that does not set `sandbox.trustedModules` gets exactly the old
behaviour. The list is empty by default, and `--agency-only` never passes one.

For code that is not trusted, the sandbox refuses the same imports as before:

- a `.js` or `.ts` file, even one inside a trusted directory
- a Node module or a `pkg::` package
- a `.agency` file outside `dir`, or one reached through a symlink
- a compile-time splice

An interrupt raised inside trusted code still goes through the whole handler
chain, so a policy or a person still decides it.

## What grows, and has to

`goal.md` says the policy layer holds when the standard library is the only
door to the world, and every door raises an interrupt with a truthful
payload. With trusted modules, the doors are the standard library plus the
host's trusted directories. Whether a trusted tool raises an interrupt before
it acts is up to the host's code. Nobody reviews it the way the standard
library is reviewed.

A workflow cannot call a host's tools without trusting them, so this growth
comes with the feature. The host opts in by naming directories, and the docs
say that a trusted module is outside the sandbox by declaration.

## The invariant, and the decisions that hold it

Sandboxed code reaches host JavaScript only through function values the
host itself handed to `std::workflow`, and those values cannot be forged or
relabelled. Five decisions hold that up. Each closes one way the feature
could have granted more than a workflow needs.

### 1. No `trustedModules` parameter on `run`

A list that `run`, `runFile`, or `runCode` took as an argument would let a
model trust its own files. Every Agency function is a tool, and `runCode`
is one a model is told to prefer. With such a parameter, a model at the
root with write access writes these two files:

```
d/evil.agency    imports ./evil.js
d/evil.js        any JavaScript
```

Then it calls `runCode(src, dir: d, trustedModules: [{ source: d, compiled: d }])`,
and the sandbox treats `d/evil.js` as host code and loads it outside the
sandbox. The `std::run` prompt would not show the list, so a person
approving "Running agent-generated code in subprocess" could not see it.

The parameter would also not do what it claims. `run` takes a program that
was already compiled, so a list it took would never reach the compile.

The rule: no function takes a list from Agency code. The root's list is its
config, and a child's comes from its parent under decision 5.

### 2. Only `std::workflow` compiles against the list

If every sandbox entry point compiled with the config list, any program a
host process compiled through `compile` or `runCode` could import any export
of any module in a trusted directory. That includes modules the host never
offered as tools, and exports that are only safe when called in the host's
own order. A host that splits a destructive write into a check and a write
is an example. If the write half is an exported Agency function,
agent-written code could call it without the check.

Workflows do not have this problem. A generated workflow program calls only
the tools the host passed in `tools` (decision 6 of the workflows spec), and
`checkWorkflow` refuses a step naming any other tool.

The rule: only `std::workflow`'s TypeScript helpers compile, typecheck, and
describe with the list. The public functions in `std::agency` pass an empty
list. The end-to-end test pins this: a `compile` of a program that imports
a trusted module is refused under a config that trusts it.

### 3. A compiled program says which trusted files it loads

A compiled program carries `trustedModules`, the absolute paths of the host
files it loads. The `std::run` interrupt shows the list. This does three
things:

- A policy can refuse a run that loads host code, and a person can read the
  paths before approving.
- The containment work in `goal.md` can keep a strict child for every run
  that loads no host code, and loosen only the runs that do.
- A checkpoint resumed where the files are missing fails before the fork,
  with the path in the message.

### 4. A function value cannot be forged or relabelled

`toolRefs` turns each tool the host passed into text, a file and a name,
and the generated program imports the tool by that text. So the text has to
come from the runtime, never from anything Agency code can write. Two things
made that false at first; a review of the pull request found the first.

**A fake.** `isAgencyFunction` checked a marker key, `__agencyFunction: true`,
that an object literal can carry. Agent code could build a record naming an
export the host never offered, in a file the host trusts, and pass it to
`runWorkflow`:

```
const fake = { __agencyFunction: true, name: "deleteListNow",
               registeredName: "deleteListNow", boundArgs: null,
               params: [], paramSchemas: {},
               module: "src/agent/lists.agency",
               sourceFile: "/home/bmo/src/agent/lists.agency" }
runWorkflow(steps, inputs, [fake])
```

The file is trusted, so the child loaded the host's compiled module and the
unchecked export ran.

**A relabelled real function.** The label fields, `name`, `module`,
`registeredName`, and `sourceFile`, were `readonly` in TypeScript only,
which the compiler erases. Agent code could take one of its own functions,
assign new values through an `any` cast, and `toolRefs` read the new ones.

Aliasing is not a problem. `const other = safeDeleteList` is the same object
with the same label, and `.rename` is refused because the copy's `name`
differs from its `registeredName`.

The rule has two parts. `toolRefs` accepts a tool only when
`AgencyFunction.isBranded` says so, which checks a private field
(`#brand`). A private field cannot be set from an object literal, through
`any`, or from JSON, and a copy of an instance's properties does not carry
it. And the label (`name`, `module`, `registeredName`, `sourceFile`) is own
non-writable, non-configurable properties, defined in the constructor: an
assignment throws, since compiled modules run in strict mode, and
`Object.defineProperty` cannot redefine them. `derive`, the one way to build
a copy with a changed label, is a private method. `toolRefs` reads the same
properties as before, which the runtime now guarantees.

The runtime's own check, `isAgencyFunction`, still reads the `__agencyFunction`
marker, now an own non-writable property. The runtime relies on a raw JSON
copy of a function (its own enumerable properties, no prototype) still
reading as one, so that the next checkpoint rebuilds it from the registry by
`name` and `module`. The marker and the label survive such a copy; the brand
does not, which is why the two checks differ. Checkpoints are otherwise
unaffected: a function serializes as its name and module, and revives to the
object the registry holds, which the runtime built.

This is the object-capability rule: authority travels only as references,
and a reference cannot be made from data. Hardened JavaScript's compartments,
the WebAssembly component model's host-linked imports, and a Lua host that
puts functions into the sandbox's environment table enforce the same thing.
Three alternatives were set aside. A safelist of export names in the config
is the Java Security Manager's road, and the fake defeats it anyway, since
the fake names a listed export. Freezing every function value changes
behaviour for every function to fix one lookup. A side table keyed by
object identity does the same job as the private fields with more code.

Three limits. A private field is per copy of the class, as `instanceof` is,
so a trusted module and the child that imports it must load one copy of the
Agency runtime, which "Why the child loads the host's build" below already
requires. The checkpoint revivers turn a plain record tagged as a function
reference into the registered function by name (issue #1365), so a record a
model wrote becomes the genuine object after a clone, a fork, or a resume,
and the brand then passes; this predates trusted modules, and a workflow's
generated program never hands such a value to `toolRefs`, but host code that
passes model data as a tool list would. And the rule holds against anything
made from data, not against code that calls `Object.defineProperty`,
`Reflect`, or `Function` on a real instance. A sandboxed program can reach those today, because the sandbox
does not remove Node's globals from the child (issue #974). That is a hole
in the sandbox, not in workflows: a workflow program is generated from JSON
and runs no model-written code. Until the containment floor closes it, the
sandbox's guarantee is Agency-only source at compile time, not no
JavaScript at run time.

### 5. A child gets the list only when its program loads a trusted module

A child used to inherit its parent's list whatever it ran. A program a
model wrote and ran with `runCode` therefore had the list, and a fake built
inside it pointed at a trusted file. Decision 4 refuses the fake, but the
rule still matters: the `std::run` prompt for such a program said it loaded
no trusted files, which was true of the program and false of what it could
reach.

A sandboxed program also has no real tool to pass. A function compiled in
the sandbox records no source file, so `toolRefs` refuses it, and the only
function values with one are the standard library's. The fake was the one
way around that.

The rule: `_runFor` hands down only the entries whose compiled directory
holds a file the child's program is marked as loading (decision 3). A
program compiled without the list, as the public `compile` and `runCode`
compile, has an empty mark, so its child and every program below it compile
with no list. A workflow the host runs is marked, so a trusted tool inside
it can still run a nested workflow.

The limit: a compiled program is a plain record the calling program holds,
so Agency code can set `trustedModules`, or `code` itself, before `run`
(issue #1366). A forged mark passes down only the entries it names, and one
naming an unrelated file passes down nothing, but the prompt shows the
forged list, and a forged `code` loads whatever it likes. So the prompt's
list is truthful for a program that came from `compile` unmodified, and
"no trusted files" means no host code is reachable only for such programs.

### Where the threat model's edge is

Writing a TypeScript file into a trusted directory and rebuilding needs
write access to the host's filesystem and build. An agent with that can
edit the host's own code or `agency.json`, and the sandbox never defended
against it. Decisions 4 and 5 are about code that needs nothing but memory:
a program the sandbox already agreed to run, which is what the sandbox
exists for.

The other form of the fix, set aside: tool calls as effects. The child would
never load host code. A tool step would raise an effect naming the tool and
its arguments, and the host would run the tool in its own process. That
keeps the sandbox Agency-only, at the cost of an IPC round trip per step,
limits accounting across the hop, and a redesign. The brand is proportionate
to the hole. The effect form is the long-term shape of brokering, below.

## The conflict with containment

`goal.md` plans a capability-restricted child: its filesystem scoped to a
working directory, no child processes, an allow-listed environment, and in
the end brokering, where the child performs no effects and the parent
performs each approved one.

Trusted modules pull the other way. A host's tool loaded in the child may
need database credentials in its environment, network access to the
database, and real filesystem access. A child that loads one cannot have the
full floor. Today a child inherits the parent's whole environment anyway, so
nothing is lost yet. But this is the first feature the containment work will
have to make room for.

The mark in decision 3 limits that room to the runs that need it, and decision 5 keeps the list out of every other child.

The long-term form is brokering of tool calls. The child would ask the parent
to call a host tool with given arguments, and the parent would run it.
Interrupts already cross that boundary, so this fits the rest of the design.
It needs new machinery for a host tool that pauses while the child waits, so
it is not part of this feature. The config and the compile-time rules stay
the same if the call later moves to the parent.

## Smaller risks that remain

- **A trusted directory trusts every module in it.** A module's top-level
  statements run when it is imported. A generated workflow imports only the
  modules its tools live in, so a module the host did not offer is never
  loaded.
- **A stale build.** The checker reads the source and the child runs the
  compiled file. If the two differ, a workflow can pass its check and then run
  older code. The host's own process has the same problem.
- **Absolute paths in checkpoints.** The compiled program names the host's
  files by absolute path, so it is no longer self-contained. The existence
  check in decision 3 makes a move fail with a clear message.

## Why the child loads the host's build

TypeScript's source and output layouts are hard to resolve from outside a
build. Path aliases, an inferred `rootDir`, and post-processing such as
`tsc-alias` all change where a file ends up. The design does not resolve any
TypeScript path itself. The host says where its compiled module is, the child
imports that file by absolute path, and Node follows the file's own imports as
it does in the host's process.

The one assumption is that the compiled file sits at the same place under
`compiled` as the source does under `source`, with `.agency` changed to `.js`.
That holds for `agency compile`, and for `tsc` with an explicit `rootDir`. A
bundler, an inferred `rootDir`, or `.mjs` output breaks it. In each of those
cases the missing-file check refuses the import with the path it looked for.

The child's code and the host's compiled file must load one copy of the
Agency runtime. The child's code is written under the Agency package root, and
the host's file resolves `agency-lang` from its own `node_modules`. With pnpm
both resolve to the same file in the store, so there is one copy.
