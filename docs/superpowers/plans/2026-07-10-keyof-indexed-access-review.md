# Review: keyof + indexed access implementation plan

**Date:** 2026-07-10
**Plan:** `docs/superpowers/plans/2026-07-10-keyof-indexed-access.md`
**Verdict:** Strong plan. It absorbed the spec review's parser findings (unionItemParser integration, full-type-expression brackets, ordering, the reserved-name set) and its verified-facts section is almost entirely accurate — I re-checked the helper names, AST shapes, Agency test syntax, and zod emission format against the code, and they all hold. Two problems block execution as written: Task 1 Step 4's parser design is internally contradictory (finding 1), and Task 2 still re-implements helpers that `builtinGenerics.ts` owns, which the spec review already flagged (finding 2). Both have small fixes.

## Blocking findings

### 1. Task 1 Step 4 cannot work as written: the suffix loop and the keyof operand contradict each other

The step says: rework `arrayTypeParser`'s suffix from `count(str("[]"))` to a loop that stops "when neither matches", and give `keyofTypeParser` the operand `capture(lazy(() => arrayTypeParser), "operand")`. Whether the loop requires at least one suffix is left unstated, and neither choice works:

- **Loop requires ≥1 suffix** (what `count` does today — it fails on zero matches, `tarsec/dist/combinators.js:79`): then `keyof User` fails to parse. The operand parser is `arrayTypeParser`, `User` has no bracket suffix, so the operand fails.
- **Loop allows 0 suffixes:** then `arrayTypeParser` succeeds on any bare base type. Its base chain contains `typeAliasVariableParser`, and it sits BEFORE the slot the plan assigns to `keyofTypeParser` in both or-chains (position 3 in `variableTypeParser`, position 4 in `unionItemParser`). On input `keyof User`, `arrayTypeParser` matches the bare identifier `keyof` with zero suffixes and returns `typeAliasVariable("keyof")`, leaving ` User` unconsumed. `or()` commits to the first success, so `keyofTypeParser` never runs and every `keyof` annotation is a parse error one token later. The plan's ordering instruction ("before genericTypeParser, typeAliasVariableParser") misses this because those parsers are also embedded inside `arrayTypeParser`'s base chain.

**Fix:** split the two roles. Extract the shared pieces: the base or-chain and a `typeSuffix` parser (`[]` → array wrap, `[<type>]` → index wrap). Then:

- `arrayTypeParser` (the or-chain member, exported name unchanged) = base + **many1**(suffix). This preserves today's or-chain behavior exactly: bare types still fall through to the later alternatives, and `User["name"]` matches because the index bracket counts as the one required suffix.
- keyof's operand = a private `postfixOperandParser` = base + **many0**(suffix). Only `keyofTypeParser` uses it, so its bare-match greediness leaks nowhere.

`(keyof User)[]` still works without extra code: `parenthesizedTypeParser` is in the base chain and routes through `variableTypeParser`, which will contain `keyofTypeParser`.

### 2. Task 2 re-implements what `builtinGenerics.ts` already owns (spec-review finding not absorbed)

