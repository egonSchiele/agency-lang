---
name: Basic syntax
description: Overview of Agency's TypeScript-derived syntax, covering primitive types, variables, arrays, objects, functions, and other core language constructs.
---

# Basic syntax

A lot of Agency syntax is borrowed from TypeScript and Python. If you have used these languages, the code should look similar.

## Primitives and variables

You've got primitives: strings, numbers, booleans:

```ts
const name: string = "Alice"
const age: number = 30
const isAgent: boolean = true
```

You can define variables with `let` or `const`.

You can use double quotes, single quotes, or backticks for strings. All three allow string interpolation with `${...}`:

```ts
const name = "Alice"
const greeting1 = "Hello, ${name}!"
const greeting2 = 'Hello, ${name}!'
const greeting3 = `Hello, ${name}!`
```

Multi-line strings use `"""` triple-quotes and do **not** interpret backslash escapes (i.e. `\n` is not a newline, it's just a backslash followed by an `n`):

```ts
const block = """
  first line\n
  second line
"""
```

## Arrays and objects

You can define arrays and objects:

```ts
const names = ["Alice", "Bob", "Charlie"]
const person = { name: "Alice", age: 30 }
```

## If statements

```ts
if (age > 18) {
  print("You are an adult.")
} else if (age == 18) {
  print("You are exactly 18 years old.")
} else {
  print("You are a minor.")
}
```

Agency does not have ternary expressions.

## Type annotations

You can add type annotations, just like TypeScript.

```ts
const name: string = "Alice"
const age: number = 30
const names: string[] = ["Alice", "Bob", "Charlie"]
```

Types are covered in more detail in the [section on types](/guide/types).

## Loops

While loop:

```ts
while (age < 100) {
  print(`You are ${age} years old.`)
  age = age + 1
}
```

For loop:

```ts
const names = ["Alice", "Bob", "Charlie"]
for (name in names) {
  print(name)
}

// or with index:
for (name, i in names) {
  print(`Person ${i}: ${name}`)
}
```

For loop with objects:

```ts
const person = { name: "Alice", age: 30 }
for (key, value in person) {
  print(`${key}: ${value}`)
}

// or just the key:
for (key in person) {
  print(`${key}: ${person[key]}`)
}
```

The second loop variable depends on what you're iterating: for an array it's
the numeric **index**, and for an object it's the **value** at that key.

For loops can also destructure arrays and objects:

```ts
const people = [
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 },
]
for ({ name, age } in people) {
  print(`${name} is ${age} years old.`)
}
```

Other loop constructs, such as map, are part of the [agency standard library](/stdlib/array).

## Comments

You can have single-line or multi-line comments.

```ts
// This is a single-line comment
/*
This is a multi-line comment
*/
```

Or doc comments for [documentation generation](/cli/doc):

```ts
/** This is a doc comment for the Person type */
type Person = {
  name: string
  age: number
}
```

Doc comments are wrapped in `/** ... */` and must be on their own line. They can be used to document types, functions, and variables. Doc comments support Markdown formatting.

You can also write a module-level doc comment using the `@module` tag. This documents the file itself and appears at the top of the generated documentation:

```ts
/** @module
  This module provides utilities for working with dates.
*/
```

> Note: comments must be on their own line, they cannot be at the end of a line containing code.

Not allowed:

```ts
const x = 5 // this is a comment
```

## Functions

You can define functions:

```ts
def greet(name: string): string {
  return `Hello, ${name}!`
}
```

### Named arguments

You can call functions with named arguments:

```ts
def greet(name: string, greeting: string = "Hello"): string {
  return `${greeting}, ${name}!`
}

greet(name: "Adit")
```

Functions are covered in more detail in the [section on functions](/guide/functions).

## Nodes

Nodes are like functions, but they are the entry points into your agent:

```ts
node greet(name: string): string {
  return `Hello, ${name}!`
}
```

Nodes are covered in more detail in the [section on nodes](/guide/nodes).

## Blocks

Although Agency doesn't have lambdas the way JavaScript does, it has a similar feature called blocks. You can use this to define functions that take another function. For example, let's use Agency's built-in map function, which takes a block:

```ts
const numbers = [1, 2, 3, 4, 5]
const squares = map(numbers) as n {
  return n * n
}
```

There are also inline blocks:

```ts
const numbers = [1, 2, 3, 4, 5]
const squares = map(numbers, \n -> n * n)
```

Blocks are covered in more detail in the [section on blocks](/guide/blocks).

## Regexes

Regexes are also supported as a primitive:

```ts
// you must use the `re` prefix:
const regex = re/(foo|bar)/

// Use the =~ operator to test if a string matches a regex:
if (name =~ re/^A/) {
  print("Your name starts with A!")
}

// or !~ to test if it doesn't match:
if (str !~ regex) {
  print("The string does not match the regex.")
}
```

## Array slice syntax

Python-style array slice syntax is supported:

```ts
let arr = [1, 2, 3, 4, 5]

// sliced is [2, 3, 4]
const sliced = arr[1:4]

// slicedToEnd is [3, 4, 5]
const slicedToEnd = arr[2:]

// slicedFromStart is [1, 2, 3]
const slicedFromStart = arr[:3]

// negativeSlice is [3, 4]
const negativeSlice = arr[-3:-1]

// arr is now [10, 20, 30, 4, 5]
arr[:3] = [10, 20, 30]
```

## Unit literals

Agency supports unit literals for time, cost, and size values. They compile to plain numbers at compile time:

```ts
// time
const timeout = 30s       // compiles to 30000 (milliseconds)
const delay = 500ms       // compiles to 500
const duration = 2h       // compiles to 7200000
const week = 1w           // compiles to 604800000

// cost
const budget = $5.00      // compiles to 5.00

// size
const size = 100KB        // compiles to bytes
const mediumSize = 500MB  // compiles to bytes
const bigSize = 2GB       // compiles to bytes


```

Supported time units: `ms` (milliseconds), `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks). All time units normalize to milliseconds.

Supported cost units: `$` (dollars).

Supported size units: `kb` (kilobytes), `mb` (megabytes), `gb` (gigabytes). Case insensitive. All size units normalize to bytes.

Unit math works:

```ts
1s + 500ms       // 1000 + 500 = 1500
2s * 3           // 2000 * 3 = 6000
if (elapsed > 30s) { ... }
```

## Destructuring and pattern matching

Array and object destructuring work in `let` / `const` declarations and
in `for` loops:

```ts
let [a, b, ...rest]       = items
let { name, age }         = person
for ({ name, age } in users) { ... }
```

Pattern matching is covered in the [section on pattern matching](/guide/pattern-matching).

## Misc

### Reserved names

Variables and functions beginning with two underscores (`__name`) are reserved for the compiler and runtime, so you cannot use them in your code.


### JavaScript features that don't exist in Agency
- Lambdas.
- Async/await. Everything is awaited by default, and there are specific constructs for [concurrency](/guide/concurrency).
- Classes.