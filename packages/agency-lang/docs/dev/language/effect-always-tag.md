# `@always`, `@alwaysUnder`, and `@alwaysPrefix` on effect declarations

An effect declaration can say which of its payload fields an "always
approve when" policy rule pins:

    @always(name)
    effect std::env { name: string }

    @alwaysUnder(dir)
    effect std::read { dir: string, filename: string, offset: number, limit: number }

    @always(command)
    @alwaysPrefix(args)
    @alwaysUnder(cwd)
    effect std::exec { command: string, args: string[], cwd: string, timeout: number, stdin: string }

`@always` pins the exact value; on a list field that is the whole list.
`@alwaysUnder` pins the value and every subpath under it
(`{value,value/**}`). `@alwaysPrefix` pins the leading items of a list,
and the approval prompt asks how many: for `pnpm run build`, the choices
run from the whole command down to `pnpm run …`. A declaration may carry
all three, with each field named by one tag. Arguments are bare field
names. The tag parser rejects function calls, which is why there is no
`subpaths(dir)` form.

## Pipeline

1. The parser leaves tags as standalone nodes above the declaration.
   `lib/utils/tagsAbove.ts` pairs them with the node that follows, without
   mutating anything. The symbol table and the typechecker run before the
   preprocessor attaches tags, so they read them through this helper.
2. `lib/typeChecker/alwaysTag.ts` reads the three tags into `ScopedField[]`, plus a
   list of problems (non-identifier argument, repeated tag, field named
   twice). A field from `@alwaysUnder` has `matchSubpaths: true`, and one
   from `@alwaysPrefix` has `matchPrefix: true`. At most one of the two is
   true.
3. The typechecker (`lib/typeChecker/effectPayloadCheck.ts`) checks every
   field exists in the payload, each tag appears once, arguments are
   identifiers, tagged declarations of one effect agree, the tag sits on
   an effect declaration, and a `@alwaysPrefix` field is a list that is
   always there (`string[]`, through any alias, and not `string[] | null`).
   Diagnostics: `alwaysUnknownField`, `alwaysBadArgument`,
   `alwaysRepeatedTag`, `alwaysScopeConflict`, `alwaysStrayTag`,
   `alwaysPrefixNotList`. `alwaysPrefix` is a reserved tag name
   (`lib/types/tag.ts`), so above a def it is a stray tag and not a
   decorator.
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
   option off for that effect. The prompt also reads the scope to write
   the dim detail beside each scoped answer (`describeScope` in
   `lib/runtime/alwaysChoices.ts`), to decide whether the set-wide `as`
   answer is offered, to find the one `@alwaysUnder` field its folder step
   asks about, and to find the `@alwaysPrefix` field its command step asks
   about. See "What always approve when pins" in
   `docs/dev/agents/approval-policies.md`.

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
  wins, a malformed value is ignored, and nothing throws. A field with both
  `matchSubpaths` and `matchPrefix` set counts as malformed.
- A scope can only ever narrow a rule. `buildScopedMatch` returns `{}` when
  any scoped field is missing from the interrupt data, when a prefix field
  is not a list of strings or the choice picked is not one of its choices,
  and when a pattern would be longer than a rule may hold. The prompt offers
  "always approve when" only when that match is non-empty, and
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
  exact command. A prefix rule ends in `**`, the matcher's "any items after
  this"; an argument that is itself `**` is escaped, so it cannot be read
  as that. Hand-written rules stay patterns.
- `agency doc` prints the tag line above each effect declaration, so the
  generated stdlib reference shows what "always approve when" pins.
- The stdlib coverage test `lib/typeChecker/alwaysTag.stdlib.test.ts` holds the
  decision table, one row per effect. A new stdlib effect fails it until
  a row is added.
