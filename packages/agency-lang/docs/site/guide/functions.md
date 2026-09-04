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

## Handoff

When you make a tool call, any LLM calls inside the tool call happen in a separate thread. Let's take this code as an example:

```ts
def getCapital(country: string): string {
  const capital = llm("What is the capital of ${country}?")
  return capital
}

node main() {
  const response = llm(
    "Use your getCapital tool to get the capital of India.",
    tools: [getCapital],
  )
  print(response)
}
```

Here's what the thread for it might look like:

```
[user] Use your getCapital tool to get the capital of India.
[assistant] tool call: getCapital({"country":"India"})
▼ toolExecution getCapital (1.9s, 94 tok, $0.000)
    [user] What is the capital of India?
    [assistant] The capital of India is New Delhi.
▶ toolCall "getCapital" (1.9s)
[tool: getCapital] The capital of India is New Delhi.
[assistant] The capital of India is New Delhi. (Retrieved using the getCapital tool.)
```

The main thread only sees that a tool call was made, and it sees the return value from the tool call. It doesn't see any of the intermediate messages. This is fine if the result of the tool call is meant to be the return value of the function.

Sometimes, however, the result of the tool call is *the LLM messages in the tool call*. For example, you may have a research agent that goes and does a bunch of research. In that case, you might want all of its messages to be part of the main thread, so the main agent gets that *entire* context, not just what the tool returns.

In that case, you can mark the function as a handoff function.

```ts
handoff def getCapital(country: string): string {
  const capital = llm("What is the capital of ${country}?")
  return capital
}
```

Now the thread looks more like this:

```
[user] Use your getCapital tool to get the capital of India.
[assistant] [dispatching getCapital: {"country":"India"}]
[user] What is the capital of India?
[assistant] The capital of India is New Delhi.
[user] [getCapital finished. The capital of India is New Delhi.] Continue with the user's request.
[assistant] The capital of India is New Delhi (returned by the getCapital tool).
```

Note that we insert a couple of messages in there, just so it's clear from reading the thread that a handoff occurred and finished.

### System Messages in Handoff Tools

Suppose the handoff tool includes a system message. In a non-handoff context, this is fine, but in a handoff context, having this system message in the thread is going to be confusing, especially if the main thread already had a totally different system message. That is why system messages are inserted into the thread for the duration of the tool call, but they are removed from the thread after the tool call returns.