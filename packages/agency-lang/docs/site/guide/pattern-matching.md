---
name: Destructuring and Pattern Matching
description: Reference for Agency's pattern language used in declarations, the `is` operator, `match` arms, and `for` loops, including array and object destructuring.
---

# Destructuring and Pattern Matching

## Destructuring in declarations

### Array destructuring

```ts
const items = [1, 2, 3, 4, 5]
const [a, b]              = items // a = 1, b = 2
const [first, _, third]   = items // skip the second element
const [head, ...rest]     = items // head = 1, rest = [2,3,4,5]
const [head, ...mid, end] = items // head = 1, mid = [2,3,4], end = 5
```

### Object destructuring

```ts
const person = { name: "Bob", age: 30, city: "NY" }

const { name, age }            = person // shorthand
const { name as n, age as a2 } = person // rename
const { name, ...others }      = person // others = { age: 30, city: "NY" }
const { coords: [x, y] }       = nested // nested patterns
```

### Wildcards and rest

`_` matches anything and binds nothing:

```ts
const [a, _, c] = [1, 2, 3] // a = 1, c = 3
```

`...rest` collects the remaining elements (array) or properties (object):

```ts
const [head, ...tail] = [1, 2, 3] // head = 1, tail = [2, 3]
const { name, ...others } = { name: "Alice", age: 25, city: "LA" } // others = { age: 25, city: "LA" }
```

A rest binder (`...rest`) can sit anywhere, even in the middle:

```ts
// first = 1, middle = [2, 3, 4], last = 5
const [first, ...middle, last] = [1, 2, 3, 4, 5]
```

There can be at most one rest binder in a pattern.

Rest binders match zero or more elements, so they can be empty:

```ts
// first = 1, rest = []
const [first, ...rest] = [1]

// first = 1, middle = [], last = 2
const [first, ...middle, last] = [1, 2]
```

### Extra params/not enough params

Arrays:

```ts
const arr = [0, 1, 2]

// w = 0, x = 1
const [w, x] = arr

// w = 0, x = 1, y = 2
const [w, x, y] = arr

// w = 0, x = 1, y = 2, z = null
const [w, x, y, z] = arr
```

Objects:

```ts
const person: Person = {
  name: "Alice",
  age: 50
}
// name = "Alice"
const { name } = person

// name = "Alice", age = 50
const { name, age } = person

// type error
const { name, asdasd } = person
```

### For loop destructuring

The iteration variable can be an array or object pattern:

```ts
for ([key, value] in entries) {
    print(key, value)
}

for ({ name, age } in users) {
    print(name, age)
}
```

## Renaming a field

To bind a field to a different name, use `as`:

```ts
// without rename
const { name, age } = person

// with rename
const { name as newName, age as newAge } = person
```

## The `is` operator

`expr is pattern` is a boolean test. It returns `true` / `false`:

```ts
const step = {
  type: "showPolicy",
  policy: "privacy"
}
const isShow = step is { type: "showPolicy" }
```

In an `if` or `while` condition, you can use `is` to introduce variables in the body:

```ts
if (step is { type: "showPolicy", policy }) {
    // new `policy` variable is available here
    print(policy.name)
}
```

These are called **binders**. A binder is a variable that you create from a pattern. A binder can contain a destructured value, like an array or object. For example:

```ts
if (step is { type: "showPolicy", policy: { name, version } }) {
    // new `name` and `version` variables are available here
    print(name, version)
}
```

You can create binders in `match` arms and `for` loops too. You *cannot* create binders in a `let` or `const` declaration, because those are not runtime tests. For example:

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

In that last one, it looks like you are trying to create a new `policy` variable, which is not allowed. If you don't care what the value of the `policy` field is, just don't include it, or use `policy: _` to explicitly ignore it.

## Pattern matching in match expressions

We covered match expressions in the [section on match expressions](/guide/match-expressions). Match expressions offer powerful pattern matching support. You can use patterns in `match` arms to destructure values:

Objects:
```ts
match (event) {
    // you can now use the `x` and `y` variables in the arm body
    { type: "click",  x, y }   => handleClick(x, y)
    { type: "scroll", delta }  => handleScroll(delta)
    _                          => ignore()
}
```

Arrays:
```ts
match (words) {
    ["echo", str] => print(str)
    ["echo", n]   => print("number: ${n}")
    _             => unknown()
}
```

