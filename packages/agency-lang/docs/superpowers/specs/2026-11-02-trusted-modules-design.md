# Trusted modules: letting a subprocess import host-approved TypeScript

Linear: ADI-257 (milestone 3 of the Workflows project). The ticket calls
this `allowedImports`. Read `docs/dev/security/goal.md`,
`docs/dev/runtime/subprocess-ipc.md`, and decision 8 in
`docs/superpowers/specs/2026-10-26-workflows-design.md` first.

## The problem

A workflow runs in a subprocess, and the program it runs is compiled in the
sandbox. The closure validator (`lib/compiler/closureValidator.ts`) walks
every import from the entry and refuses anything that is not a `std::`
module or a `.agency` file inside `dir`. That rule is what makes the
sandbox mean something: code an agent wrote can reach the world only
through the standard library, where every effect raises an interrupt.

BMO's tools are `.agency` modules whose bodies call TypeScript:

```
$ agency workflow tools ./src/agent/lists.agency
./src/agent/lists.agency: cannot read its exports: describe refused
./src/agent/lists.agency: /Users/adit/bmo/src/agent/lists.agency imports
'../backend/lib/agentToolErrors.js', which is not Agency source (only
.agency files may be imported in sandboxed code); ...
```

So a workflow cannot call a BMO tool, `catalog` cannot list one, and
`checkWorkflow` cannot check a step that names one. The same validator
runs in all three places: `compileToProgram` for `run`, and
`describedFilePath` in `lib/stdlib/agencyFunctions.ts` for `describe`,
which `catalog` and `_signatures` in `std::workflow` call.

The ticket proposes a list of TypeScript files the host approves for the
child's import closure. Two facts about how a child is built mean a list
of files is not enough on its own:

1. **The child's code does not live where the sources do.** The sandbox
   compiles each `.agency` file from a private mirror and
   `materializeCompiledScript` writes the output under
   `<agency-lang package root>/.agency-tmp/<id>/`, laid out at the files'
   paths relative to `dir`. A compiled `src/agent/lists.js` there says
   `import ... from "../backend/lib/lists/agentTools.js"`, which resolves
   to a path inside `.agency-tmp` where nothing exists. The validator
   refuses absolute imports for the same reason in reverse: from inside
   the mirror they would reach the original files.

2. **The approved file may not exist beside the source at all.** BMO's
   `.agency` sources import `../backend/lib/x.js`, but no such file exists
   under `src/`: `tsc` writes it to `dist/backend/lib/x.js`, beside
   `dist/agent/lists.js`, which is the compiled form of the same `.agency`
   module. The relative import is right only in `dist`. Approving
   `src/backend/lib/x.js` approves a file that is not there.

Both say the same thing. A host that imports TypeScript already has a
build, and that build already produced the compiled module the host
itself runs. The child should run that module, not compile the source
again somewhere the imports cannot resolve.

## The design

A **trusted module** is a `.agency` module the host vouches for: the host
names the directory its sources are in and the directory their compiled
JavaScript is in. The child imports the compiled JavaScript as it is. The
sandbox does not walk into a trusted module, does not compile it, and
does not check what it imports, because the host already runs that code
in its own process and has nothing to gain from the sandbox checking it.

The host declares them in `agency.json`:

```json
{
  "sandbox": {
    "trustedModules": [
      { "source": "src/agent", "compiled": "dist/agent" }
    ]
  }
}
```

Both paths are relative to the working directory, as `client.providerModules`
are, and are resolved to real paths when the list is first used. A project
whose compiled files sit beside the sources, as `agency compile` writes
them, names the same directory twice.

### What changes where

**The closure validator** takes the trusted list. When an import from a
validated file resolves, by real path, to a file under a trusted `source`
directory, validation stops there: the module is recorded as trusted, its
source is read only so the typechecker can see its signatures from the
mirror, and none of its imports is checked. Every other rule stays: the import must be relative, must not
pass through a symlink, and must end in `.agency`. A `.js` or `.ts` import
from a *validated* file is still refused. Trust attaches to the `.agency`
module as a whole, never to one of its TypeScript helpers.

**The compiler** emits a trusted import as an absolute path to the
compiled file: `source` is swapped for `compiled` and `.agency` for
`.js`. The rewrite is one more case in `CompileStrategy.rewriteImport`,
driven by the validated closure, which already knows which imports it
stopped at. The compiled program carries the entry and any validated
`.agency` modules, as today, and nothing from the trusted directories.

**The compiled file must exist.** The validator checks it when it stops
the walk, so a missing build fails `compile`, `checkWorkflow`, and
`runWorkflow` before `std::workflow::run` is raised, with a message that
names the `.agency` module and the compiled path it looked for. A stale
build is the host's problem, as it is for the host's own process.

