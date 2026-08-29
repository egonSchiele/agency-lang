# `@always` and `@alwaysUnder` on effect declarations

An effect declaration can say which of its payload fields an "approve
always here" policy rule pins:

    @always(name)
    effect std::env { name: string }

    @alwaysUnder(dir)
    effect std::read { dir: string, filename: string, offset: number, limit: number }

`@always` pins the exact value. `@alwaysUnder` pins the value and every
subpath under it (`{value,value/**}`). A declaration may carry both.
Arguments are bare field names. The tag parser rejects function calls,
which is why there is no `subpaths(dir)` form.

Before this, the agency agent kept its own table (`ALWAYS_FIELDS`) of
which fields to pin, and any effect missing from it silently offered no
"approve always here". Now the effect's own declaration is the one place
that decides, and every stdlib effect has decided (see the coverage test
below).

## Pipeline

1. The parser leaves tags as standalone nodes above the declaration.
   `lib/utils/tagsAbove.ts` pairs them with the node that follows, without
   mutating anything. The symbol table and the typechecker run before the
   preprocessor attaches tags, so they read them through this helper.
2. `lib/utils/alwaysTag.ts` reads the two tags into `ScopedField[]`, plus a
   list of problems (non-identifier argument, repeated tag, field named
   twice).
3. The typechecker (`lib/typeChecker/effectPayloadCheck.ts`) checks every
   field exists in the payload, each tag appears once, arguments are
   identifiers, tagged declarations of one effect agree, and the tag sits
   on an effect declaration. Diagnostics: `alwaysUnknownField`,
   `alwaysBadArgument`, `alwaysRepeatedTag`, `alwaysScopeConflict`,
   `alwaysStrayTag`.
4. Codegen (`lib/backends/typescriptBuilder.ts`) emits
   `__registerAlwaysScope("std::env", [{"field":"name","matchSubpaths":false}]);`
   at module JS-load, next to `__registerStaticInit`. An untagged
   declaration still erases to nothing.
5. The runtime registry (`lib/runtime/alwaysScope.ts`) holds the result.
   It is process-wide, derived from code, and never checkpointed.
6. `std::policy` reads it: `alwaysScopeFor(effect)`,
   `defaultScopedFields()`, and inside `buildScopedMatch`,
   `recordScopedRule`, and the approval prompt. A caller's `fields:`
   argument overrides the registry per effect. An empty list turns the
   option off for that effect.

## Subtleties

- The registry fills when a module is imported. An effect raised from
  TypeScript (`mcp::call`) is covered because `stdlib/mcp.agency` declares
  it and every MCP user imports that module.
- The registry is per process. Code run through `std::agency` `run`,
  `runFile`, or `testFile` raises interrupts in a child that forwards them
  to the parent's handlers, and the parent may never have imported the
  declaring module. So each forwarded interrupt carries its scope
  (`IpcInterruptMessage.interrupt.alwaysScope`, `lib/runtime/ipc.ts`) and
  the parent registers it on receipt. `std::toolbox` depends on this;
  `tests/agency/always-scope-over-ipc` is the test that fails without it.
- Registering an empty scope is a no-op, so codegen, the IPC receiver, and
  tests never need an "only if non-empty" guard. Registering a different
  non-empty scope for an effect that already has one throws: the
  typechecker forbids the only way to reach that state within one program.
- An untagged redeclaration of a tagged effect (the guide shows users
  writing `effect std::read { ... }` with no tag) inherits the tagged
  scope. Only tagged declarations take part in the conflict check.
- Values in a generated rule are escaped (`escapeGlob` in
  `lib/runtime/policy.ts`), so approving `ls *.md` saves a rule for that
  exact command. Hand-written rules stay patterns.
- `agency doc` prints the tag line above each effect declaration, so the
  generated stdlib reference shows what "approve always here" pins.
- The stdlib coverage test `lib/utils/alwaysTag.stdlib.test.ts` holds the
  decision table, one row per effect. A new stdlib effect fails it until
  a row is added. A tag missing from one of two copies of a declaration
  (`std::read` lives in both `index.agency` and `agency.agency`) fails
  it too.
- Resume: a resumed program re-imports its modules, so the registry is
  rebuilt from code and is never part of a checkpoint. No test covers
  this, because the Agency test runner has no resume step.
