# Trusted modules

A trusted module is a `.agency` module the host vouches for. The host names
the directory its sources are in and the directory its compiled JavaScript
is in. A workflow may then call tools from that module even when the module
imports TypeScript, and the workflow's subprocess loads the host's compiled
file instead of compiling the source in the sandbox.

The design, and the options set aside, are in
`docs/superpowers/specs/2026-11-02-trusted-modules-design.md`. The security
reasoning is in `docs/dev/security/trusted-modules.md`.

## The config

```json
{
  "sandbox": {
    "trustedModules": [{ "source": "src/agent", "compiled": "dist/agent" }]
  }
}
```

Both paths are relative to the working directory, as `client.providerModules`
are, so a host starts from its project directory; issue #1367 is about
baking them against the config file's directory instead. A project whose
compiled files sit beside the sources names the same directory twice.
`resolveTrustedModules` (`lib/compiler/trustedModules.ts`) turns each entry
into real paths when the list is used. A `source` directory that does not
exist, or either directory reached through a symlink, is an error that names
the entry and the path. A `compiled` directory that does not exist is a
project not built yet: the list still resolves, and a tool under that entry
fails at the validator with the compiled file it looked for, so a workflow
over other tools keeps working.

## Who compiles against the list

Only `std::workflow` does. Three TypeScript helpers in
`lib/stdlib/workflow/trusted.ts` read the list and call the compiler:

- `_compileTrusted` for the strict compile in `_checked`
- `_typecheckTrusted` for the strict typecheck in `_checked`
- `_describeTrusted` for `describeGroup`, which `catalog` and `_signatures` use

The public `compile`, `typecheck`, `describe`, `run`, `runFile`, and `runCode`
in `std::agency` pass an empty list, so they refuse a trusted module as they
did before. Sandboxed code cannot import the three helpers, because they are
TypeScript. It also cannot build a workflow over a trusted tool, because it
cannot import the tool's module to get the function value. So a trusted module
is reachable only through a tool list the host passed to `std::workflow`.

The `agency workflow` commands call describe from TypeScript with no run. They
resolve `io.config.sandbox.trustedModules` themselves (`lib/cli/workflow/commands.ts`)
and pass the list to `describeModule`. Their driver (`lib/cli/workflow/driver.ts`)
imports a tool module under a trusted `source` directory from its compiled
file, as the sandbox does. Compiled from source, the module's TypeScript
imports would point into the source tree, where nothing is built.

Nothing takes a list as an argument from Agency code. `effectiveTrustedModules`
is the one function that says which list a process may use:

- at the root, the context's config list, resolved against the working directory
- in a subprocess, the list the bootstrap seeded from the parent

## What the validator does at a trusted module

`validateClosure` (`lib/compiler/closureValidator.ts`) takes the resolved list.
When an import resolves, by real path, to a file under a trusted `source`
directory, the validator runs the trust branch:

1. The import must still end in `.agency`, be relative, sit inside `dir`, and
   not pass through a symlink.
2. The compiled file must exist. Otherwise the import is refused with a
   message naming the module and the compiled path. This fails `checkWorkflow`
   and `runWorkflow` before `std::workflow::run` is raised.
3. The validator records the specifier and the compiled path in the importing
   module's `trustedImports`.
4. The trusted module, and every `.agency` file reachable from it, is read and
   recorded with `trusted: true`. No rule applies to these files. Their `.js`
   imports are not read.

A file entry gets the same branch, so `describe` of a trusted module works.

Two rules keep this from letting validated code through:

- A `.js` or `.ts` import from a validated file is still refused, even when the
  file sits in a trusted directory. Trust attaches to `.agency` modules.
- A file that a trusted module imports, and that validated code also imports
  directly, is validated. The walker records which files it walked with the
  rules (`validated`) and which as mirror-only (`mirrored`). A validated walk
  of a mirrored file walks it again with the rules, and the file is then
  compiled like any other.

## What the compiler emits

`compileValidatedClosure` writes every module into the private mirror,
trusted or not. The typechecker and `buildCompiledClosure` both read imports
from disk, so they need the whole tree. Only the modules with `trusted: false`
are compiled.

Step 6 of `compileSource` rewrites each specifier in `trustedImports` to a
`file:` URL of the absolute compiled path, which Node imports whatever
characters the path holds. For example, `import { shoutViaJs } from "./tools/tools.agency"`
becomes an import of `file:///home/me/project/dist/tools/tools.js`. An
`import node { ... } from` statement whose file is trusted is rewritten the
same way. The program's `trustedModules` mark keeps the filesystem paths.

