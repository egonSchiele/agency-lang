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

for (const name of names) {
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

> Note: comments must be on their own line, they cannot be at the end of a line containing code.

### JavaScript features that don't exist in Agency
- lambdas
- async/await. Everything is awaited by default, and there are specific constructs for async, such as [fork](/guide/fork)
- custom constructors for [classes](/guide/classes). A default constructor is generated for you.