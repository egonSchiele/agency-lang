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
  the parent adopts it on receipt (`adoptAlwaysScope`). The child is
  untrusted, so adoption fills a gap only: a scope the parent already holds
  wins, a malformed value is ignored, and nothing throws.
- A scope can only ever narrow a rule. `buildScopedMatch` returns `{}` when
  any scoped field is missing from the interrupt data, the prompt offers
  "approve always here" only when that match is non-empty, and
  `recordScopedRule` writes nothing for an empty match. Without those
  three, a scope naming a field the payload lacks would save a rule with
  an empty match, which `matchesRule` treats as a catch-all approve.
- Registering an empty scope is a no-op. Registering a different non-empty
  scope for an effect that already has one throws: the typechecker forbids
  the only way to reach that state within one program.
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
  a row is added.
