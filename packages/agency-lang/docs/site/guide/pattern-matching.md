---
name: Destructuring and Pattern Matching
description: Reference for Agency's pattern language used in declarations, the `is` operator, `match` arms, and `for` loops, including array and object destructuring.
---

# Destructuring and Pattern Matching

Agency supports a small but expressive pattern language used in four
positions:

1. `let` / `const` declarations (binding only).
2. The `is` operator (boolean test, optionally with bindings inside an
   `if` / `while`).
3. `match` block arms (value matching with bindings).
4. `for` loop iteration variable.

Patterns are *syntactic sugar*: a lowering pass rewrites them into
ordinary Agency constructs (assignments, field accesses, conditions)
before the rest of the compiler runs.

## Destructuring in declarations

### Array destructuring

```agency
let items = [1, 2, 3, 4, 5]
let [a, b]            = items   // a = 1, b = 2
let [first, _, third] = items   // skip the second element
let [head, ...rest]   = items   // head = 1, rest = [2,3,4,5]
```

The rest binder must be the last element: `[a, ...m, b]` is rejected
at parse time.

### Object destructuring

```agency
let person = { name: "Bob", age: 30, city: "NY" }

let { name, age }              = person   // shorthand
let { name: n, age: ageRen }   = person   // rename
let { name, ...others }        = person   // others = { age: 30, city: "NY" }
let { coords: [x, y] }         = nested   // nested patterns
```

### Wildcards and rest

- `_` matches anything and binds nothing. Note that `_foo` is still a
  legal identifier.
- `...rest` collects the remaining elements (array) or properties
  (object).

## The `is` operator

`expr is pattern` is a boolean test. In a pure-boolean context (e.g. as
the right-hand side of an assignment) it returns `true` / `false`:

```agency
let isShow = step is { type: "showPolicy" }   // boolean
```

In an `if` or `while` condition, shorthand binders inside the pattern
introduce variables in the body:

```agency
if (step is { type: "showPolicy", policy }) {
    print(policy.name)   // policy is in scope here
}
```

Shorthand binders in pure-boolean contexts (assignment value, return,
function argument) are a compile error: there is nowhere for them to
bind. Use `if (x is …)` or `match(x is …)` instead.

## Match blocks

Match blocks already support literal arms. Now they also accept object
and array patterns, with binders that come into scope in the arm body:

```agency
match (event) {
    { type: "click",  x, y }   => handleClick(x, y)
    { type: "scroll", delta }  => handleScroll(delta)
    _                          => ignore()
}
```

A guard clause `if (…)` can be appended to any arm:

```agency
match (request) {
    { kind: "user", age } if (age >= 18) => allow()
    { kind: "user" }                     => block()
    _                                    => unknown()
}
```

### `match(expr is pattern)` form

When you want to destructure once and then dispatch on guards, write:

```agency
match (req is { user, role }) {
    role == "admin"  => grantAll(user)
    role == "editor" => grantEditing(user)
    _                => grantReadOnly(user)
}
```

The scrutinee is evaluated exactly once, the binders (`user`, `role`)
are extracted exactly once, and each arm's left-hand side is treated as
a boolean guard expression.

## Match expressions

`match` can be used as a statement (arms run for effect, as in every
example above) or as an **expression**, in exactly two positions:

- The right-hand side of an assignment: `const x = match(...) { ... }`.
- The operand of a `return`: `return match(...) { ... }`.

Anywhere else — a function argument, a binop operand, an object literal
field — is a parse error. Agency has no general subexpression-hoisting
pass, so these two capture sites are all v1 supports.

### Arm bodies: implicit yield vs. block

A single-expression arm yields its value implicitly:

```agency
const points = match(grade) {
    "A" => 100
    "B" => 80
    _   => 0
}
```

An arm can also be a **block** of statements. Block arms must yield via an
explicit `return`, on every code path:

```agency
const val = match(result) {
    success(v) => {
        print(v)
        return v * 2
    }
    failure(e) => e.message
}
```

A block arm that falls off the end without returning a value, or that
contains a bare `return` (no value), is a compile error. Loops never count
as yielding on all paths — a `return` inside a `for`/`while` loop that is
the arm's *only* return does not satisfy the check, since the loop might
not execute.

### `return` yields to the match, not the function

Inside a match arm, `return expr` produces the arm's value **for the
match** — it does not return from the enclosing function. This applies
even when the `return` is nested inside an `if`/`while`/`for` within the
arm; the arm is the nearest value scope. A nested match's arms yield to
that inner match.

To return from the enclosing function based on a match, put the match in
expression position and return it directly:

```agency
def classify(r: Result<number>): string {
    return match(r) {
        success(v) => "got ${v}"
        failure(e) => "err: ${e}"
    }
}
```

**This is a breaking change** from match's old statement-only behavior,
where `return` inside an arm exited the enclosing function. To make the
change loud instead of silently altering behavior, a `return` anywhere
inside a **statement-position** match arm is now a compile error:

```
`return` inside a match arm yields the match's value, but this match's
value is unused — did you mean `return match(...)`?
```

Migrate old code — where each arm used to end in a `return` that exited
the function — by hoisting a single `return` in front of the match
instead, so it returns the match's value:

```agency
return match(r) {
    success(v) => "got ${v}"
    failure(e) => "err"
}
```

Matches that mix function-exit arms with effect-only arms can't be
mechanically hoisted this way and need to be restructured by hand (e.g.
assign an optional result and return conditionally after the match).

### Yielding an object literal

`=> {` always begins a block — never an object literal — mirroring the
JS arrow-function rule. To yield an object literal from a
single-expression arm, parenthesize it, or use a block with an explicit
`return`:

```agency
kind => ({ label: kind })            // parenthesized object literal
kind => { return { label: kind } }   // block form
```

### Typing and exhaustiveness

In checked position (e.g. `const val: string = match(...) { ... }`), each
arm's yielded value is checked against the expected type. In synthesis
position, the match's type is the union of every arm's yielded type;
narrowing (Result patterns, object patterns, field-path narrowing) applies
inside block arms exactly as it does today.

**Exhaustiveness is a hard error in expression position**, regardless of
`typechecker.matchExhaustiveness` in `agency.json`. A match used as an
expression must produce a value, so `"silent"`/`"warn"` don't apply — a
match over a closed scrutinee type (Result, a closed literal/value union,
a discriminated object union, `boolean`) needs a `_` arm or full coverage.

For an *open* scrutinee type (e.g. a bare `string`), the checker cannot
enumerate every case, so it can't flag missing arms. If no arm matches at
runtime, the match expression yields `undefined` — add a `_` arm whenever
the scrutinee type is open.

### v1 restrictions

- **Expression position is limited to assignment RHS and `return`
  operands** (see above) — no generic expression-hoisting exists yet.
- **`match(x is pattern)` stays statement-only.** Its `is`-form lowering
  synthesizes a function-level `failure(...)` return on head mismatch,
  which has no coherent meaning as a match-expression value.
- **A `return` inside an arm cannot cross a concurrency boundary.** A
  `return` inside a `parallel`/`fork`/`race`/`thread` block nested in an
  arm is a compile error — those run in separate execution contexts that
  the match-yield unwind cannot cross.
- **Module-level `const x = match(...)` initializers are a compile
  error.** Module-level initializers are planned one expression per
  variable by the init-topsort machinery; a lowered match region is
  multiple statements. Use a `def` that returns the match and call it
  from the initializer instead.
- **A match-expression arm cannot yield a graph-node call.** A node call
  compiles to a control-flow transition (goto/halt), not a value; use an
  `if`/`else` chain for node dispatch instead of a match expression.

## Result patterns

The `success` and `failure` keywords work as patterns for ergonomic
Result type unwrapping.

### Boolean test

```agency
let worked = result is success
let failed = result is failure
```

### Binding in `if`/`while`

```agency
if (result is success(value)) {
    print(value)   // value is the unwrapped success value
}

if (result is failure(err)) {
    print(err)     // err is the error string
}
```

### In match blocks

```agency
match (result) {
    success(v) => print("Got: ${v}")
    failure(e) => print("Error: ${e}")
}
```

### Combined with `match(expr is pattern)` form

```agency
match (result is success(v)) {
    v > 0  => print("positive")
    _      => print("zero or negative")
}
```

### Nested inside other patterns

Result patterns may appear as nested elements inside array or object
match patterns:

```agency
match (pair) {
    [success(v), _] => print("first ok: ${v}")
    [failure(e), _] => print("first err: ${e}")
    _               => print("other")
}
```

The bound value (`v` above) is narrowed precisely — it has the success
value's type, so it can be used wherever that type is required (e.g. passed
to a function expecting a `number`), with no extra guard.

Note: `failure(e)` binds only the error string. For checkpoint,
functionName, or args, use the traditional `if (isFailure(result))`
form and access fields on the result variable directly.

## For loop destructuring

The iteration variable can be an array or object pattern:

```agency
for ([key, value] in entries) {
    print(key, value)
}

for ({ name, age } in users) {
    print(name, age)
}
```

## Failure semantics

Destructuring relies on the underlying JavaScript runtime: reading a
property of `null` or `undefined` (e.g. `let { name } = null`) throws a
`TypeError`, which Agency captures and surfaces as a `failure` Result.
At runtime, a match without a `_` arm that matches no other arm is a
no-op — no branch runs.

## Exhaustiveness checking

The type checker reports (by default, an **error**) when a `match` over a
*closed* type doesn't cover every case and has no `_` arm:

- a **Result** (`success` / `failure`),
- a **closed literal or value union** (`"a" | "b"`, `1 | 2`),
- a **discriminated object union** (`{ kind: "a" } | { kind: "b" }` — a common
  property typed as a distinct literal in each member),
- a bare **`boolean`** (`true` / `false`).

```agency
type Ev = { kind: "click", x: number } | { kind: "scroll", d: number }
match (e) {
    { kind: "click" } => handleClick(e)
    // error: match is not exhaustive: missing `{ kind: "scroll" }`
}
```

Adding the missing arm — or a `_` catch-all — clears it. A guarded arm
(`… if (…) => …`) never counts toward coverage. Open types (`string`,
`number`, arbitrary object unions) and the `match(x is …)` form are never
required to be exhaustive. Control the severity with
`typechecker.matchExhaustiveness` in `agency.json` (`"silent"` / `"warn"` /
`"error"`; default `"error"`).

## Narrowing on a field-path scrutinee

When the scrutinee is a stable field path like `e.effect`, each literal arm
narrows the path's receiver inside that arm — exactly as the equivalent
`if (e.effect == "...")` guard would. So a discriminated union's other fields
narrow too:

```agency
type Ev = { kind: "confirm", question: string }
        | { kind: "wait",    seconds: number }

match (ev.kind) {
    "confirm" => ask(ev.question)      // ev is the confirm member here
    "wait"    => sleep(ev.seconds)     // ev is the wait member here
}
```

This applies to a stable field-path scrutinee (`ev.kind`, `a.b.c`). A
bare-variable scrutinee (`match (x)`) does not narrow the variable itself, and an
object-pattern arm (`match (e) { { kind: "..." } => ... }`) does not narrow the
scrutinee inside the arm — use the field-path form or an `if` guard when you need
that narrowing.
