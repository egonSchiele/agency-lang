# Type Patterns: matching on the type of a value

## Background: what problem are we solving?

Agency programs constantly need to ask "what kind of thing is this value?" A
value might arrive as a string, a number, `null`, a plain object, or an array,
and the code has to branch on which one it got. This happens most often with
values whose type isn't pinned down: the result of an LLM call, a field that
could be missing, a `draft` that a partial-result function hands back, or
anything typed `any`.

Today you can ask a few narrow versions of that question — `null` is already a
pattern, so `draft is null` and a `null =>` match arm work — but for everything
past null you fall back to raw JavaScript-style checks, and they are genuinely
unpleasant to write and read. Here is a real example. It takes a `draft` that
might be `null`, a string, or an object, and turns it into a display string:

```ts
if (draft == null) {
  return ""
}
const asString = "${draft}"
if (asString == "[object Object]") {
  return JSON.stringify(draft)
}
return asString
```

That middle section is a trick, not a check. It converts the value to a string
and then looks for the magic text `"[object Object]"` to figure out "was this
actually an object?" A reader has to know that JavaScript stringifies plain
objects to that exact phrase. Nothing about the code says "I am checking whether
`draft` is an object." The intent is buried.

This is a small example of a large gap. Agency has a real type system —
primitives, object types, arrays, unions, named aliases with validation — but at
runtime you cannot ask a value "are you one of these types?" You can *declare* a
type, *validate* against a type with the bang operator, and *narrow* a union by
inspecting a discriminant field, but you cannot simply branch on "is this a
string" the way you branch on a value in a `match`.

This spec adds that ability. We call the new construct a **type pattern**: a
pattern that tests the runtime type of a value, and (like every other pattern in
Agency) narrows the value in the branch where the test succeeded.

## Background: what pattern matching Agency already has

Agency already has a rich pattern language, documented in
`packages/agency-lang/docs/site/guide/pattern-matching.md`. You can pattern match
in four places:

1. `let` / `const` declarations (binding only).
2. The `is` operator — a boolean test, optionally introducing bindings when used
   inside an `if` or `while`.
3. `match` block arms.
4. `for` loop iteration variables.

The patterns themselves are: literals (`"success"`, `100`), array patterns
(`[a, b]`, `[head, ...rest]`), object patterns (`{ name, age }`,
`{ type: "click", x, y }`), the wildcard `_`, and the Result patterns
`success(v)` / `failure(e)`. Object patterns already do double duty as a crude
form of type matching: `{ type: "showPolicy", policy }` both tests that the value
has a `type` field equal to `"showPolicy"` and narrows a discriminated union.

What is missing is the ability to say "match if this value is a *string*" or
"match if this value is a *Person*" — a test on the type itself rather than on a
specific field or literal value.

### The design is deliberately close to TC39

Agency's `is` operator and `match` block are modeled on the TC39 pattern matching
proposal (Stage 3 at time of writing). That proposal answers "how do I match on a
type?" with exactly this shape:

```js
x is String     // is it a string?
x is Number
x is MyClass    // brand check
```

The type name is used directly as a pattern. Swift spells the same idea
`case is String:`, and Scala spells the binding-plus-type form `case s: String =>`.
This spec adopts both spellings, using Agency's own lowercase type names rather
than JavaScript's capitalized wrapper classes, so that a type pattern reads
exactly like a type annotation the programmer already knows how to write.

## The feature

A **type pattern** tests the runtime type of a value. It has two spellings, and
they are two views of the same underlying test.

### Spelling 1: `is Type` (the test form)

Use `is Type` anywhere you already use the `is` operator — as an `if` or `while`
condition, or as a boolean expression. It answers a yes/no question and narrows
the value in the branch where it is true.

The opening example becomes:

```ts
if (draft is null)   { return "" }
if (draft is string) { return draft }
return JSON.stringify(draft)
```

Every line now says what it means. There is no stringify trick and no magic
phrase. (The first line already works today, because `null` is a literal
pattern; `draft is string` is the new part.) After `draft is string` succeeds,
`draft` is narrowed to `string` inside that branch, so `return draft`
typechecks.

As a plain boolean it works the same way the existing `is` does:

```ts
const looksLikeText = value is string   // boolean
```

### How `is Type` coexists with binder patterns

