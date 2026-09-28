# Review 2: Template body name checking — implementation plan

Reviewing the revised `2026-08-01-template-body-name-checking.md` after the
flat-scope finding in the first review was addressed.

## Verdict: change requested

The per-definition scope model is now right, and the new parameter/local/loop
tests protect the earlier failure mode. The plan still has three blocking
contract gaps: it checks variable references but not direct calls, it only
hands one of the two ordinary undefined-name diagnostics over to the template
pass, and its derived type-checker context is not isolated enough. The import
test and replacement execution fixture also need tightening before
implementation.

## Blocking: direct calls are names too, but the proposed pass never checks them

`FunctionCall.functionName` is a string, not a `variableName` node.
`walkNodes` yields the `functionCall` and walks its arguments, but it does not
turn the callee into a `variableName`. This is why the existing checker has two
separate passes:

- `undefinedVariableDiagnostic.ts` uses `resolveVariable` for
  `variableName` nodes.
- `undefinedFunctionDiagnostic.ts` uses `resolveCall` for `functionCall`
  nodes.

The proposed `checkBody` discards every node except `variableName`, so it misses
all bare calls. In particular, two of the plan's own red tests cannot pass:

- `guarded()` supplied by a declaration hole
- `helper()` declared only in the host file

It would also miss an ordinary misspelled call in a template. The normal
undefined-function pass cannot rescue code literals because their bodies are
opaque to the outer AST walk.

**Required plan change:** make the template pass handle both `variableName`
and bare `functionCall` nodes. Resolve calls with `resolveCall` using the same
template-local registries and per-body `scopeHas` used for variables. Mirror
the existing call guards:

- skip synthetic calls;
- skip a `functionCall` whose immediate parent is a `valueAccess`, because
  `obj.method()` does not make `method` a lexical name;
- check the base and arguments through the normal variable walk;
- emit `AG8015` at the call location when the bare callee is unresolved.

Keep the existing `guarded()` and host-`helper()` red tests, but assert that
the `AG8015` message names the callee. Add green direct-call cases for a def
declared in the literal, an imported function, a prelude function (`print`),
and a builtin (`llm`). The current prelude/builtin test only proves that the
argument `res` resolves; it does not inspect either call name.

## Blocking: a holey file would still double-report undefined calls

Task 3 makes `checkUndefinedVariables` stand down for a file with holes, which
prevents `AG4007` plus `AG8015` for a variable. It leaves
`checkUndefinedFunctions` unchanged. That pass defaults to `warn`, so after
the call fix above a holey file containing `guarded()` emits both:

- `AG8015` from the always-on template pass;
- `AG4004` from the ordinary undefined-function pass.

These have different codes and messages, so final diagnostic deduplication
will not remove either one.

**Required plan change:** Task 3 must hand both ordinary name checks over to
the template pass. Add the same whole-file `holeNames(...)` early return to
`checkUndefinedFunctions`, and add `undefinedFunctionDiagnostic.ts` to the
task's file list. Test all four ownership boundaries:

- holey file, missing variable: `AG8015`, not `AG4007`;
- holey file, missing call: `AG8015`, not `AG4004`;
- hole-free file, missing variable: ordinary configuration still governs
  `AG4007`, and no `AG8015`;
- hole-free file, missing call: `AG4004`, and no `AG8015`.

The commit and PR description should say that, for a file with holes, the
always-on template pass owns both variable and direct-call name diagnostics.

## Blocking: `derivedContext` must not retain host checker closures or errors

`buildScopes` is not a pure scope collector. It calls `ctx.withScope`,
synthesizes expression types, checks assignments and const mutations, validates
types, and can append diagnostics. The real context's `getTypeAliases`,
`withScope`, and `inferReturnTypeFor` functions close over the host
`TypeChecker` instance and host context.

The plan currently says to copy the real context construction while
overriding a few fields. A spread such as `{ ...ctx, programNodes, ... }` is
unsafe: it can retain host aliases, host scope state, inference/flow state,
and the host `errors` array. That both violates the isolated-file model and can
leak incidental diagnostics produced while constructing synthetic scopes into
the enclosing file's report.