The plan's `resolveObjectOperand` is a line-for-line duplicate of `resolveObjectArg` (`lib/typeChecker/builtinGenerics.ts:105`), down to the error string. The missing-key error diverges from Pick's ("no property 'x' on the indexed type" vs Pick's "Pick key 'x' does not exist on the target type", :227) — the spec said same wording family, and shared code is how the family stays a family. `resolveKeysArg` (:120) already implements "resolve an index to literal strings."

**Fix:** export `resolveObjectArg` (and `resolveKeysArg` if it fits the index-resolution shape) from `builtinGenerics.ts` and consume them in `typeOperators.ts`, parameterized by operator name. If the executor finds a concrete reason the helpers do not fit, the plan permits divergence — but say so in a comment at the divergence site, not silently. This also keeps the two "expects an object type" messages from drifting apart later.

## Should-fix findings

### 3. The resolver branches drop `vt.tags`

Task 2 Step 3's branches call `evalKeyof(vt.operand, ...)` and discard the occurrence node's `tags`. Compare the `genericType` branch it sits next to: `evalBuiltinGeneric(vt.name, vt.typeArgs, resolve, vt.tags)` threads them through. Today no parser path sets tags on the new variants, so nothing breaks — but then the plan is declaring a `tags?: Tag[]` field that nothing writes and the resolver ignores. Pick one: thread `vt.tags` into the result with `mergeTagSets` (one line, mirrors `withUseSiteTags`), or drop the field from both variants and note why. Shipping a dead field plus an asymmetric resolver is the worst of the three options.

### 4. Printer parenthesization is missing, and the round-trip tests will not catch it

`formatTypeHint` prints `arrayType` as `${recurse(elementType)}[]` (`lib/utils/formatType.ts:35-36`). With a `keyofType` case that prints `keyof <operand>`, the type `(keyof User)[]` — an arrayType whose element is a keyofType — prints as `keyof User[]`, which re-parses as `keyof (User[])`. Same trap for an indexed access whose object is a parenthesized keyof. The plan's round-trip cases (`keyof User`, `User["name"]`) are both flat and will pass over the bug.

**Fix:** in both printers, parenthesize a `keyofType` that appears as an array element or as an indexed-access object. Add round-trip tests for `(keyof User)[]` and `keyof User[]` (asserting they stay distinct) alongside the flat cases.

### 5. Small gaps versus the spec

- **The reserved-name grep is missing.** The spec requires a grep confirming no stdlib or test code uses `keyof` as an alias/identifier before reserving the keyword. Add it to Task 1 (or Global Constraints) with the command and the expectation of zero hits in `.agency` sources.
- **Union index parse is untested.** `User["a" | "b"]` is exercised at eval level only. The suffix parser accepts it because brackets take a full `variableTypeParser`, but nothing pins that. One parse test.
- **Optional-property indexed access is unpinned.** `foo?: T` desugars to `T | null` at parse time (`parsers.ts:1110-1137`), so `User["optionalField"]` should include null with zero new code. One pipeline case documents the interaction.
- **`keyof UnknownAlias` behavior is unpinned.** Unknown aliases resolve to themselves (`resolveTypeWithGuard` returns `vt` when the entry is missing), so this lands in the swallowed-TypeError family: zero typecheck diagnostics, fatal at codegen. Task 2 Step 3 says "add a test rather than code if it already falls out" for reference validation — make this the named test case.

## Minor notes

- **"Verified facts" #11 overstates tsc's reach.** "the never-defaults catch the variant everywhere else" — they catch `typeKey` and `valueParamSubstitution` only. `formatTypeHint`'s default throws at runtime (not compile time), the zod mapper falls back silently, and the walkers pass through silently. The plan handles each site explicitly in its steps, so only the sentence needs fixing — but fix it, or the executor may trust `make` as the complete checklist.
- **`keyof(User)` without a space will not parse** because `keyofTypeParser` requires `spaces` after the keyword. That same requirement is what makes `keyofish` fall through to an identifier, so it is a fine trade — worth one line in the parser comment so nobody "fixes" the spaces into optional and breaks the keyword boundary.
- **The last Task 2 pipeline test's hedge is good.** `type keyof = ...` still parses (alias names come from `many1WithJoin(varNameChar)`, not the type-expression grammar), so the reserved-name check at `lib/typeChecker/index.ts:220` is what fires; the toThrow fallback note is the right kind of hedging.

## Anti-pattern audit (docs/dev/anti-patterns.md)

The plan's interface design passes the catalog's central test: `evalKeyof`/`evalIndexedAccess` are pure, resolver-injected functions mirroring `evalBuiltinGeneric`, the operator nodes are invisible downstream of resolution (no leaky abstraction), and the parser rework hides behind `arrayTypeParser`'s existing name. The imperative suffix loop is fine — the catalog exempts parsers, and the existing `arrayTypeParser` already uses the same mutate-and-wrap style.

Two entries are tripped, and both restate findings 2 and 3 with catalog backing:

- **Duplicating existing code.** `resolveObjectOperand` duplicates `resolveObjectArg` (builtinGenerics.ts:105), and the imperative core of `evalIndexedAccess` — the map callback that resolves members and validates literal-ness — duplicates `resolveKeysArg` (:120). `collectLiteralKeys` (assignability.ts:277) is already a third implementation of literal-key extraction; the plan would add a fourth.
- **Inconsistent patterns.** The missing-key error wording diverges from Pick's for the same operation, and the new resolver branches drop `vt.tags` while the adjacent `genericType` branch threads them through.

These converge on one fix: consume an exported `resolveKeysArg`, and `evalIndexedAccess` collapses to `keys = resolveKeysArg(...); results = keys.map(lookupProperty)` — declarative shape, no duplication, no wording drift, in one change.

Non-findings, checked deliberately: the `length === 0` / `length === 1` returns in `evalKeyof` are not useless special cases (the parser enforces unions have ≥2 members, so unwrapping is required); no order-dependent mutable state outside parsers; no swallowed catches, nested ternaries, magic numbers, dynamic requires, or nested type definitions. The brace-less guard returns technically violate the one-line-if entry, but that guard style is pervasive in the exact files being modified (assignability.ts:52,64,72,163) and matching surrounding code wins; `lint:structure`, which the plan runs, is the arbiter.

## Test-plan audit: will the tests fail when the code breaks?

### Tests that cannot fail for the failure mode they exist to catch

- **Task 3, "indexed-access alias emits the property schema" is a false-green.** It asserts `const N = z.string()` for `type N = User["name"]`. But the zod mapper's fallback for unresolved nodes is `DEFAULT_SCHEMA` = `z.string()` (`typeToZodSchema.ts:125-126`; the `never` case's own comment confirms the fallthrough target). If `deepResolveNode` never routes `indexedAccessType`, the unresolved node falls through to `z.string()` and the test passes anyway. The plan's own red-first step betrays this: Step 2 predicts only the `K` assertion goes red — the `N` test is born green. **Fix: index a non-string property.** `type N = User["age"]` → assert `const N = z.number()`, which the fallback cannot fake.
- **The union-index and keyof-composition unit tests assert only `{ type: "unionType" }`.** `evalIndexedAccess(user(), idx, id)` returning the union of KEYS instead of the union of VALUES — a plausible bug, since the index is itself a union — still passes both. Assert the members: `types: [STR, { ...NUM with the validate tag }]` for the union-index case, and the concrete value types for the `T[keyof T]` composition case.

