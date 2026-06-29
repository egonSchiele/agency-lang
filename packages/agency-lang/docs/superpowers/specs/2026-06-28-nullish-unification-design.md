# Design: Nullish Unification (Project 1)

## Summary

Agency currently has an incoherent treatment of `null` and `undefined`. This
project makes Agency have **one nothing-value: `null`.** `undefined` is never
writable by users (already true) and is *absorbed* into `null` wherever it
arises from the JS runtime or TypeScript interop. The type-level representation
of optionality flips from `T | undefined` to `T | null`, so the type system
finally matches the `null` the codegen already emits.

This is **Project 1** of a two-project arc. **Project 2 — null safety**
(flow-sensitive null narrowing + strict member access on possibly-null values)
is explicitly out of scope here and folds into the existing narrowing roadmap
(see `null-truthiness-narrowing-spec.md` and the `strictMemberAccess` work in
`result-as-union-spec.md`).

The **rationale** for treating `null` and `undefined` as one value — the
cross-language survey, the alternatives we weighed, and why we rejected each —
is documented separately in
[`docs/dev/null-and-undefined.md`](../../dev/null-and-undefined.md). This spec
is the "what"; that doc is the "why."

## Motivation

### The current mess (verified against source)

Agency today is internally inconsistent about which nothing-value it uses:

- **Type representation of optionality is `undefined`.** `key?: T` desugars to
  `T | undefined` (`parsers.ts` `objectPropertyParser`, ~line 1049–1076);
  `UNDEFINED_T = { primitiveType, "undefined" }` (`primitives.ts:8`);
  `isOptionalType` keys on `"undefined"` (`assignability.ts:403`).
- **But the Zod codegen already emits `null`.** Both `null` and `undefined`
  primitive types map to `z.null()` (`typeToZodSchema.ts:92–95`).

So the *type* says `undefined` while the *runtime* produces `null`. The two
halves of the compiler disagree.

- **`undefined` is not writable as a value.** There is a `nullParser` but no
  `undefinedParser` (`parsers.ts:813`); `undefined` only exists as a *type*
  keyword (`primitiveTypeParser`, ~line 862). Users like this — code containing
  the value `undefined` simply does not parse.
- **Assignability treats `null` and `undefined` as distinct, incompatible
  primitives** (strict `value === value`, `assignability.ts:519–524`).
- **The `null` literal synthesizes to `any`** (no `case "null"` in
  `synthType`; falls through to `default: return "any"`).
- **Equality compiles strict.** `==` → `===`, `!=` → `!==`
  (`typescriptBuilder.ts:1067–1068`), and equality operands are **not
  type-checked at all** (`BOOLEAN_OPS.has(op)` just returns `BOOLEAN_T`,
  `synthesizer.ts:247`).
- **`schema(T).parse({})` is broken for optional keys.** `schema(T)` compiles
  through `mapTypeToValidationSchema` (`typescriptBuilder.ts:790`), so an
  optional key `k?: string` becomes `z.union([z.string(), z.null()])` —
  `.nullable()` semantics, which *rejects a missing key*. Parsing `{}` against
  `{ k?: string }` therefore fails today.

### Why unify rather than match TypeScript

Cross-language research: every language designed without JS's backward-compat
constraint picked **one** nothing-value (Python `None`, Ruby `nil`) or **zero,
type-wrapped** (Rust `Option`, Haskell `Maybe`). The one language that keeps
both (Zig) gives `undefined` a single narrow job — uninitialized memory — and
makes `null` the value you actually program with. JS's two-nothing-values design
is near-universally regretted and survives only because JS cannot break
backward compatibility. Agency has no such constraint, so it can drop the wart.

Crucially, Agency compiles to JS, so `undefined` *exists at runtime* whether or
not the surface language acknowledges it (missing keys, optional chaining,
out-of-bounds index, functions that fall off the end, TS interop). The design
therefore does not *pretend* `undefined` is absent — that would be unsound.
Instead it makes `null` **absorb** `undefined`: they compare equal, and
`undefined` is normalized to `null` where it enters typed data.

