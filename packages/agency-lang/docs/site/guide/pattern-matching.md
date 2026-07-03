---
name: Destructuring and Pattern Matching
description: Reference for Agency's pattern language used in declarations, the `is` operator, `match` arms, and `for` loops, including array and object destructuring.
---

# Destructuring and Pattern Matching

There are four places in Agency you can pattern match:

1. `let` / `const` declarations (binding only).
2. The `is` operator (boolean test, optionally with bindings inside an
   `if` / `while`).
3. `match` block arms (value matching with bindings).
4. `for` loop iteration variable.

## Destructuring in declarations

### Array destructuring

```ts
const items = [1, 2, 3, 4, 5]
const [a, b]            = items   // a = 1, b = 2
const [first, _, third] = items   // skip the second element
const [head, ...rest]   = items   // head = 1, rest = [2,3,4,5]
```

The rest binder must be the last element. You can't have `[a, ...m, b]` for example.

### Object destructuring

```ts
const person = { name: "Bob", age: 30, city: "NY" }

const { name, age }            = person // shorthand
const { name: n, age: ageRen } = person // rename
const { name, ...others }      = person // others = { age: 30, city: "NY" }
const { coords: [x, y] }       = nested // nested patterns
```

### Wildcards and rest

- `_` matches anything and binds nothing. Note that `_foo` is still a
  legal identifier.
- `...rest` collects the remaining elements (array) or properties
  (object).

## The `is` operator

`expr is pattern` is a boolean test. In a pure-boolean context (e.g. as
the right-hand side of an assignment) it returns `true` / `false`:

```ts
const isShow = step is { type: "showPolicy" }   // boolean
```

In an `if` or `while` condition, shorthand binders inside the pattern
introduce variables in the body:

```ts
if (step is { type: "showPolicy", policy }) {
    print(policy.name)   // policy is in scope here
}
```

Shorthand binders in pure-boolean contexts (assignment value, return,
function argument) are a compile error. Example:

```ts
const step = {
  type: "showPolicy",
  policy: "privacy"
}

// allowed
const isShow1 = step is { type: "showPolicy" }
const isShow2 = step is { type: "showPolicy", policy: _ }
const isShow3 = step is { type: "showPolicy", policy: "privacy" }

// not allowed
const isShow4 = step is { type: "showPolicy", policy }
```

In that last one, it looks like you are trying to create a new policy variable, which is not allowed. If you don't care what the value of the `policy` field is, just don't include it.

## Match blocks

Match blocks support literal arms:

```ts
const status: "success" | "failure" | "pending" = getStatus()
match (status) {
    "success" => print("Yay!")
    "failure" => print("Boo!")
    "pending" => print("Waiting…")
}
```

They also accept object and array patterns:

```ts
match (event) {
    // you can now use the `x` and `y` variables in the arm body
    { type: "click",  x, y }   => handleClick(x, y)
    { type: "scroll", delta }  => handleScroll(delta)
    _                          => ignore()
}
```

A guard clause `if (…)` can be appended to any arm:

```ts
match (request) {
    { kind: "user", age } if (age >= 18) => allow()
    { kind: "user" }                     => block()
    _                                    => unknown()
}
```

### `match(expr is pattern)` form

When you want to destructure once and then dispatch on guards, write:

```ts
match (req is { user, role }) {
    role == "admin"  => grantAll(user)
    role == "editor" => grantEditing(user)
    _                => grantReadOnly(user)
}
```

## Match expressions

You can also assign the result of a match to a variable, or return it from a function. This is called a **match expression**.

### Implicit returns

A single-expression arm returns its value implicitly:

```ts
const points = match(grade) {
    "A" => 100
    "B" => 80
    _   => 0
}
```

An arm can also be a **block** of statements. Block arms must explicitly return a value:

```ts
const val = match(result) {
    success(v) => {
        print(v)
        return v * 2
    }
    failure(e) => e.message
}
```

When you assign a match to a variable, every arm must return a value, and you can't have a bare return (`return` without a value).

### `return` returns from the match, not the function

Inside a match arm, `return expr` returns from the match, not from the enclosing function. If you want to return from the function, put `return` in front of the match expression instead:

```ts
def classify(r: Result<number>): string {
    return match(r) {
        success(v) => "got ${v}"
        failure(e) => "err: ${e}"
    }
}
```

### Returning an object literal

Just like in JavaScript, if you want to implicitly return an object literal from a single-expression arm, you need to wrap it in parentheses. 

```ts
kind => ({ label: kind })
```

Or just use the block form, which doesn't require parentheses:

```ts
kind => { return { label: kind } }
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
  `return` inside a `parallel`/`seq`/`fork`/`race`/`thread` block nested in an
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
- **A `match` expression cannot appear inside a `with` handler body.** A
  `const x = match(...)` or `return match(...)` inside a handler (the
  `with (data) { ... }` block) is a compile error, because a handler body
  compiles without an owning frame to unwind the match into — the match
  exit would escape the handler and silently skip the rest of the node.
  The guarded `handle { ... }` body is unaffected.

## Result patterns

The `success` and `failure` keywords work as patterns for ergonomic
Result type unwrapping.

### Boolean test

```ts
const worked = result is success
const failed = result is failure
```

### Binding in `if`/`while`

```ts
if (result is success(value)) {
    print(value)   // value is the unwrapped success value
}

if (result is failure(err)) {
    print(err)     // err is the error string
}
```

### In match blocks

```ts
match (result) {
    success(v) => print("Got: ${v}")
    failure(e) => print("Error: ${e}")
}
```

### Combined with `match(expr is pattern)` form

```ts
match (result is success(v)) {
    v > 0  => print("positive")
    _      => print("zero or negative")
}
```

### Nested inside other patterns

Result patterns may appear as nested elements inside array or object
match patterns:

```ts
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

```ts
for ([key, value] in entries) {
    print(key, value)
}

for ({ name, age } in users) {
    print(name, age)
}
```

## Failure semantics

Destructuring relies on the underlying JavaScript runtime: reading a
property of `null` or `undefined` (e.g. `const { name } = null`) throws a
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

```ts
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

```ts
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
