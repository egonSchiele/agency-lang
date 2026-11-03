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

## Three decisions that keep the growth small

The first draft of the design granted more than the feature needs. Each
decision below removed one way it did.

### 1. No `trustedModules` parameter on `run`

The first draft let `run`, `runFile`, and `runCode` take a list. At the root
the list would add to the config's; in a child it could only narrow.

Every Agency function is a tool, and `runCode` is one a model is told to
prefer. Consider a model at the root with write access. It writes these two
files:

```
d/evil.agency    imports ./evil.js
d/evil.js        any JavaScript
```

Then it calls `runCode(src, dir: d, trustedModules: [{ source: d, compiled: d }])`.
The sandbox would have treated `d/evil.js` as host code and loaded it outside
the sandbox. The `std::run` prompt did not show the list, so a person
approving "Running agent-generated code in subprocess" could not see it.

The parameter also did not do what it claimed. `run` takes a program that was
already compiled, so the list it took never reached the compile.

The decision: no function takes a list from Agency code. The root's list is
its config, and a child gets its parent's list unchanged.

### 2. Only `std::workflow` compiles against the list

The next draft fed the config list to every sandbox entry point. Then any
program a host process compiled through `compile` or `runCode` could import
any export of any module in a trusted directory. That includes modules the
host never offered as tools, and exports that are only safe when called in
the host's own order. A host that splits a destructive write into a check and
a write is an example. If the write half is an exported Agency function,
agent-written code could call it without the check.

Workflows do not have this problem. A generated workflow program calls only
the tools the host passed in `tools` (decision 6 of the workflows spec).

The decision: only `std::workflow`'s TypeScript helpers compile, typecheck,
and describe with the list. The public functions in `std::agency` pass an
empty list. The end-to-end test pins this: a `compile` of a program that
imports a trusted module is refused under a config that trusts it.

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

The mark in decision 3 limits that room to the runs that need it.

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
