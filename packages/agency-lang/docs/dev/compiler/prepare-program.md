# prepareProgram: one pipeline from source to CompilationUnit

`prepareProgram` in `lib/compiler/prepareProgram.ts` turns Agency source text into a `CompilationUnit`. Every path that looks names up in a program goes through it.

Add a new step there, once. Before this function existed the sequence was written out by hand in six places, and a step added to four of them left `agency tc` reporting a splice-generated function as undefined (#692).

## The steps

In order:

1. **Parse** the text.
2. **Vet** the program as written, if the caller passed a `vet` function.
3. **Build the symbol table**, unless the caller passed one.
4. **Expand splices.** A generator returns declarations, and they have to be in the program before anything looks names up in it.
5. **Vet again.** A generator can emit import lines of its own, and those never went through step 2.
6. **Add the prelude import**, only when the text was parsed without the template (see `applyTemplate` below).
7. **Prune shadowed prelude names.** A file may declare its own `map`. The build drops `map` from the prelude import, so the checker must do the same or it reports a clash the build has already settled.
8. **Resolve re-exports.**
9. **Resolve imports.**
10. **Lift callback blocks**, so each `callback("onX") { ... }` body becomes a top-level function.
11. **Build the compilation unit.**

## The options

Each option is a difference between callers that someone chose. If a caller needs to leave a step out, add an option with a reason. Do not write the sequence out again.

| Option | Who sets it | Why |
| --- | --- | --- |
| `applyTemplate: false` | the editor | Positions must match the buffer, so the prelude import cannot be prepended to the text. Step 6 adds it to the parsed program instead. |
| `applyTemplate: !isNonTemplatedStdlib(path)` | `agency interrupts` | It checks every file in the closure, including the stdlib files that are parsed without the template. |
| `allowTestImports: true` | the editor, `agency tc`, `agency interrupts` | They never run the program, so honoring `import test` is safe and keeps test files checkable. Anything that compiles code to run it leaves this false. |
| `keepGoing: true` | the editor, `agency tc`, `agency interrupts`, `typeCheckSource` | Report a broken splice or import and check the rest of the file. A build stops at the first one. |
| `spliceWallClockMs` | the editor | A runaway generator must not freeze a single-threaded language server. |
| `symbolTable` | anyone who already has one | `agency tc` shares one table across every input file. |
| `vet` | `compileSource` | The import policy. It refuses disallowed source before any generator runs. |

## Failures are returned

`prepareProgram` does not throw for a parse failure, a refused program, a splice failure, or a bad import. It returns them in `diagnostics`, each tagged with its `stage`. What to do with a failure is the part that differs between callers:

- `compileSource` returns them as `errors` strings, and rethrows a bad import the way it always did.
- `typeCheckSource` throws for a parse failure, a bad import, and a refused splice. A throw from it means "could not check this".
- The editor turns each one into an editor diagnostic at its position.
- `agency tc` prints each one and carries on to the next file.
- `agency interrupts` analyzes what is there and returns the failures as `warnings`, which the command prints to stderr. A dropped import takes its call edges with it, so the list of sites is incomplete when there are warnings.

`throwImportFailures` rethrows the original error for callers whose contract is that a bad import throws. `describeDiagnostic` renders any failure as one line that names its file.

An `imports` failure holds whatever was thrown. It is usually an `ImportResolutionError`, but `SymbolTable.build` and `resolveReExports` also throw plain `Error`s, so do not assume the class.

Under `keepGoing`, the result can be `ok: true` and still carry diagnostics. Two failures stop the pipeline even then: a parse failure, and a bad re-export, which leaves no usable module graph.

## Bad imports and AG codes

The type checker has its own diagnostics for a bad import: AG4008 (name not found), AG4009 (module not found), and AG4010 (name not exported). Under `keepGoing` the resolver drops a bad name before the checker sees it, so the checker never reports them on this pipeline.

To keep the codes in the output, the resolver's matching errors carry the checker's code in `ImportResolutionError.code`, and `formatImportResolutionError` prints it. `tests/integration/cli-main` pins `AG4008` in the output of `agency tc`.

## Who is not on it

- `lib/compiler/buildSession.ts` has its own copy of the sequence. It also carries the incremental-build manifest and reads through the parse cache, and it has not been moved yet.
- `lib/cli/doc.ts`, `lib/cli/policy.ts`, `lib/serve/metadata.ts`, and `lib/optimize/targets.ts` call `buildCompilationUnit` to read metadata. They deliberately do not expand splices, because expanding means running generator code. Keep them off this pipeline.
