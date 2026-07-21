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

### What type does a match expression have?

There are two cases, depending on whether you tell Agency the type up front.

**You annotated the variable.** Every arm has to produce that type. If an
arm produces something else, that's an error:

```ts
const label: string = match(grade) {
    "A" => "top"
    "B" => "good"
    _   => 0        // error: expected string, got number
}
```

**You didn't annotate the variable.** Agency figures out the type for you:
it's the union of whatever the arms produce. Here `size` is a `string`:

```ts
const size = match(n) {
    100 => "big"
    _   => "small"
}
```

### A match expression must always produce a value

When you use `match` as an expression, it has to hand back a value. That
means **every case has to be covered** — otherwise there'd be a path where
the match produces nothing.

```ts
type Shape = { kind: "circle", r: number }
           | { kind: "square", side: number }

// error: not exhaustive, missing `{ kind: "square" }`
const area = match(shape) {
    { kind: "circle", r } => 3.14 * r * r
}
```

To fix it, cover every case or add a `_` catch-all:

```ts
const area = match(shape) {
    { kind: "circle", r }    => 3.14 * r * r
    { kind: "square", side } => side * side
}
```

This is an exhaustiveness check.

### Open types: always add a `_` arm

Agency can do an exhaustiveness check whenever the scrutinee (the thing being matched) has a **closed** type, like a `Result`, a literal union like `"a" | "b"`, a `boolean`.

Some types are **open** — a bare `string` or `number`, for example. Agency
can't list every possible string, so it can't tell you when you've missed
one. That means it won't warn you, but at runtime a value that matches no
arm makes the whole match produce `undefined`:

```ts
const greeting = match(name) {   // name is a plain string
    "Ada"  => "Hi Ada!"
    "Alan" => "Hi Alan!"
}
// greeting is undefined if name is "Grace"
```

So whenever the scrutinee is an open type, add a `_` arm to be safe:

```ts
const greeting = match(name) {
    "Ada"  => "Hi Ada!"
    "Alan" => "Hi Alan!"
    _      => "Hello!"
}
```

### v1 restrictions

Here are the places you can't use match blocks right now:

- Inside `parallel`, `seq`, `thread`, and `subthread` blocks.

You can't use `goto` with match blocks:

```ts
// not allowed
goto match(x) {
  "next" => next
  _ => end
}
```

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

## Type patterns

A **type pattern** tests the runtime type of a value. It answers questions
like "is this a string?" or "is this a valid `Person`?" directly, where you
previously needed JavaScript-style tricks. There are two spellings.

### `is Type`: the test form

Use a type after `is` anywhere the `is` operator works — in `if` / `while`
conditions or as a plain boolean:

```ts
def render(draft: any): string {
  if (draft is null)   { return "" }
  if (draft is string) { return draft }
  return JSON.stringify(draft)
}

const looksLikeText = value is string   // boolean
```

After a successful test the value narrows: inside the `draft is string`
branch, `draft` has type `string`.

Important behavior change: a bare identifier after `is` is **always a type
reference** now. The old always-true binder form (`x is y` binding `y`) was
retired — a name that is not a type is a compile error (AG1013) telling you
to write `const y = x` if you meant to bind.

### `pattern: Type`: the bind-and-test form (match arms)

In a match arm, add `: Type` after a pattern to test the type and
destructure in one move. `is Type` also works as an arm for a test with no
binding:

```ts
return match (input) {
  null                 => ""
  s: string            => s
  {name, age}: Person  => "${name}, ${age}"
  [x, y]: number[]     => "pair"
  is boolean           => "flag"
  _                    => JSON.stringify(input)
}
```

The suffix works on binders, object patterns, array patterns, and inline
object types (`p: {tag: string} => ...`). It is match-arm only: in `let` /
`const` declarations, `: Type` stays a static annotation with no runtime
check (use the bang, `Person!`, for validated declarations).

### What a test checks

Coarse types compile to cheap JavaScript checks: `string`, `number`,
`boolean`, `null`, `object` (any non-null, non-array object — a `Date` from
JS interop counts), and `any[]` (any array). Notes: `NaN is number` is true
(`typeof` semantics), and the `null` check is loose — it matches an
interop-produced `undefined` too, agreeing with the literal `null` pattern.

Every other type — named aliases, typed arrays like `number[]`, inline
object types — validates against the type's schema, **including its
`@validate` validators**. `x is Person` succeeds exactly when `x` would pass
`Person` validation:

```ts
type Person = {
  name: string,
  @validate(isAdult) age: number,
}

match (u) {
  p: Person => greet(p)   // shape AND isAdult must pass
  _         => reject(u)
}
```

Two rules to know:

1. **The pattern binds the original value.** Validators decide *whether* the
   arm matches, never rewrite what you get. A validator that repairs values
   (say, clamping a negative age) counts as a pass, and the bound value is
   still the un-repaired original — so a type pattern tells you "this is
   repairable", not "this is already valid". When that difference matters,
   use the bang: `const p: Person! = u` gives you the transformed value.
2. **Type-pattern arms never satisfy exhaustiveness.** A match using them
   still needs a `_` arm, because a validator can reject a value whose
   static type looks right.

Narrowing is positive-only: the value narrows where the test succeeded, and
nowhere else (no else-branch narrowing). `object` narrows to the opaque
`object` type — you can stringify or pass it along, but reading fields needs
a shape test instead.

### Checking for JSON

`is object` is deliberately coarse. To ask "is this a plain JSON-serializable
tree?" use the stdlib `Json` type — its validator is a precise round-trip
check (plain objects, arrays, strings, finite numbers, booleans, null;
rejects class instances like `Date`, functions, `NaN`, and cycles):

```ts
if (x is Json) {
  save(JSON.stringify(x))
}
```

### JavaScript classes are not testable

`x is Date` is a compile error: `Date`, `Map`, and friends are JavaScript
classes, not Agency types, and type patterns never mean `instanceof`. Use
`is object`, a shape test, or a helper function.

### One footgun

Inside an object *pattern*, `{name: string}` does not test that `name` is a
string — it binds the field to a new variable called `string` (pattern
semantics predating type patterns). The checker warns (AG5004) when a binder
name shadows a type; test the whole value instead: `p: Person =>` or
`p: {name: string} =>` (the colon *after the closing brace* is the type
position).