**`describe`** reads a trusted module's source for its signatures,
docstrings, and effects, as it reads any module. The only change is that
`describedFilePath` no longer refuses the file for its TypeScript imports,
because the validator no longer does. `catalog`, `checkWorkflow`, and the
`agency workflow` commands get this for free.

**The typechecker** is unchanged. It already typechecks BMO's modules with
their `.js` imports every build.

### How the child learns the list, and why it cannot widen it

The list rides in the `run` and `resume` instructions the parent sends,
beside `maxDepth`, and the bootstrap seeds it into `SubprocessRunInfo`
before the compiled module is imported, as it seeds `maxDepth` today. A
child uses the inherited list as it is. The root process reads
its list from its config; a subprocess has no config of its own, because
it is compiled in the sandbox, and `configOverrides` does not carry the
list, so there is no second path by which a child could receive one.

Only `std::workflow` compiles against the list. Its own TypeScript helpers
read the list and call the compiler; the public `compile`, `typecheck`,
`describe`, `run`, `runFile`, and `runCode` pass an empty list and refuse a
trusted module as they do today. Sandboxed code cannot import those
helpers, since they are a TypeScript module, and cannot build a workflow
over a trusted tool, since it cannot import the tool's module to get the
function value. So a trusted module is reachable only through a tool list
the host supplied, which is decision 6 of the workflows spec applied to
the sandbox. When `run` or `runFile` need the same, the helpers are there
to call; widening is a deliberate step, not a default.

A compiled program carries `trustedModules`, the absolute compiled paths it
loads, as plain data on the value that already travels in checkpoints. The
`std::run` interrupt shows it, so a policy can refuse a program that loads
host code, or a person can see the paths before approving, and a
checkpoint resumed where the files are missing fails before the fork with
the path named.

A child gets its parent's list unchanged, and that is the whole rule. No
function takes a list as an argument from Agency code: `run` has no
`trustedModules` parameter. A parameter was considered and set aside,
because every function is a tool, so a model at the root could name a
directory it had just written to and have its own JavaScript imported as
trusted, and the `std::run` prompt would not show it. The list the sandbox
compiles against and the list a child receives are the same value, read
from the config at the root. The `std::run` interrupt carries the
program's own mark, the trusted files it loads, so a policy or a person
can see what host code a run would load.

Trusted code itself is not constrained by any of this, and cannot be: it
is the host's own code, running in the child with everything the host
gave the child. It can call `run` with any list it likes. That is the
same authority it has in the host process, which is the point of calling
it trusted.

### What this protects, stated plainly

The sandbox keeps everything it protects today for code that is not
trusted. A workflow program, or anything an agent compiles through
`compile`, still reaches the world only through `std::` modules and
through the trusted modules the host named. It cannot name a trusted
module the host did not list, cannot import a TypeScript file of its own,
and cannot import a file beside a trusted module that is not itself a
`.agency` module in a trusted directory. Decision 6 of the workflows spec
adds the tighter rule for workflows: a step can only call a function the
host passed in `tools`, so even inside a trusted directory a workflow
reaches only the functions BMO offered. Trusting a directory trusts every
`.agency` module in it, and a module's top-level statements run when it is
imported, but the generated program imports only the modules those tools
live in, so a module the host did not offer is never loaded.

Path aliases, as TypeScript's `paths` gives, were considered as the way
to name trusted imports and set aside. Once the child loads one host
JavaScript file, Node follows that file's own imports and Agency sees
none of them, so naming files more precisely does not make the boundary
tighter: the unit of trust is the host's build, whatever the names say.
Aliases would also mean the sandbox compiling the host's `.agency` modules
itself, under name checks written for agent code, and would still need
the absolute rewrite into the compiled directory. They are a fair general
feature for Agency's imports and compose with this design; they are not
part of it.

What it does not protect is the trusted code, and nobody should read
"sandboxed" as covering it. A trusted module runs with the child's
environment and filesystem, and the subprocess limits (wall clock,
memory, output) and the handler chain are what bound it, exactly as they
bound the same module in a job or a chat. For BMO this is the right
trade: the tools are what the chat model can already call, under the
same approval policy.

`agency run --agency-only` ignores the list. That flag means pure Agency,
and a trusted module is the opposite claim.

## Decisions, and why

**1. Directories of modules, not a list of files.** *Why:* the ticket's
list of TypeScript files cannot be honoured, as "The problem" shows: the
files are not where the imports say, and the compiled module is not where
the child looks. A directory pair says what the host means, "run my
compiled tools", in one line that does not go stale when a tool is added.