There is a collision to resolve here, and it deserves its own section because
it changes an existing construct. A bare identifier is a valid pattern today:
`if (x is y)` parses as an always-true test that binds a new variable `y` to
the value of `x`, and `y => ...` in a match arm is a catch-all that binds the
scrutinee. So `x is Person` already means something — "bind `Person`" — and
none of the primitive type names are reserved words. Without a rule, the parser
cannot tell a binder from a type name, and any rule that consults the symbol
table to decide risks spooky action at a distance: adding `type s = ...` to a
module would silently change what `x is s` means somewhere else.

The rule we adopt: **grammar position decides binder-vs-type; name resolution
never changes the meaning of a working program.** Concretely:

1. **After `is`, a top-level bare identifier is always a type reference.** The
   always-true binder form is retired. It was always expressible as
   `const y = x`, and a search across the tests, stdlib, and examples found
   zero uses — every textual hit was English prose in comments. The identifier
   resolves against the type namespace: primitive names always resolve, alias
   names resolve through the symbol table. A name that is not a type is a
   compile error with a pointed message: `` `foo` is not a type; to bind the
   value write `const foo = x` ``. Nested patterns are untouched —
   `x is {name, age}` keeps its binders, because the ambiguity only ever
   existed at the top level of the right-hand side. `success` / `failure`
   remain intercepted as Result patterns before any of this applies.
2. **The arm-level `: Type` suffix always parses its right side with the type
   grammar.** It is new syntax, so there is nothing to disambiguate. A
   non-type name there gets the same compile error as rule 1.
3. **Bare-identifier match arms stay binders.** The binding catch-all
   (`other => f(other)`) is genuinely useful, unlike the `is` binder. The
   confusion hazard — `Person =>` binds anything while `p: Person =>` tests —
   is closed by a checker warning: when a bare arm binder's name matches an
   in-scope type, warn and suggest `p: Person` or `is Person`.

This gives the safety property we want: scope changes can only turn a compile
error into working code (a name that starts resolving as a type), never
silently change what a working program does. The one theoretical exception is
pre-existing code that wrote `if (x is y)` where `y` is *also* an in-scope
type — that would silently become a runtime test instead of erroring. Given
the binder form has zero observed usage at all, we accept this.