## Goals

- One surface nothing-value: `null`. `undefined` stays unwritable as a value.
- Optionality's type representation is `T | null` (was `T | undefined`).
- `null` and `undefined` compare equal at runtime, so a single null check
  catches a runtime `undefined` (e.g. from interop).
- `schema(T).parse({})` succeeds for optional keys, coalescing a missing key to
  `null`.
- TS interop types containing `undefined` read as `null` in the type checker.
- The LLM structured-output path is unchanged (already `null`, forced by
  provider constraints).

## Non-goals (deferred to Project 2 / existing roadmap)

- **Strict null checking** — making `x.foo` on a possibly-null `x` a hard error
  until narrowed (`strictMemberAccess` on the null member).
- **Null narrowing** — `if (x == null)` / `if (x)` removing the null member
  inside a branch. This is `null-truthiness-narrowing-spec.md`, retargeted from
  `undefined` to `null`.
- **Type-checking equality operands** — `==` / `!=` operands are not type-checked
  today (`BOOLEAN_OPS` short-circuits to `BOOLEAN_T`, `synthesizer.ts:247`), so
  `5 == "5"` type-checks clean. This project does not change that. It is a real
  gap for an agent-feedback language and a natural co-resident of the flow
  checker (you have `T | null` types and narrowing right there), so it belongs
  with the Project 2 / strict-checking work — recorded here so it is not lost.
- Making the `null` literal synthesize to the `null` type (currently `any`).
  This only matters once strict checking lands and drags in
  declaration-widening questions; left as-is in P1.