`buildCompiledClosure` keys a trusted module by its mirror path. The host's
compiled file registers its init under the host's own source path, so the
entry's await on the mirror path finds nothing and returns at once. The
closure-wide bootstrap in `runNode` still runs every registered init. The
cost is that an entry's `static` initialiser may not read a trusted module's
global; pointing the await at the host's source path, which the validator
knows, would lift that.

## The mark on a compiled program

A compiled program carries `trustedModules`, the sorted list of absolute
compiled paths it loads. It is empty for a program that loads none. It travels
in checkpoints like the rest of the value.

- The `std::run` interrupt shows it in its data, so a policy can refuse a
  program that loads host code, and a person can see the paths before
  approving.
- `materializeCompiledScript` checks each path is a regular file before it
  writes anything. A checkpoint resumed on a machine without the build fails
  with the path named.

## What makes a tool value trustworthy

`toolRefs` writes a workflow's imports from each tool's label: its `name`,
`module`, `registeredName`, and `sourceFile`. So the label must come from
the runtime, never from Agency code. `toolRefs` accepts a tool only when
`AgencyFunction.isBranded` says so, a private-field check that no object
literal, `any` cast, JSON value, or property copy satisfies. The label is
own non-writable, non-configurable properties, so an assignment throws and
`Object.defineProperty` cannot redefine it, and `derive` is a private method
(`lib/runtime/agencyFunction.ts`). The runtime's own `isAgencyFunction`
keeps reading the `__agencyFunction` marker, because a raw JSON copy of a
function must still read as one for the registry to rebuild it. The
reasoning, and the limit set by issue #974, is decision 4 in
`docs/dev/security/trusted-modules.md`.

## How the list reaches a child

`SubprocessIdentity` carries `trustedModules` on both the `run` and `resume`
instructions. `_runFor` puts `trustedModulesForChild(ctx, compiled)` on it,
and the bootstrap seeds it into `SubprocessRunInfo` before it imports the
child's script. The identity is rebuilt on every segment, so a root
restarted with a changed config resumes its children with the new list.

A child gets its parent's whole list when every file its program is marked
as loading sits under a trusted compiled directory, so a trusted tool inside
a workflow can run a nested workflow over tools from any entry; otherwise it
gets an empty list. A program compiled without the list, as the public
`compile` and `runCode` compile, has an empty mark, so a model-written
program and everything it runs compile with no list. The mark is a field on
a record the program holds (issue #1366), which is why a mark naming a file
outside every entry passes down nothing. A child never widens the list. `configOverrides` does not carry it:
`parentConfigOverrides` copies an allow-list of fields, and `sandbox` is not
one of them.

## Tools loaded from a compiled directory

A compiled module records its source as a path relative to the compiled file
(`docs/dev/language/agency-function.md`). A build that copies its output, as
`tsc` does into `dist/`, leaves `dist/agent/lists.js` recording
`dist/agent/lists.agency`, which does not exist. `toolRefs`
(`lib/stdlib/workflow/tools.ts`) maps a source file under a trusted `compiled`
directory back to the `source` directory with `sourcePathFor`, so a workflow
over a tool loaded from `dist/` names `src/agent/lists.agency`.

## What it does not cover

- `agency run --agency-only` passes no list and refuses a trusted module.
- A stale build is the host's problem. The typecheck reads the source and the
  child runs the compiled file. The `agency workflow` commands load the
  compiled file too, so build before you run them.

## Files

- `lib/compiler/trustedModules.ts`: the type, resolution, the path mappings,
  and `effectiveTrustedModules`
- `lib/runtime/agencyFunction.ts`: the brand and the private label
- `lib/compiler/closureValidator.ts`: the trust branch and the mirror walk
- `lib/compiler/compileValidatedClosure.ts`, `lib/compiler/compile.ts`: the
  mirror, the rewrite, the init awaits, and the mark
- `lib/stdlib/agency.ts`: the `...WithTrustedModules` helpers the public
  functions call with `[]`
- `lib/stdlib/workflow/trusted.ts`: the three helpers `std::workflow` uses
- `lib/cli/workflow/driver.ts`: the driver's import of a trusted module's
  compiled file
- `lib/runtime/ipc.ts`, `lib/runtime/subprocess-bootstrap.ts`,
  `lib/runtime/subprocessRunInfo.ts`: the list on the instructions
- `tests/agency-js/trusted-modules/`: the end-to-end test, with separate
  source and compiled directories, a grandchild, and a model-written program
  whose fake tool is refused
- `lib/cli/workflow/workflow.spawn.test.ts`: the `agency workflow` commands
  on a project whose tools are built apart from their sources