One back-compat direction is already safe: in pure-boolean contexts
(`const b = x is y`), the bare binder is a compile error today ("has nowhere
to bind"), so `value is string` there goes from error to working — no break.

### Spelling 2: `pattern: Type` (the bind-and-test form)

Use `pattern: Type` inside a `match` arm when you want to destructure or bind the
value *and* test its type in one move. The left side is any pattern Agency
already supports — a binding, an object pattern, an array pattern, or `_`. The
`: Type` suffix adds the type test and the narrowing. The type after the colon
is anything the type grammar can spell in one piece: a primitive, a named
alias, a typed array, or an inline object type
(`person: {name: string, age: number} => ...` works and tests the structural
shape) — everything except a bare inline union (see Tier 2).

```ts
match (input) {
  null                 => ""
  s: string            => s
  {name, age}: Person  => "${name}, ${age}"
  [x, y]: number[]     => x + y
  _                    => JSON.stringify(input)
}
```

Read the arms top to bottom:

- `null` — the existing literal pattern; matches when `input` is `null`.
- `s: string` — matches when `input` is a string, binding it to `s`.
- `{name, age}: Person` — matches when `input` is a valid `Person`, and
  destructures `name` and `age` out of it.
- `[x, y]: number[]` — matches when `input` is an array of numbers with (at
  least) two elements, binding the first two.
- `_` — the catch-all.

`is Type` is also allowed as an arm — it is exactly the no-binding case of
`pattern: Type`, and `is` is the natural "just test it" word everywhere else in
the language (`is boolean => ...` reads better than `_: boolean => ...`). Note
that for null specifically this makes three equivalent spellings (`null`,
`is null`, `_: null`); the literal `null` arm already exists and stays the
idiomatic one, which is why the example above uses it.

### Guards compose as usual

A type-pattern arm can carry a guard, just like any other arm:

```ts
match (u) {
  p: Person if (p.age > 100) => "centenarian"
  p: Person                  => "adult"
  _                          => "not a person"
}
```

## What you can match on, and how the check runs

Type patterns split into two tiers by the kind of type on the right. The syntax
is identical; only the generated runtime check differs.

### Tier 1: coarse runtime types (cheap checks)

These are the broad "what shape of thing is this" categories. They compile to
direct JavaScript checks with no schema involved.

| Type in the pattern | Runtime check                                   |
|---------------------|-------------------------------------------------|
| `string`            | `typeof x === "string"`                         |
| `number`            | `typeof x === "number"`                         |
| `boolean`           | `typeof x === "boolean"`                        |
| `null`              | `x === null`                                    |
| `object`            | non-null, non-array `typeof x === "object"`     |
| `any[]`             | `Array.isArray(x)`                              |

`object` means "any non-null, non-array object" — which is the distinction the
opening example needed, and matches the meaning the built-in `object` type
already has (every object type is assignable to it; its schema is an
any-record). Note what that includes: class instances such as a `Date` or
`Map` arriving through JS interop count as `object` (they are objects to
`typeof`), so `is object` is not a "JSON-serializable plain object" test. For
that common question the stdlib ships a `Json` type whose `@validate`
validator is a precise round-trip check (plain objects, arrays, finite
numbers, strings, booleans, null — rejecting class instances, functions,
NaN/Infinity, and cycles): `x is Json` runs the full walk through the normal
Tier 2 path, and is the flagship example of the validator unification this
feature is built on. If you need a specific shape, test the shape
(`{name}: Person`). `any[]`
is the coarse "is it any array" check; there is no new `array` keyword,
because `any[]` already expresses it using the existing array-suffix grammar.

Two JavaScript realities carry through deliberately, and the guide should say
so: `NaN` is a number (`typeof NaN === "number"`), so `NaN is number` is true;
and the `null` check is loose — it matches `undefined` too, for consistency
with the existing literal `null` pattern (which lowers to `== null`) and with
the runtime's existing undefined-to-null normalization. An interop-produced
`undefined` therefore matches `null` patterns and `_`, and nothing else.

These six checks are all it takes to solve the original `draft` problem and the
large majority of "what kind of value did I get" branching.

### Tier 2: named and structural types (reuse validation)

When the type on the right is a named alias (`Person`), a typed array
(`number[]`), or any type with a shape or custom validation, the type pattern
reuses machinery Agency already has: the runtime schema. Unions are Tier 2 too,
but in v1 they must arrive through a named alias
(`type Id = string | number` then `x is Id`) — an inline union in pattern
position (`x is string | number`) is not spellable, which sidesteps the
precedence questions `|` would raise inside an expression.

`x is Person` succeeds exactly when `schema(Person).parse(x)` succeeds. That means
the check verifies:

1. **Shape** — `x` has the right keys with the right types.
2. **Custom validation** — any `@validate` validators attached to the type (or to
   its fields, or to aliases it is built from) pass.

This is the unification the feature is built around. "Is this value a Person?" and
"validate this value against Person" become the same question, answered by the
same code. There is no separate structural-walker to write and maintain; the
type pattern calls into the Zod schema the compiler already generates for every
type.

A consequence worth stating plainly: a value with the right *shape* but failing a
*validator* does **not** match. Given

```ts
type Person = {
  name: string,
  @validate(isAdult) age: number,
}

match (u) {
  p: Person => greet(p)
  _         => reject(u)
}
```

a `u` of `{ name: "Kid", age: 12 }` has the right shape but fails `isAdult`, so it
falls through to `reject(u)`. This is intended: the type pattern respects the
full meaning of the type, validators included.

Built-in generics (`Record<...>`, `Partial<...>`, `Pick<...>`, and friends)
work when applied to concrete arguments: they resolve to plain types before
the schema is built, so a type pattern gets exactly the bang's behavior for
them — including, for now, the bang's known hole: `@validate` tags are
silently dropped inside `Record`/`Array`/`Schema`
([#630](https://github.com/egonSchiele/agency-lang/issues/630)), so
`x is Record<string, Age>` is shape-only until that is fixed. A bare type
*parameter* is different: `x is T` where `T` is a generic parameter has no
runtime schema (the type is erased) and is a compile error.

Names that are JavaScript classes but not Agency types (`Date`, `Map`,
`RegExp`, ...) are compile errors like any other unknown type name, with a
tailored message: type patterns only test Agency types, so there is never a
question of whether a given name means a schema check or an `instanceof`
check. Use `is object` or a helper function for JS natives.

There is a cost to state plainly, too. A `match` with several Tier 2 arms runs
a full schema parse — the deep structural walk plus every attached validator —
per arm, in order, until one matches. Validators are ordinary Agency functions,
so a *non-matching* arm's test can run user code. This is the same cost profile
the bang already has, and we accept it; but if a validator is expensive or has
side effects, putting its type in a many-armed `match` multiplies that cost,
and users should know that.

## Two semantic rules that need to be explicit

### Rule 1: `is` never mutates. It binds the original value.

`@validate` validators can do two things: reject a value, or *transform* it (the
guide's example clamps a negative age to `1`). Because `schema(Person).parse`
runs those validators, it can hand back a transformed copy. A type pattern
ignores that transformed copy for binding purposes.

When `p: Person` matches, `p` is bound to the **original** `u`, narrowed to
`Person`. The validators are consulted only to decide *whether* the arm matches,
never to rewrite the value you get. A test-shaped construct that silently
rewrote its subject would be a trap.

If you actually want the validated-and-transformed value, that is what the bang
operator is for: `const p: Person! = u` gives you a `Result` carrying the
transformed value. The two constructs stay cleanly separated — `is`/type-patterns
*test and narrow*, `!` *validates and transforms*.

This rule has a hole, and we choose to document it rather than close it. A
*transforming* validator counts as a pass: the guide's clamp example turns
`age: -5` into `success(1)`, so `{ name: "Alice", age: -5 }` **matches**
`p: Person` — and `p` is bound to the original, with `age` still `-5`,
statically typed `Person`. The arm now holds a value the type's own validator
would have rewritten. If your validators repair values rather than merely
accept or reject them, a type pattern tells you "this is repairable," not
"this is already valid" — reach for the bang when that difference matters.

We considered closing the hole by matching only when the parse output equals
the input (transform was the identity), but rejected it: Agency's generated
object schemas strip unknown keys, so a structurally valid value with an extra
field would have parse output ≠ input and wrongly fail the test. A structural
type test must accept extra fields, so identity-comparison is not a viable
match criterion.

### Rule 2: type patterns live in exactly two places

Type patterns appear only in:

1. `is Type` — in `if` / `while` conditions and boolean contexts.
2. `pattern: Type` — in `match` arms.

They are deliberately **not** allowed in `let` / `const` / `for` declarations.
The reason is that `const {name}: Person = obj` already has a meaning there: it is
a static type *annotation*, not a runtime *test*. If `: Type` in a declaration
suddenly ran a runtime validation, we would silently change what every annotated
declaration means. Runtime validation in a declaration remains the bang's job:
`const p: Person! = obj`.

So the mental split is:

- Declaration + `: Type` → static annotation (unchanged, no runtime check).
- Declaration + `: Type!` → runtime validation via bang (unchanged).
- `match` arm + `pattern: Type` → runtime type pattern (new).
- `is Type` → runtime type pattern (new).

## Type checker behavior

### Narrowing

After a type pattern succeeds, the value narrows to the tested type in that
branch. This extends the flow-sensitive narrowing the checker already performs
for the `is` operator and for object-pattern discriminants.

```ts
if (x is number) {
  // x : number here
  return x + 1
}
```

```ts
match (input) {
  s: string => s.length   // s : string
  n: number => n + 1      // n : number
  _         => 0
}
```

For a Tier 2 type, the narrowed type is the named type itself: after
`{name, age}: Person` matches, the value (and the destructured fields) have their
`Person` types.

Narrowing is **positive-only in v1**: the value narrows in the branch where the
test succeeded, and nowhere else. After `if (x is string) { return x }`, `x` is
*not* narrowed to exclude `string` in the code that follows, and a later match
arm is not narrowed by the failure of earlier type-pattern arms. (`is null` is
the one exception, and only by inheritance: it parses as the existing literal
null pattern, which lowers to `x == null` — a form the checker already narrows
in *both* branches. That existing behavior is unchanged.) Negative
narrowing is a possible future refinement (it needs care anyway, since a
Tier 2 test can fail on a validator rather than on the type). None of the
examples in this spec depend on it.

### Exhaustiveness

Type-pattern arms do **not** count toward the exhaustiveness check. A `match` that
branches on type patterns still requires a `_` arm to be considered exhaustive.

The reason is Rule 1's flip side: a named-type arm can *fail* even when the static
type claims the value matches, because a validator can reject it. So the checker
cannot prove that a set of type-pattern arms covers every case, even when the
static types look complete. Treating them as non-contributing is the safe choice,
and it matches the existing guidance in the pattern-matching guide: whenever the
scrutinee is an open type, add a `_` arm.

(A future refinement could prove exhaustiveness for a closed union covered
entirely by *coarse* Tier 1 patterns — e.g. `string | number` fully covered by
`is string` and `is number`, which cannot fail. That is explicitly out of scope
for v1.)

### Bindings in pure-boolean contexts stay an error

The existing rule that shorthand binders are illegal in pure-boolean contexts is
unchanged. `const b = x is string` is fine (no binder). The bind form
`pattern: Type` is only meaningful in a `match` arm, where bindings are always
allowed.

## Worked examples

The opening example, rewritten end to end:

```ts
def render(draft: any): string {
  match (draft) {
    null      => ""
    s: string => s
    _         => JSON.stringify(draft)
  }
}
```

Distinguishing several shapes an LLM might return:

```ts
def describe(value: any): string {
  match (value) {
    null               => "nothing"
    s: string          => "text: ${s}"
    n: number          => "number: ${n}"
    is boolean         => "a flag"
    is any[]           => "a list"
    {name}: Person     => "person ${name}"
    is object          => "some object"
    _                  => "unknown"
  }
}
```

The `is` operator in a plain condition:

```ts
def toText(v: any): string {
  if (v is string) {
    return v
  }
  if (v is number) {
    return "${v}"
  }
  return JSON.stringify(v)
}
```

## What is explicitly out of scope for v1

- **Type patterns in `let` / `const` / `for`.** Reserved so annotations keep their
  meaning. Use the bang for runtime validation in declarations.
- **Exhaustiveness credit for type-pattern arms.** Always require `_`.
- **A dedicated `array` keyword.** Use `any[]` (coarse) or `T[]` (validated).
- **Binding the transformed/validated value from a type pattern.** Use `Type!`.
- **Negative narrowing.** A failed type test does not narrow the other branch.
- **Inline union types in pattern position.** `x is string | number` is not
  spellable; use a named alias.
- **`keyof` and indexed-access types in pattern position.** Not blocked (the
  type grammar parses them and they resolve like anywhere else) but not
  specified or tested — behavior follows whatever `schema(T)` does for the
  resolved type.
- **Testing JS-native classes (`Date`, `Map`, ...).** Compile error with a
  tailored message; no `instanceof` semantics in the pattern namespace.

## Open questions for the plan stage

These are implementation-level and do not change the surface design, but the plan
should resolve them:

1. **Where the parser slots the `: Type` suffix.** Match-arm patterns currently
   dispatch on the leading token. The `pattern: Type` form needs the pattern
   parser to optionally consume a trailing `: Type` without colliding with object
   pattern syntax (`{ type: "x" }` uses `:` inside braces). Confirm the arm-level
   `:` is unambiguous.
2. **Where binder-vs-type resolution runs.** The design rule is fixed (see "How
   `is Type` coexists with binder patterns"): after `is`, a top-level bare
   identifier is a type reference. The plan must decide *where* that resolution
   happens — the parser can emit a single "name in type position" node and let
   the preprocessor or checker resolve it against the symbol table, since the
   parser alone cannot know the in-scope aliases.
3. **How Tier 2 reaches the schema at runtime.** Mostly pre-answered:
   `schema(T)` is already a user-facing function that works on arbitrary
   in-scope aliases, so the generated check can emit `schema(T)` and lean on
   the existing schema machinery. Confirm nothing breaks when the pattern
   compiles inside nested scopes.
4. **Interaction with Result patterns.** `success` / `failure` are already
   pattern keywords and stay intercepted before bare-identifier handling.
   Confirm `is Type` and `success`/`failure` do not collide and that a value
   can be tested for both in sequence.
5. **Async validators.** `@validate` validators are Agency functions. Confirm
   whether the schema parse can be async at the point a type pattern compiles;
   if it can, the compiled form of `if (x is Person)` and of match-arm tests
   must await, which shapes the generated code.