- A `delete` operation for object keys (unneeded under "check the value, not the
  key's presence").
- A nominal `Option`/`Maybe` type (rejected — strict-checked `T | null` gives
  the same safety without the ceremony; what was sketched as `Maybe<T>` is just
  `T | null` with a different name, and the safety comes from the checker, not
  the representation).

## Design

### §1 Type-representation flip

- `objectPropertyParser`: `key?: T` desugars to `T | null` (was `T |
  undefined`). When `T` is already a union, append `null` instead of
  `undefined`.
- Optional parameter `x?: T` (no default) types as `T | null`. (The runtime
  already assigns the `null` *value* via the `{ type: "null" }` default the
  parser injects, `parsers.ts:4167–4169`; this aligns the static type.)
- Retire `UNDEFINED_T` in favor of `NULL_T`. Audit every reference to
  `UNDEFINED_T` and the `"undefined"` primitive string in the type checker and
  repoint to `null`.
- `isOptionalType` keys on `null` (and `any`), `assignability.ts:403`.
- The `undefined` **type keyword** stays parseable but **normalizes to `null`**.
  **Normalize eagerly at the ingestion boundary** — the type-keyword parser and
  the TS-interop import path rewrite `{ primitiveType, "undefined" }` to `null`
  as the type is constructed/imported, so the stored AST never contains an
  `undefined` primitive. Keep the lazy `resolveType` normalization only as a
  backstop. This is deliberate: a stray un-normalized `undefined` primitive would
  mismatch `null` in any code that inspects a type *structurally without
  resolving first* — `formatType` (an error message showing `| undefined`),
  union dedup/equality, type-keyed caches, and the assignability fast-paths that
  match `.value` before `safeResolveType`. Lazy-only normalization makes the §1
  "audit every reference" sweep load-bearing for *correctness*, not just
  tidiness, and the risk compounds once the flow checker's `uniteTypes` dedups
  union members at joins (a stray `undefined` member that fails to collapse into
  `null` becomes `T | null | undefined` and defeats null-narrowing). The *value*
  `undefined` remains unparseable (no `undefinedParser` is added). This lets an
  imported TS type `string | undefined` read as `string | null`.
- Assignability: once `undefined` types normalize to `null`, the strict
  primitive-equality rule (`assignability.ts:519–524`) needs no special case —
  there is only `null`.

### §2 Runtime equality: the `__eq` helper

Equality must treat `null` and `undefined` as one without needing operand type
information at the comparison site.

- Add `__eq(a, b)` to the runtime (`lib/runtime/`):

  ```ts
  export function __eq(a: unknown, b: unknown): boolean {
    return a === b || (a == null && b == null);
  }
  ```

  `a == null` (loose) is true for exactly `null` and `undefined` and nothing
  else (not `0`, `""`, `false`, `NaN`). So `(a == null && b == null)` means
  "both nullish," and `a === b` handles every other case exactly. Verified
  property: for any value `x`, `__eq(x, null) === __eq(x, undefined)` (both
  reduce to "is `x` nullish?"), and for two non-nullish values `__eq` is
  identical to `===`.

- Codegen (`typescriptBuilder.ts:1067–1068`): `==` → `__eq(left, right)`, `!=`
  → `!__eq(left, right)`. **`===`/`!==` stay strict** as the explicit "exact"
  escape hatch. `<`, `>`, `<=`, `>=`, `=~`, `!~` are untouched.

- Using a helper (not an inline `a === b || (a == null && b == null)`) is
  deliberate: operands are passed as arguments and therefore **evaluated
  exactly once**, so expressions with side effects are not double-evaluated.

- Behavior change is confined to nullish values: every non-null comparison
  remains identical to today's strict `===`, so existing programs do not
  regress.

`??` (`synthNullishCoalesce`) already strips both `null` and `undefined`; no
change needed.

### §3 The schema feature (`schema(T).parse(...)`)

The two existing Zod mappers stay split by purpose:

- **LLM mapper** (`mapTypeToZodSchema`): optional key → `z.union([T,
  z.null()])` (required + nullable). **Unchanged** — OpenAI structured output
  requires every field to be `required`, with optionality expressed only as a
  union with null.

- **Parse/validation mapper** (`mapTypeToValidationSchema`, used by `schema(T)`
  and `!` validation): an optional key becomes **truly optional and coalesces a
  missing key to `null`**, so the parsed object has every declared key present:

  ```
  schema({ foo?: string }).parse({})   →   { foo: null }
  ```

  Intended Zod shape (exact encoding pinned in the implementation plan): accept
  a missing key, accept `null`, and normalize the result to `null` — e.g.
  `z.union([T, z.null()]).optional()` followed by a transform that maps
  `undefined → null`, or `.default(null)`. The chosen encoding must round-trip
  `{}` → `{ foo: null }` and `{ foo: "x" }` → `{ foo: "x" }`.

### §4 TypeScript interop

- TS types carrying `undefined` (e.g. a function returning `string |
  undefined`) normalize to `null` at the type boundary (§1), so Agency code
  checks against `null` and type-checks.
- A runtime `undefined` flowing in from interop is caught by `__eq` (§2): `x ==
  null` is true for it.
- Documented sharp edge: passing an actually-`undefined` value *back* into TS
  code that strictly distinguishes `=== undefined` from `=== null` is the one
  rare case where the absorption is observable. The surface escape hatch is
  `===` / `!==`, which are parseable Agency operators (`parsers.ts:2628–2629`)
  and stay strict (they pass through codegen unchanged), so a user who genuinely
  needs to distinguish `null` from `undefined` can still write `x === null`. This
  is a doc note, not a code change.

### §5 Migration & coordination

- `null-truthiness-narrowing-spec.md` must be retargeted from `undefined` to
  `null` before it is implemented. It is the last, as-yet-unbuilt item on the
  narrowing roadmap and already anticipates this flip ("If a `null` primitive is
  ever added, the same member-filter applies to it"), so coordination risk is
  low.
- Existing `key?:` types shift from `T | undefined` to `T | null`. The runtime
  was already `null`-centric via Zod, so behavior is stable.
- The `===` → `__eq` change for `==` is the main runtime behavior shift and is
  strictly *more* correct (null checks now also catch `undefined`).
- Sweep fixtures and tests that reference `undefined` types and repoint them to
  `null`.

### §6 Coordination with the flow checker and the `never` type

This project lands **before** the flow-typed checker work
(`2026-06-29-flow-typed-checker-design.md`) and its null/truthiness narrowing
follow-on. Landing nullish-first is deliberate: it lets the narrowing recognizer
be written once against `null`, takes the `T | undefined` → `T | null` fixture
churn before the flow PRs add more narrowing fixtures, and makes the runtime and
the type representation agree so narrowing and `__eq` cannot disagree. Four
coordination points:

- **Narrowing recognition is unaffected by the `==`→`__eq` codegen change.**
  `analyzeCondition` keys on the AST operator `==` / `!=` (`narrowing.ts:99`),
  which is upstream of codegen, so `if (x == null)` is recognized regardless of
  how `==` lowers. And the unified-null semantics of `__eq` *match* what
  null-narrowing does: stripping the `null` member catches both a runtime `null`
  and an interop `undefined`. The old `T | undefined` representation would have
  made the narrowing and the runtime disagree — another reason to land this
  first.
- **The "`null` literal synthesizes to `any`" non-goal does not block
  null-narrowing.** Recognition is syntactic (it keys on the `null` literal AST
  node, not its synthesized type), and the union member to strip is the real
  `null` primitive in `T | null`, not the literal's type. So deferring the
  literal-type fix to Project 2 is safe for the flow checker.
- **`never` composition (once the flow checker's PR 0 lands).** With a real
  bottom type, null-narrowing produces precise dead-branch signals:
  `if (x != null)` on `x: null` → `never`; `if (x == null)` on a non-nullable
  `x: string` → the then-branch is `never` (a provably impossible null check).
  Nullish unification + `never` + null-narrowing together give TS-grade "this
  null check can't happen" diagnostics. This is intentional, not accidental — the
  flip to `T | null` is the precondition.
- **`stripNullable`'s empty sentinel.** `stripNullable` returns JS `undefined`
  for "nothing left after stripping nullish" (`synthesizer.ts:323`). That is fine
  in P1, but once the `never` type exists the conceptually correct result is
  `never`. Flag it for revisit with the `never` PR rather than leaving it
  `any`-ish; not a P1 change.

## Testing

Agency execution tests (no LLM required):

- `schema({ foo?: string }).parse({})` → `{ foo: null }`; `parse({ foo: "x" })`
  → `{ foo: "x" }`.
- Nested optional coalescing: `schema({ a?: { b?: string } }).parse({})` →
  `{ a: null }` (coalesce only the missing level — no recursion into `b`);
  `parse({ a: {} })` → `{ a: { b: null } }`.
- Already-nullable optional key: `schema({ k?: string | null }).parse({})` →
  `{ k: null }` (the duplicate `null` member dedups; the default still applies).
- A null check (`x == null` / `x != null`) catches a runtime `undefined`
  surfaced via interop or a missing key.
- `__eq` truth table: `null`/`undefined` equal each other; `0`/`""`/`false`
  remain distinct from nullish; non-null comparisons match `===`.
- Optional parameter without an argument resolves to `null`.
- `??` over a `T | null` value.

Type-checker unit tests:

- `key?: T` synthesizes `T | null`.
- The `undefined` type keyword normalizes to `null` (incl. an imported TS
  `string | undefined` reading as `string | null`).
- `isOptionalType` returns true for `null`.

## Open implementation details (for the plan, not blocking design)

- Exact Zod encoding for parse-side optional-key coalescing (§3).
- Full inventory of `UNDEFINED_T` / `"undefined"` references to repoint (§1).
- Whether any runtime/stdlib helper currently depends on `==` compiling to
  `===` in a way that the `__eq` switch would change (expected: none, since
  `__eq` only differs on nullish).
