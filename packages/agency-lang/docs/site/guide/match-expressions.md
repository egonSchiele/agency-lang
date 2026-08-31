---
name: Match Expressions
description: Match expressions are like switch statements, but more powerful. They have exhaustiveness checking and great support for pattern matching.
---

# Match expressions

Match expressions are sort of like switch statements.

```ts
const status: "success" | "failure" | "pending" = getStatus()
match (status) {
    "success" => print("Yay!")
    "failure" => print("Boo!")
    "pending" => print("Waiting…")
}
```

## Assignment

You can assign the result of a match to a variable:

```ts
const points = match(grade) {
    "A" => 100
    "B" => 80
    _   => 0
}
```

## Blocks of statements

The match arms can be single expressions or blocks of statements.

```ts
const val = match(result) {
    success(v) => {
        print(v)
        return v * 2
    }
    failure(e) => e.message
}
```


## Returns

You can return a value from a match expression:

```ts
def classify(result: Result<number>): string {
    return match(result) {
        success(value) => "got value: ${value}"
        failure(error) => "got error: ${error}"
    }
}
```

Multi-expression blocks must explicitly return a value, whereas single-expression arms return their value implicitly.

### Returning an object literal

Just like in JavaScript, if you want to implicitly return an object literal from a single-expression arm, you need to wrap it in parentheses. 

```ts
kind => ({ label: kind })
```

Or just use the block form, which doesn't require parentheses:

```ts
kind => { return { label: kind } }
```

### Returns inside a match

Inside a match arm, `return expr` returns from the match, not from the enclosing function:

```ts
def classify(result: Result<number>): string {
  match(result) {
    // these return from the arm, not from classify()
    success(v) => return "got a success!"
    failure(e) => return "got a failure!"
  }
}
```

To return from the function, put the `return` before the `match`:

```ts
def classify(result: Result<number>): string {
  return match(result) {
    // here you can have a return or not -- single expressions
    // use implicit return.
    success(v) => "got a success!"
    failure(e) => return "got a failure!"
  }
}
```

## goto

You can also use `match` with `goto` to jump to different nodes:

```ts
node foo() {
  print("hi from foo!")
}

node bar() {
  print("hi from bar!")
}

node main() {
  const val = "foo"
  match(val) {
    "foo" => goto foo()
    "bar" => goto bar()
    _ => print("hi from main!")
  }
}
```

## Destructuring

You can destructure arrays and objects in match arms:

```ts
match (event) {
    ["click", x, y] => handleClick(x, y)
    ["scroll", delta] => handleScroll(delta)
    _ => ignore()
}
```

## Matching on interrupt effects

Inside a handler, you can match an interrupt by its effect name:

```ts
handle {
    writeReport()
} with (intr) {
    return match (intr) {
        std::write => approve()
        std::read  => approve()
        _          => reject()
    }
}
```

The handler receives the interrupt as `intr`. Here you match on `intr` itself, the whole interrupt.

An arm like `std::write` matches any interrupt whose effect is `std::write`. To also read the interrupt's payload, write the effect name with an object pattern:

```ts
match (intr) {
    std::write({ data }) => inspect(data)
    _                    => reject()
}
```

The `{ data }` binds `data` to `intr.data`, which holds the interrupt's payload. You can destructure deeper. `std::write({ data: { dir } })` binds `dir` to `intr.data.dir`.

An effect name always contains `::`. A bare name like `write` is a variable binding, not an effect. To match on a bare effect name, match on `intr.effect` against a string instead:

```ts
match (intr.effect) {
    "write" => approve()
    _       => reject()
}
```

## Guard clauses

You can add a guard clause `if (…)` to any arm:

```ts
match (request) {
    { kind: "user", age } if (age >= 18) => allow()
    { kind: "user" }                     => block()
    _                                    => unknown()
}
```

The guard runs only when the arm's pattern matched, and it can use any variable that the pattern bound (like `age` above). If the guard is false, the match tries the next arm.

## Catch-all arm

You can use `_` as a catch-all arm. It matches anything that didn't match any of the previous arms:

```ts
match (value) {
    1 => print("one")
    2 => print("two")
    _ => print("something else")
}
```

Note: a guard on `_` makes it stop being a catch-all. `_ if (cond)` is a conditional arm, and when `cond` is false, that arm won't match.

## Exhaustiveness checking

One of the really useful things about match expressions is that they do exhaustiveness checking. Suppose you have defined a `Shape` type and use a match expression to compute the area of different shapes:

```ts
type Shape = { kind: "circle", r: number } | { kind: "square", side: number }

const area = match(shape) {
    { kind: "circle", r } => 3.14 * r * r
    { kind: "square", side } => side * side
}
```

If you add a new shape to your shape type and forget to add it to the match expression, the match expression will throw a type error. This makes it easy to make changes to your code without accidentally forgetting to handle a new case.

### Open types always need a `_` arm

In the example above, it was easy for us to enumerate all the shapes we can support. But what if the type we're matching on is a string? In that case, it's not possible to enumerate all the types in our match block.

```ts
// name is a plain string
const greeting = match(name) {
    "Ada"  => "Hi Ada!"
    "Alan" => "Hi Alan!"
}
// But what if `name` is `Beyonce`?
```

So whenever the scrutinee (the thing you're matching on) is an open type, add a `_` arm:

```ts
const greeting = match(name) {
    "Ada"  => "Hi Ada!"
    "Alan" => "Hi Alan!"
    _      => "Hello, you!"
}
```

## Restrictions

You can't use `match` expressions inside `parallel` blocks.

## References
- [Pattern matching](/guide/pattern-matching)