Here is one subtlety with pattern matching on arrays in a match arm. When destructuring an array, you can pass in too many or too few variables, and that is fine:

```ts
const arr = [0, 1, 2]

// all of these work
const [w, x] = arr
const [w, x, y] = arr
const [w, x, y, z] = arr
```

But in a match arm, the pattern must match the array exactly. If the array has more or fewer elements than the pattern, it will not match:

```ts
const arr = [0, 1, 2]
match(arr) {
  [w, x] => print("Array has two elements")
  [w, x, y] => print("Array has three elements")
  [w, x, y, z] => print("Array has four elements")
  _ => print("Did not match the array")
}
```

To match a variable number of elements, use a rest binder (`...rest`):

```ts
match(arr) {
  [w, x, ...rest] => print("Array has at least two elements")
  _ => print("Did not match the array")
}
```

### `match(expr is pattern)` form

You can use this to destructure once and then dispatch on guards:

```ts
match (req is { user, role }) {
    role == "admin"  => grantAll(user)
    role == "editor" => grantEditing(user)
    _                => grantReadOnly(user)
}
```

## Result patterns

The `success` and `failure` keywords work as patterns. They make unwrapping a `Result` value easy.

### Boolean test

```ts
const worked = result is success
const failed = result is failure
```

### Binding in `if`/`while`

```ts
if (result is success(value)) {
    // value is the unwrapped success value
    print(value)
}

if (result is failure(err)) {
    // err is the error string
    print(err)
}
```

### In match blocks

```ts
match (result) {
    success(value) => print("Got: ${value}")
    failure(error) => print("Error: ${error}")
}
```

### Combined with `match(expr is pattern)` form

```ts
match (result is success(val)) {
    val > 0  => print("positive")
    _        => print("zero or negative")
}
```

### Nested inside other patterns

Result patterns may appear as nested elements inside array or object
match patterns:

```ts
match (pair) {
    [success(val), _] => print("first ok: ${val}")
    [failure(error), _] => print("first err: ${error}")
    _               => print("other")
}
```

## Type patterns

A **type pattern** tests the runtime type of a value.

### `is Type`

Use a type after `is`:

```ts
def render(draft: any): string {
  if (draft is null)   { return "" }
  if (draft is string) { return draft }
}

const looksLikeText: boolean = value is string
```

### `pattern: Type`

In a match arm, add `: Type` after a pattern to destructure and test the type in one move:

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

This syntax works for match arms only.

### Nested type checks

You can attach `: Type` to a whole pattern, or to a nested element of a pattern:

```ts
match (words) {
  // only matches if the second element is a string
  ["echo", s: string]   => print(s)

  // only matches if the second element is a number
  ["echo", n: number]   => print("number: ${n}")
}
```

### Custom type validation

You can also use a custom type alias in a pattern:

```ts
type Person = { name: string, age: number }
const input: any = {
  name: "Alice",
  age: 50
}

match (input) {
  p: Person => print("name: ${p.name}, age: ${p.age}")
  _         => print("not a person")
}
```

If you have a [custom validator](/guide/type-validation) on that type, it will run when the pattern is tested. If the validator fails, the match arm does not match. We cover custom validators in more detail in the sections on [schemas](/guide/schemas) and [type validation](/guide/type-validation).

### Cost

From low to high, the cost of a type check:

- Type checks for primitive types like `string`, `number`, `boolean`, `null` and `object` are effectively free.
- Custom types are more expensive, because we validate using a Zod schema check.
- Types with a custom validator (using `@validate`) are even more expensive.
- Type checks for an array are more expensive, because we validate each element of the array against the type of the array.

Some tips for writing efficient match expressions:
- Put cheap checks first if you can, so that the match short-circuits early.
- Order arms so common cases match early.
- Don't run array validation on large arrays.

### Checking for JSON

`is object` is deliberately coarse. It doesn't check if the value is a plain JSON-serializable tree. A `Date` will pass the `is object` check.

To ask "is this a plain JSON-serializable object?" use the stdlib `Json` type:

```ts
import { Json } from "std::validation"

if (x is Json) {
  JSON.stringify(x)
}
```

### JavaScript classes are not testable

Type patterns never mean `instanceof`, so you cannot test for JavaScript classes: for example, `x is Map` or `x is Set` won't work.

## References
- [Match expressions](/guide/match-expressions)
- [Schemas](/guide/schemas)
- [Type validation](/guide/type-validation)