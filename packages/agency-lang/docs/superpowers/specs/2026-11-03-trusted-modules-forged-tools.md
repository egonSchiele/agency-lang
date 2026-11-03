# Trusted modules: fake tools reach host code

Copilot raised this on PR #1363. This doc explains the problem with an
example and proposes two fixes.

## Decision

Both fixes went into PR #1363, in a different form from the proposals below.
The reasoning is decisions 4 and 5 of `docs/dev/security/trusted-modules.md`.

- Fix 2 became a brand on the function itself, not a registry lookup.
  `toolRefs` accepts a tool only when `AgencyFunction.isBranded` finds the
  private field `#brand`, which nothing made from data carries. The label
  fields are own non-writable, non-configurable properties, so an assignment
  or `Object.defineProperty` throws, and `derive` is a private method. The
  runtime's own `isAgencyFunction` keeps reading the `__agencyFunction`
  marker, because the runtime relies on raw JSON copies of a function still
  reading as one (making the label private broke five tests in CI). The
  multi-copy concern about `instanceof` is the existing assumption that a
  trusted module and its child load one runtime.
- A sandboxed program can reach `process`, `globalThis`, and `Function`, so
  the rule holds against data, not against code that calls
  `Object.defineProperty` on a real instance. That is a sandbox hole, filed
  as issue #1364, and out of scope here.
- Fix 1 is as proposed: `trustedModulesForChild` in `lib/runtime/ipc.ts`
  hands the list down only to a program marked as loading a trusted module.
- Tool calls as effects, which would keep the child from loading host code
  at all, was considered and set aside as a redesign out of proportion to
  the hole. It remains the long-term shape of brokering.

## The short version

A workflow decides which file to load a tool from by reading a label on the
function it is handed. Code the agent wrote can make that label itself. In a
project with trusted folders, that lets agent code call a host function the
host never offered.

## The example

BMO trusts the folder `src/agent/`. In it, `lists.agency` has two functions:

```
export def safeDeleteList(listId: string) { ... }   // checks first, then deletes
export def deleteListNow(listId: string) { ... }    // deletes, no check
```

BMO gives workflows only `safeDeleteList`. The unchecked one should never be
callable from a workflow.

### How a workflow finds a tool

BMO calls `runWorkflow(steps, inputs, [safeDeleteList])`, passing the
function itself. Every Agency function carries a label, roughly:

```
{ name: "safeDeleteList", sourceFile: "/home/bmo/src/agent/lists.agency" }
```

`runWorkflow` reads the label (`toolRefs` in `lib/stdlib/workflow/tools.ts`)
and writes an import line into the program it builds:

```
import { safeDeleteList } from "./src/agent/lists.agency"
```

### The problem

The check that tells a real function from a fake one only looks for one key,
`__agencyFunction: true` (`AgencyFunction.isAgencyFunction` in
`lib/runtime/agencyFunction.ts`). Agency lets an object literal use that key,
so agent code can write a fake:

```
const fake = { __agencyFunction: true, name: "deleteListNow", registeredName: "deleteListNow",
               boundArgs: null, params: [], paramSchemas: {},
               module: "src/agent/lists.agency",
               sourceFile: "/home/bmo/src/agent/lists.agency" }
runWorkflow(steps, inputs, [fake])
```

`runWorkflow` cannot tell the difference. It writes
`import { deleteListNow } from "./src/agent/lists.agency"`. The file is
trusted, so the workflow loads BMO's compiled `dist/agent/lists.js`, and the
unchecked delete runs.

### Who can do this

The program the agent writes and runs with `runCode` gets the same list of
trusted folders as BMO itself (`_runFor` in `lib/runtime/ipc.ts` passes it to
every child). So the agent's own program can build the fake and call
`runWorkflow`.

### What I tested

Two small Agency programs, run in the worktree:

1. A fake object like the one above, passed to `catalog`. It was accepted,
   and `catalog` described `deleteAll(): string` from a file the program
   never imported.
2. A real function's label rewritten through an `any` alias:

   ```
   const alias: any = mine
   alias.sourceFile = "/elsewhere/backend.agency"
   ```

   Reading `mine.sourceFile` afterwards printed the new path. So checking
   "is this a real function?" is not enough on its own. Agent code can take
   one of its own real functions and point its label at a trusted file.

### How bad it is

