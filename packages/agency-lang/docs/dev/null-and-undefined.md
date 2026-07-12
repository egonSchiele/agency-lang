# `null` and `undefined` in Agency

This document explains a deliberate language-design decision: **Agency has one
nothing-value, `null`, and treats `undefined` as identical to it.** It records
what we decided, the alternatives we weighed, and *why* we chose unification —
because this question resurfaces often and the reasoning is subtle.

The concrete implementation is specified in
[`docs/superpowers/specs/2026-06-28-nullish-unification-design.md`](../superpowers/specs/2026-06-28-nullish-unification-design.md).
This doc is the "why"; that spec is the "what."

## The decision in one paragraph

There is exactly one nothing-value in Agency: `null`. Users cannot write
`undefined` as a value (the parser has no `undefinedParser`, only a
`nullParser`). Optionality is `T | null`. At runtime, `null` and `undefined`
compare equal (via the `__eq` helper), and `undefined` arriving from the JS
runtime or TypeScript interop is absorbed into `null`. `undefined` is never a
distinct concept a user has to reason about.

## Background: why this even comes up

Agency compiles to TypeScript/JavaScript, which famously has **two**
nothing-values. This leaked into Agency incoherently:

- The **type** representation of optionality was `undefined`: `key?: T`
  desugared to `T | undefined`, and `isOptionalType` keyed on `"undefined"`.
- But the **Zod codegen** already emitted `null`: both `null` and `undefined`
  primitive types mapped to `z.null()`.

So the type system said one thing and the runtime did another. On top of that,
the `null` literal synthesized to `any`, assignability treated `null` and
`undefined` as distinct primitives, and `schema(T).parse({})` was broken for
optional keys (a missing key is `undefined` at runtime, but the generated schema
only accepted `string | null`). The language had inherited JS's two-value wart
without inheriting a coherent story for it.

## The conceptual distinction (and why it's a trap)

`null` and `undefined` *can* be given distinct meanings, and many TypeScript
style guides do:

- `undefined` = "uninitialized / not present / never set."
- `null` = "intentionally set to no value."

This is a real, defensible distinction. It even has a sharper cousin that
TypeScript exposes via the `exactOptionalPropertyTypes` flag: the difference
between a key being **absent** and a key being **present but `undefined`**.

The trap is that this distinction is **mostly useless in practice and a
constant source of friction**:

- Most developers can't articulate when to return `void` vs `null` vs
  `undefined` for "no value" — they feel equivalent, so every codebase invents
  its own convention and then has to police it.
- TypeScript itself treats `key?: T` and `key: T | undefined` as interchangeable
  *by default*. The precise distinction is opt-in via
  `exactOptionalPropertyTypes`, and — tellingly — that flag is deliberately
  **not** part of the `strict` family. The TS team kept it separate because it
  is too disruptive to turn on for everyone. In practice the large majority of
  codebases never enable it. The "absent vs present-undefined" distinction is a
  narrow, advanced concern (object spread/merge clobbering fields, PATCH
  semantics where `null` = "clear" and absent = "don't touch") that does not
  apply to Agency's audience of agent-workflow authors.

So the distinction is sound in theory, rarely useful in practice, and a reliable
source of confusion. That is exactly the kind of thing a new language should
drop if it can.

## What other languages do

We surveyed how other languages handle "nothing," because it reframes the whole
question:

| Language | Nothing-values | Notes |
|---|---|---|
| **Python** | One (`None`) | A missing dict key / unbound name is an *error*, not a second nothing-value. |
| **Ruby** | One (`nil`) | Unset instance var → `nil`; unset local → `NameError`. |
| **Rust** | Zero (free) | No null. `Option<T>` = `Some(T) \| None`; the compiler *forces* you to handle `None`. |
| **Haskell** | Zero (free) | No null references. `Maybe a = Just a \| Nothing`. (`undefined`/⊥ is a divergent error term, not a comparable value.) |
| **Zig** | Two (`null` + `undefined`) | But crisply split: `null` is the value of optionals (`?T`); `undefined` is *only* an "uninitialized memory" marker — not a value you pass around or compare, and reading it is a bug caught in safe builds. |

