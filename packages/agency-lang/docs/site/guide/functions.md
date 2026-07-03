---
name: Functions
description: Covers function declarations in Agency, including docstrings (used as LLM tool descriptions), default and variadic arguments, named parameters, and block syntax.
---

# Functions

Define a function using `def`:

```ts
def add(a: number, b: number): number {
  return a + b
}
print(add(4, 5))
```

## Tool calls

Any function defined in Agency can automatically be used as a tool for the LLM. Pass the function in the `tools` option:

```ts
def add(a: number, b: number): number {
  return a + b
}

const result = llm("What is 4 + 5?", tools: [add])
print(result)
```

LLM calls are covered in more detail in the [chapter on LLMs](/guide/llm).

## Docstrings

The docstring of a function will be sent to the LLM as a description of the tool. This can help the LLM understand what the function does and how to use it.

```ts
def add(a: number, b: number): number {
  """
  Adds two numbers together.
  """
  return a + b
}
```

## Default arguments, optional arguments, and variadic arguments

Default arguments:

```ts
def round(num: number, decimals: number = 2): number
```

Optional arguments:

```ts
def greet(name: string, greeting?: string): string
```

Variadic arguments:

```ts
def print(...messages: string[]): void
```

## Named arguments

```ts
def greet(name: string = "Adit", greeting: string = "Hello"): string {
  return `${greeting}, ${name}!`
}

// used a named arg
greet(name: "Alice")

// we can jump to the second arg, since the first arg has a default value
greet(greeting: "Hi")

// we can switch the order
greet(greeting: "Hi", name: "Bob")
```

## Blocks

Functions can also take blocks. This is a way to pass a chunk of code to a function. If you're used lambda functions in other languages, this is similar.

```ts
def repeat(n: number, block: () -> any) {
  for (i in range(n)) {
    block()
  }
}
```

Blocks are covered in more detail in the [section on blocks](/guide/blocks).