### Verified strong points (checked against the code, not just the plan)

- The match-missing-case test is the real safety net for silent degradation: if evaluation throws and `safeResolveType` degrades `keyof User` to `any`, exhaustiveness checking disappears and the expected `/age/` diagnostic never fires — the test fails. Positive-accept tests alone would all keep passing under `any`.
- The indexed-annotation reject test (`= 5` expects `/not assignable/`) doubles as a crash detector: if a diagnostic formats the unresolved `indexedAccessType` and `formatTypeHint` lacks the case, its default throws (`formatType.ts:83`) and the test fails loudly.
- The execution test's `rejects` node catches the z.string() fallback end-to-end: a fallback schema would accept `"email"`.
- `evalKeyof`/tag tests use `toEqual` (exact), so key order, tag ride-along, and no-tags-on-keyof are all pinned, and the no-mutation test guards the resolver-input contract.
- The `keyof number` zero-diagnostics pin is a deliberate tripwire that will fail when located diagnostics land — correct use of a pin.

### Missing test cases

1. **Direct negative for keyof assignability.** Every keyof pipeline test is positive-accept except the match case. Add `const k: keyof User = 12345` (or `"bogus"`) → `/not assignable/`. Cheaper and more direct than relying on the match net.
2. **Formatter round-trip in alias position.** The spec requires round-trips "in parameter and alias positions"; the plan tests parameters only. Add `type F = keyof User` and `type N = User["name"]` through the generator.
3. **`keyof` on a union of objects.** TypeScript distributes keyof over unions (intersection of keys); Agency v1 errors instead. That divergence is owner-decided and nothing pins it. Add the unit error case (and `keyof string[]`, which is in the spec's semantics table but absent from the unit tests — only `number` and `Record` are covered).
4. **End-to-end tag enforcement after indexing.** The unit test checks the tag OBJECT rides along; nothing proves the `@validate` annotation still enforces at runtime once the property type is extracted (`type N = User["age"]` with a range validate; schema parse rejects an out-of-range value). The descriptor/walker codegen path (`validationDescriptor.ts`) branches on `VariableType.type` and is otherwise untested for the new variants.
5. **Keyword-boundary regression pin.** `keyofish` parsing as a plain identifier is load-bearing (it is what the required `spaces` buys) and untested — the first person to make the whitespace optional breaks it silently.
6. From earlier findings, still open: union-index parse (`User["a" | "b"]`), `(keyof User)[]` parse + parenthesization round-trips, `keyof UnknownAlias` swallow pin, `User["nope"]`-in-source swallow pin (only `keyof number` is pinned), optional-property indexing includes null.

## Claims I verified as accurate

- `typecheckSource` exists at `lib/typeChecker/testUtils.ts:20` and runs the full parse → SymbolTable → CompilationUnit → typeCheck pipeline.
- The execution-test syntax is exactly right: `isSuccess(r)` / `r.value` / `isFailure(r)` and the JSON-wrapped `expectedOutput` match `tests/agency/utility-partial.agency` and its test.json line for line.
- The codegen expectations match real emission: fixtures emit `const Category = z.union([z.literal("bug"), z.literal("feature"), ...])` with exactly that spacing, and `typeToZodSchema.ts:131,138` produce those forms.
- `parseAgency(source, {}, false)` matches the signature (`lib/parser.ts:256`); `n.type === "function"` is the right discriminant; the Tag literal in the unit tests matches `lib/types/tag.ts` (`{ type, name, arguments }`).
- Match-arm syntax `"a" => { ... }` matches existing tests (`tests/agency/goto-match-arm.agency`). Definite-returns skips functions containing match, so the exhaustive-match test's `expect(errors).toEqual([])` will not trip on a stray warning.
- `tests/agency/utility-partial.agency` and `tests/agency/recursive-type.agency` exist, so Task 5's regression loop runs real tests.
- The forward-reference codegen test is sound: keyof evaluates through the order-independent alias table, so `type K = keyof Later` inlines literal keys with no z.lazy needed.
- Task 3's red-first sequencing genuinely observes the `deepResolveNode` trap before fixing it, and the fixture zero-churn gate plus the Task 5 re-runs of the utility-type and recursive-alias tests are the right guards for a change that sits on every type annotation's parse path.