Two conclusions:

1. **JS's two-nothing-values design is near-universally regretted and unique to
   JS.** Brendan Eich and essentially everyone consider it a mistake. It
   survives only because JS cannot break backward compatibility. Every language
   designed from scratch picked **one** nothing-value (Python/Ruby) or **zero,
   type-wrapped** (Rust/Haskell).

2. **The one language that keeps both (Zig) does not use `undefined` as a
   general empty value.** It gives `undefined` a single narrow job
   (uninitialized) and makes `null` the thing you program with. Agency has no
   "declare a variable without initializing it" pattern — `let`/`const` always
   take a value — so even Zig's narrow justification for `undefined` does not
   exist here.

**Agency is not bound by JS's backward-compatibility constraint.** TypeScript has
to live with JS's warts to stay compatible; Agency is a separate language that
merely *compiles to* JS. So Agency can do what the from-scratch languages did:
have one nothing-value.

## The key fact that constrains the design

Even though Agency can *choose* to have one nothing-value, it **cannot make
`undefined` not exist at runtime**, because it compiles to JavaScript and JS
produces `undefined` everywhere regardless of the surface language:

- a missing object key reads as `undefined`
- an out-of-bounds array index → `undefined`
- a function that falls off the end without returning → `undefined`
- optional chaining `a?.b` → `undefined`
- any TypeScript interop can hand back `undefined`

This rules out the naive "just pretend `undefined` doesn't exist" approach: if
the type system declared `undefined` impossible while the runtime kept producing
it, you would get values flowing through the program that the types say can't
exist — an unsoundness hole, and the *worst* outcome (the confusion isn't
removed, just hidden).

The design therefore does not *ignore* `undefined` — it **absorbs** it. `null`
and `undefined` are made to behave identically everywhere a user can observe
them, and `undefined` is normalized to `null` where it enters typed data.