- **Projects affected:** only those that list trusted folders.
- **Approval prompts:** they still appear. The person sees "run a workflow"
  and "run a program", and the second one shows the trusted file's path.
  Someone reading closely could catch it. A rule that approves those prompts
  automatically would let it through.
- **A misleading prompt:** when the agent's own program starts, its approval
  prompt says it loads no trusted files. That is true of the program itself,
  but the program can still reach them through a fake label.
- **New with this PR.** Before it, a fake label could only point at an
  ordinary file inside the folder, which the safety check then inspects. A
  fake gained nothing over writing the import directly.

It breaks a promise the PR makes. `docs/dev/runtime/trusted-modules.md` says
a trusted module "is reachable only through a tool list the host passed to
`std::workflow`". The fake skips the host's list.

## Fix 1: don't give the trusted list to programs that don't need it

Today every child gets its parent's trusted list. Instead, a child gets the
list only when its own program already loads a trusted file. Every compiled
program carries that fact: `trustedModules`, the host files it loads (the
"mark").

- The agent's program loads no trusted file, so its child gets an empty
  list. A fake label then points at a file the safety check treats like any
  other import. BMO's `lists.agency` imports TypeScript, so it is refused. A
  file with no TypeScript would be compiled in the sandbox, which agent code
  could already do before this PR by writing the import itself.
- A workflow program loads the host's compiled tools, so its child still
  gets the list. A trusted tool can still run a workflow from there (the
  nested case in `tests/agency-js/trusted-modules/`).
- The approval prompt becomes true. A program whose prompt shows no trusted
  files cannot reach host code, however deep its children go.

The change is in `_runFor` in `lib/runtime/ipc.ts`:

```ts
const loadsHostCode = (compiled.trustedModules ?? []).length > 0;
trustedModules = loadsHostCode ? effectiveTrustedModules(ctx) : [];
```

`_runFor`'s `compiled` parameter type gains `trustedModules?: string[]`.
The value already carries it, since `materializeCompiledScript` reads it.
A resume rebuilds the instruction from the same compiled program in the
checkpoint, so the same rule applies there.

Docs that say "a child gets its parent's list unchanged" change to say a
child gets the list only when its program loads a trusted module:
`docs/dev/runtime/trusted-modules.md`, `docs/dev/security/trusted-modules.md`
(decision 1 and a new section for this problem), and
`docs/dev/runtime/subprocess-ipc.md`.

**Test:** a node in the agency-js test runs a program with `runCode` that
builds a fake pointing at a trusted tool and calls `runWorkflow`. It
expects the refusal, not the tool's output.

## Fix 2: keep the real labels out of reach

Fix 1 covers agent-written programs. It does not cover code that already has
the list and passes along values it did not make. For example, a host that
gives a model `runWorkflow` as a tool: the model's arguments arrive as JSON,
and a JSON object can carry `__agencyFunction: true`.

So `toolRefs` should take a tool's file from the runtime, not from the
label:

- When `AgencyFunction.create` first creates a function, it already stores
  the function in the runtime's registry under `module:name`. It also
  records the function's source file there, in a record Agency code cannot
  name (`__` names belong to the compiler, so Agency code cannot write
  `__toolRegistry`).
- `toolRefs` accepts a tool only if the registry entry for its `module:name`
  is the same object. A fake object literal fails this, because the registry
  holds a different object.
- `toolRefs` reads the source file from that record, never from
  `tool.sourceFile`. A real function whose label was rewritten passes the
  identity check, but the rewritten label is ignored.

Apply this only to tools whose file falls in a trusted folder. A fake
pointing anywhere else gains nothing, because the safety check inspects
that file. Keeping the check narrow also avoids one risk: I believe the
`__agencyFunction` key check exists because tests can load more than one
copy of the runtime, each with its own registry, though I have not
confirmed that. If so, a function made by one copy would not be found in
another copy's registry.

Two alternatives were set aside:

- **Freezing every function value** stops the label from being rewritten,
  but it changes behaviour for every function in every program, not just
  tools.
- **Swapping the key check for `instanceof AgencyFunction`** would refuse
  real functions from a second runtime copy, if that is why the key check
  exists.

**Tests:** unit tests on `toolRefs`. A fake object pointing into a trusted
folder is refused. A real function whose `sourceFile` was changed is
imported from its real file. A real trusted tool is still accepted.

## Order

Fix 1 is small and closes the case in the example. Fix 2 is more work and
closes the remaining cases. Both belong on PR #1363, since the hole is new
with it.
