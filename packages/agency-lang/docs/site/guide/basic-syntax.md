# Basic syntax

Hello and welcome! Agency is a language for building agents, or any other type of system that is complex, hard to debug, and involves non-deterministic outputs. But before you read about that, let's take two minutes to quickly cover installation and syntax.

Agency is a language that compiles down to TypeScript or JavaScript. It borrows its syntax from these languages, if you have used either JS or TS before, a lot of Agency will be familiar to you.

> Note: I'll just say TypeScript everywhere, because writing "TypeScript or JavaScript" gets really boring, but you'll know that I mean both.

You've got primitives: strings, numbers, booleans:

```ts
const name: string = "Alice"
const age: number = 30
const isAgent: boolean = true
```

You can define variables with `let` or `const`. You can add type annotations, just like TypeScript.

You can define arrays and objects:

```ts
const names: string[] = ["Alice", "Bob", "Charlie"]
const person: { name: string, age: number } = { name: "Alice", age: 30 }
```

You can define functions:

```ts
def greet(name: string): string {
  return `Hello, ${name}!`
}
```

You can use if statements, while loops and for loops:

```ts
if (age > 18) {
  print("You are an adult.")
} else {
  print("You are a minor.")
}

while (age < 100) {
  print(`You are ${age} years old.`)
  age = age + 1
}

for (name in names) {
  print(name)
}
```

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

You can also write a module-level doc comment using the `@module` tag. This documents the file itself and appears at the top of the generated documentation:

```ts
/** @module
  This module provides utilities for working with dates.
*/
```

> Note: comments must be on their own line, they cannot be at the end of a line containing code.

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

Array slice syntax is supported:

```ts
let arr = [1, 2, 3, 4, 5]
const sliced = arr[1:4] // sliced is [2, 3, 4]
const slicedToEnd = arr[2:] // slicedToEnd is [3, 4, 5]
const slicedFromStart = arr[:3] // slicedFromStart is [1, 2, 3]
const negativeSlice = arr[-3:-1] // negativeSlice is [3, 4]
arr[:3] = [10, 20, 30] // arr is now [10, 20, 30, 4, 5]
```

### Unit literals

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

Unit math works because both sides normalize to the same base unit:

```ts
1s + 500ms       // 1000 + 500 = 1500
2s * 3           // 2000 * 3 = 6000
if (elapsed > 30s) { ... }
```

Mixing dimensions is a type error:

```ts
1s + $5.00    // ERROR: cannot add time and cost
```

### JavaScript features that don't exist in Agency
- lambdas
- async/await. Everything is awaited by default, and there are specific constructs for [concurrency](/guide/concurrency).
- classes.