As of the index/match normalization work (issue #409), the two most common of
these value leaks — a missing object key / out-of-bounds index (`obj[key]`,
`arr[i]`) and an unmatched `match` expression — are normalized to `null` at the
value level via the `__nn` runtime helper (`x ?? null`). A *terminal* index read
of an access chain and the `__matchval_<id>` read that consumes a match result
are wrapped in `__nn`, so they yield `null` rather than `undefined` as an
observable value. This complements `__eq` (which unifies the two only at
*comparison* sites) by unifying them at the *value* level too. The wrap is
terminal-only and skipped for assignment/update targets, so JS optional-chain
short-circuit is preserved (`a?.[b].c` stays `undefined`, does not throw) and
lvalues (`x[i]++`, `x[i] += v`) stay valid. The remaining leak sites (optional
chaining, destructuring a missing field, falling off a function without
`return`, and TypeScript interop) are not yet normalized and are tracked as
follow-ups.

## Alternatives considered

### A. Full TypeScript parity (keep both, distinct)

Add an `undefined` literal so users can write it; keep `null` and `undefined` as
distinct values with distinct meanings.

Rejected. It imports the exact wart we wanted to remove. The "absent vs
present-undefined" precision it buys is the narrow, advanced concern Agency's
users don't have, and it forces every user to learn and police a convention they
mostly find useless. It is also *not* what most TypeScript developers experience
day to day (default TS blurs `?` and `| undefined`).

### B. Zig-style split (`null` is the value, `undefined` only uninitialized)

Keep `undefined` as a narrow "uninitialized" marker, rarely written.

Rejected. Agency has no declare-without-initialize pattern, so the one job that
justifies `undefined` in Zig does not exist here. It would be machinery with no
use case.

### C. A nominal `Option`/`Maybe` type (Rust/Haskell style)

Drop `null` entirely; absence is `Option<T>` with forced unwrapping.

Rejected for this project. The thing sketched in discussion — `Maybe<T>`
meaning "T or null," assignable directly from a bare value or `null` — is **not**
the Rust/Haskell `Option`. In Rust you cannot write `let x: Option<i32> = 5`;
you must wrap (`Some(5)`) and cannot use the value until you unwrap it. *That
friction is the entire source of the safety.* What was sketched is just
`T | null` with a nicer name, which buys nothing on its own.

The real safety win — forcing you to handle absence before using a value — comes
from the **type checker being strict about nullable access**, not from the
runtime representation or the type's name. You can get full `Option`-grade
safety while compiling to plain `T | null`, purely by making the checker reject
`x.foo` on a possibly-null `x` until it's narrowed. A nominal `Option` type
would be a much larger, more ceremonious change that fights Agency's
TS-flavored syntax and compile target, for the same safety. So strict nullable
checking (see "Relationship to null safety" below) is the chosen path, not a
nominal `Option`.

See the next section for the fuller decision on a built-in `Maybe` type
specifically.

## Should Agency have a built-in `Maybe` type?

We considered adding a built-in `Maybe<T>` (a.k.a. `Option`) — a `some(T)` /
`none` wrapper analogous to Agency's existing `Result<T, E>`. **Decision: no.**
`T | null` plus strict null checking (Project 2) is the one way to express
optionality.

The attraction was real: a `Maybe` type forces you to unwrap absence, it could
chain with the pipe operator, and it could be a named domain type for
"something or nothing" return values (including tool results, where `Result`
already works well). But each advantage is weaker than it first appears once you
account for what Agency already has or is already building:

1. **Forced unwrapping is already delivered by strict null checking.** Once the
   checker rejects member access on a `T | null` until it's narrowed, you cannot
   use a possibly-absent value without handling absence. `Maybe`'s headline
   safety feature adds essentially nothing over strict-checked `T | null` — the
   safety comes from the checker, not the wrapper.

2. **Pipes are already `Result`-native.** `synthPipe` wraps every pipe's output
   in a `resultType`; the pipe operator is designed around `Result`. So
   "a wrapper that pipes well with short-circuiting" is not a gap — `Result`
   already is that, and a "might be absent" pipeline can model absence as
   `failure`. A second pipe-friendly wrapper would be redundant.

3. **Tools are better served by `T | null` than by `Maybe`.** A tool returning
   `T | null` maps directly onto the LLM structured-output schema, where `null`
   is *exactly* how optionality is encoded (required + nullable). A tool
   returning `Maybe<T>` would need a new `some`/`none` representation in the
   JSON schema — strictly *more* complex than the null encoding the provider
   already wants.

Against those weak gains, a built-in `Maybe` carries real costs:

- **It reintroduces the fork this project exists to remove.** We eliminated
  "`null` or `undefined`?"; adding `Maybe` creates "`T | null` or `Maybe<T>`?"
  at every optional value.
- **It reopens the absent-vs-null distinction we deliberately killed:**
  `Maybe<T>` where `T` admits null distinguishes `none` from `some(null)`.
- **Large surface:** new type, constructors, pattern-matching, narrowing,
  `Result`/pipe interop, LLM-schema mapping, tool integration, docs.

The only world where `Maybe` clearly wins is **all-in, Rust/Haskell style**: no
nullable type at all, absence expressed *only* as `Maybe<T>`, `null` not
writable. That is principled and fork-free — but it contradicts the `T | null`
direction chosen here (and the preference for being able to write `null` and
keep `key?:` simple), and it is a much larger, separate project. The genuinely
bad option is the **half-measure** — shipping *both* `T | null` and `Maybe<T>` —
which is the worst of both worlds: two overlapping ways to say the same thing.

If heavy pain ever shows up specifically in *optional* pipelines, the better
levers to revisit are null-aware pipe sugar or wider `Result` use — not a third
optional concept.

### D. How to make equality treat `null` and `undefined` the same

Sub-decision within the chosen design. Agency compiles `==` to strict `===`
today, so `x == null` would miss `undefined`. Three options:

- **D1 — syntactic null-literal rule:** compile `==`/`!=` to loose only when an
  operand is the literal `null`. Easy and type-free, but misses value-to-value
  comparisons where one side is a runtime `undefined` not written as the
  literal.
- **D2 — loose `==` everywhere + add operand type-checking:** make `==` loose
  globally and add a new rule that equality operands must be type-compatible (so
  JS coercion footguns like `5 == "5"` can't arise). Complete and type-free at
  codegen, and a genuine safety improvement — but a *large* change touching
  every comparison in the corpus, with its own migration.
- **D3 — runtime helper (chosen):** compile `==`/`===` to `__eq(a, b)` and
  `!=`/`!==` to `!__eq(a, b)`, where:

  ```ts
  export function __eq(a: unknown, b: unknown): boolean {
    return a === b || (a == null && b == null);
  }
  ```

We chose **D3**. It is type-independent at the comparison site (no inference
needed, so it works even when an operand's type is unknown or a union),
complete (handles value-to-value cases, not just the literal), and avoids JS's
cross-type coercion quirks entirely. Because operands are passed as arguments
they are **evaluated exactly once** — an inline `a === b || (a == null && b ==
null)` would double-evaluate side-effecting operands. D2 was rejected as too
large for this project; D1 was rejected for the value-to-value gap.

Why `__eq` is correct: `a == null` (loose) is true for exactly `null` and
`undefined` and nothing else (not `0`, `""`, `false`, `NaN`). So `(a == null &&
b == null)` means "both nullish," while `a === b` handles everything else
exactly. For any value `x`, `__eq(x, null) === __eq(x, undefined)`, and for two
non-nullish values `__eq` is identical to `===`. **All four equality operators
lower to `__eq`; there is no strict escape hatch.** A strict `===` would only let
you distinguish `null` from `undefined` — the exact distinction this project
removes — and would be a footgun (`x === null` silently missing an interop
`undefined`). `===`/`!==` remain parseable as stylistic aliases of `==`/`!=` but
compile identically.

## Consequences and how specific cases resolve

- **Unsetting an object key:** set it to `null`. There is no meaningful
  difference between "key absent" and "key = null." True key *removal* (so it
  disappears from `Object.keys`/`in`) is a separate operation Agency does not
  have and rarely needs, under the guiding rule **"check the value, not the
  key's presence."**
- **Default parameters are unaffected.** Agency detects "argument not passed"
  with a dedicated `__UNSET` sentinel (neither `null` nor `undefined`), so
  unifying the nothing-values does not change default-parameter behavior:
  `f()` applies the default; `f(null)` passes `null`.
- **TS interop returning `undefined`:** the type normalizes to `null`, and a
  null check catches the runtime `undefined` via `__eq`. The one observable
  sharp edge is passing an actually-`undefined` value *back* into TS code that
  strictly distinguishes `=== undefined` from `=== null` — rare, and a
  documentation note rather than a code path.
- **`schema({ foo?: string }).parse({})` → `{ foo: null }`.** The parse/
  validation schema accepts a missing optional key and coalesces it to `null`,
  giving a predictable shape where every declared key is present. (The LLM
  structured-output schema is separate and keeps optional keys as required +
  nullable, because OpenAI structured output requires every field to be
  `required`, with optionality expressible only as a union with null.)

## Relationship to null safety

Unifying the nothing-values is **Project 1**. It deliberately does *not* make
Agency null-*safe*: today the type checker lets you access a member on a
possibly-null value with no error (like TypeScript with `strictNullChecks`
off).

Strict null checking — forcing you to narrow a `T | null` before using it — is
**Project 2**, and it is where the real safety payoff lives. It rides on the
existing narrowing engine and roadmap: retarget `null-truthiness-narrowing-spec`
from `undefined` to `null`, and make `strictMemberAccess` treat a possibly-null
access as an error until narrowed. That combination gives Rust/`Option`-grade
safety on top of the clean one-value runtime model, without a nominal `Option`
type.

## Summary

Agency has one nothing-value, `null`, because: every from-scratch language chose
one (or zero); JS's two-value design is a regretted wart Agency is free to drop;
the `null`/`undefined` distinction is sound in theory but a practical source of
friction its users don't need; and `undefined` is unavoidable at the JS runtime
boundary, so the right move is to *absorb* it into `null` (one writable value,
equal at runtime, normalized in typed data) rather than to either keep both or
pretend `undefined` doesn't exist.