**Required plan change:** specify an explicit isolated context contract for
scope construction rather than leaving `derivedContext` open-ended. It should
use:

- synthetic `programNodes`, `functionDefs`, `nodeDefs`, type aliases, imports,
  and JS imports;
- fresh `errors`, return-inference, match-expression, and scope-key state;
- local `withScope`, `getTypeAliases`, and `inferReturnTypeFor` closures over
  the derived context;
- no host `flowEnv`, declaration registries, or imported-function registries;
- only configuration copied from the outer context.

Build graph-node keys with `declaredName(node.nodeName)`, matching the real
`TypeChecker` construction. Add a regression test that scope construction
does not append incidental diagnostics to the outer context's `errors` array.

If building full isolated contexts solely to call `buildScopes` remains
awkward, that is a signal to extract a smaller scope-building input rather
than preserve host-bound callbacks accidentally.

## High: the Agency-import test passes even if import handling is broken

The plan says `buildCompilationUnit(program)` collects imported functions.
That is only true for JS imports. Agency imports populate
`unit.importedFunctions` only when both a `SymbolTable` and `fromFile` are
provided. The proposed synthetic call provides neither.

For this name-existence pass, that need not be fatal: `walkScopeBody` declares
the local names from syntactic imports in the lexical scope and gives them an
`any` type when no signature is available. Both `resolveVariable` and
`resolveCall` can therefore recognize the imported local through `scopeHas`.
The plan should describe that actual mechanism instead of promising populated
`importedFunctions`.

The proposed test does not verify it. It imports `read` from `std::fs`, but
`read` is already in `PRELUDE_NAMES`, so the test stays green even if the
literal import is ignored completely.

**Required plan change:** use a real non-prelude export, such as `emit` from
`std::statelog`, and use it both as a direct call and as a first-class value.
Do not copy host `importedFunctions` into the derived context; that would
reintroduce the host-import leakage this feature is meant to reject. Supplying
a symbol table is unnecessary unless this pass is also meant to validate the
imported signature/export, which is outside the stated name-existence rule.

## High: the replacement fixture shown in Task 4 does not preserve run coverage

The prose says the replacement must still run the finished program, but the
sample generates only `def guarded`, never generates an exported `main`, and
returns `"ok"` from the host. "Add `runCode` if the original did" leaves the
load-bearing part optional even though the original definitely does it and its
test expects `"lit-ok"`.

**Required plan change:** make the replacement sample itself executable and
make `runCode(toSource(done.value))` mandatory. A self-contained shape that
preserves the old mechanics is:

1. One program literal declares both `guarded` and exported `main`, so
   `main`'s call to `guarded()` resolves within that literal.
2. That literal contains `#body` and `#minutes`.
3. Fill `#body` first, leaving `#minutes` open.
4. Graft the partial program into a wrapper literal containing only
   `#helpers`.
5. Assert the remaining hole has origin `helpers`.
6. Fill `minutes`, run the generated program, and retain the `"lit-ok"`
   expectation.

That keeps expression-literal filling, partial fill, grafting, origin
propagation, second fill, printing, compiling, and execution without allowing
code outside `#helpers` to depend on a declaration supplied through the hole.

## What is now sound

- Mirroring `buildScopes` fixes the earlier flat-scope false positives and
  sibling-local leakage.
- The new parameter, nested-local, loop-binder, and block-parameter tests are
  the right guards.
- Keeping the prelude while dropping host declarations/imports is the right
  resolution boundary.
- Always-on `AG8015` is justified and the diagnostic/explanation wiring is
  accounted for.
- The branch, focused-test, saved-output, `make`, and final sweep discipline is
  appropriate.

Revise Tasks 1–3 for dual variable/call resolution and an isolated derived
context, then make the import and execution tests non-vacuous. After those
changes, the plan is safe to implement.