**2. The child imports the host's compiled JavaScript; nothing in a
trusted directory is compiled by the sandbox.** *Why:* the host's build is
the only place where the `.agency` module and its TypeScript helpers
resolve against each other. Compiling the source again would need the
same build, and a sandbox compile under `jsGlobals: "sandbox"` would
refuse ordinary host code. It also means the child runs the very code the
host runs, which is what "trusted" should mean, and that a workflow run
does not compile BMO's eight thousand lines of agent every time.

**3. The list lives in config and rides to the child beside `maxDepth`.**
*Why:* BMO never calls `run`; `runWorkflow` does, and so do `workflowTool`
and the `agency workflow` commands. One declaration in `agency.json`
reaches all of them. The child must get it by a path a child cannot
write, and `SubprocessRunInfo`, seeded by the bootstrap from the parent's
message, is that path. Carrying it in `configOverrides` would give the
`run` parameter a second meaning and let an override widen it.

**4. No narrowing, and no parameter: a child's list is its parent's.**
*Why:* a parameter on `run` never reaches `compile`, which is where the
list decides anything, and at the root a model could widen it. Nothing
needs narrowing yet; BMO never calls `run`. If a host does, the parameter
goes on `compile` as well as `run`, and the `std::run` data already shows
the list.

**5a. Workflows only.** *Why:* with a general list, any sandboxed program
could import a host's tool modules and call every function in them,
including reads that raise no interrupt. A workflow reaches only the
functions the host passed, and sandboxed code cannot obtain those values.
Keeping the list behind `std::workflow` keeps that rule, and the plumbing
is the same if `run` needs it later.

**5b. A compiled program is marked with the trusted files it loads.**
*Why:* a policy decides per action from the interrupt's data, and
"does this program load host code" is a question a policy will ask. The
mark costs a list the validator already holds, and adding it later would
leave old checkpoints unmarked.

**5. The validator stops checking at a trusted module.** It reads the
source to mirror it, so the entry typechecks against real signatures, and
follows its `.agency` imports into other trusted modules for the same
reason, and every `.agency` file reachable from a trusted module is
mirrored the same way, wherever it sits under `dir`, so the typechecker
and the closure builder see a complete tree; none of it is compiled, and
no rule applies to anything a trusted module imports. A trusted module
must still sit inside `dir`, since the mirror places a file only at its
path relative to `dir`, and must not be reached through a symlink.
*Why:* checking would mean deciding what to do with those imports, and
there is no good answer: refuse them, and nothing is gained; validate
them, and the validator is checking host code it does not run. Trust is a
boundary, so the rules stop at it.

**6. A missing compiled file is refused at check time, not discovered at
run time.** *Why:* `runWorkflow` asks the user to approve a run after the
check. An approval for a run that would fail on its first import is a
wasted prompt, and the failure would name a Node resolution error instead
of the module.

## Tests

- `tests/agency/subprocess`: a fixture directory with `tools.agency`
  importing `helper.js`, both checked in, trusted as source and compiled
  in one. A workflow that calls the tool runs. The same workflow with no
  trusted modules is refused with the message quoted above. A workflow
  whose entry imports `helper.js` directly is refused: trust is for
  modules, not files.
- A grandchild, started by a trusted tool, cannot import from a
  directory outside the root's list, and can import from one inside it.
- `describe`, `catalog`, and `checkWorkflow` on the trusted tool module
  succeed and report its signature and effects.
- A trusted entry whose compiled file is missing fails `compile` with a
  message naming the module and the path, before any run interrupt.
- A trusted `source` directory reached through a symlink is refused, as a
  local import is today.
- The import a compiled entry emits for a trusted module is the same
  absolute path on two compiles, with fingerprinted module ids; the
  workflow generator's Agency source is deterministic already.
- BMO, outside this repo: `agency workflow tools ./src/agent/lists.agency`
  lists the tools, and `runMealPlan` runs against the real `dist/agent`.

## Left to the builder

- The config key names (`sandbox.trustedModules`, `source`, `compiled`).
- An entry's `static` initialiser cannot read a trusted module's global:
  the trusted module's init is registered under the host's path, not the
  mirror's, so the entry's `awaitModules` leaves it out on purpose. The
  closure-wide bootstrap still runs it before `main`.
- The `agency workflow` driver imports a tool module under a trusted
  `source` directory from its compiled file (ADI-287, built in the same
  pull request). Every command runs the driver, so none of them worked
  from source for a host like BMO.
- The emitted import is a `file:` URL of the compiled path. A raw path
  with a `#` in it, or a Windows drive path, is not a valid ESM specifier.
- The exact message for a missing compiled file.
- Confirming that a trusted module's `agency-lang/runtime` import and the
  child's resolve to one package instance. The temp directory sits under
  the agency package root for this reason, and BMO's `dist/agent` resolves
  the same package from `node_modules`; a module registered twice would
  show up as a tool the generated program cannot find.
