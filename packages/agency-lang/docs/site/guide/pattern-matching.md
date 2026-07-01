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

The type checker reports (by default, a **warning**) when a `match` over a
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
    // warning: match is not exhaustive: missing `{ kind: "scroll" }`
}
```

Adding the missing arm — or a `_` catch-all — clears it. A guarded arm
(`… if (…) => …`) never counts toward coverage. Open types (`string`,
`number`, arbitrary object unions) and the `match(x is …)` form are never
required to be exhaustive. Control the severity with
`typechecker.matchExhaustiveness` in `agency.json` (`"silent"` / `"warn"` /
`"error"`; default `"warn"`).
