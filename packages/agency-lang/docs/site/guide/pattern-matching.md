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
No exhaustiveness check is performed on match blocks — a match without
a `_` arm that matches no other arm silently does nothing.
