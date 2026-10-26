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

### Handoff Tools Alongside Other Tool Calls

The model can call a handoff tool in the same response as other tools. The other tools run first, and the handoff tool runs after all of them have finished, so the handoff can see their results. For example, if the model calls `updateStatus` and `getCapital` together, `updateStatus` runs, its result goes on the thread, and then `getCapital` runs.

Only one handoff tool can run per response. If the model calls two, neither runs, and the model is told to call one of them again. The other tools in that response still run.

### Ending the turn from a tool

After a handoff finishes, the model gets one more call to write its reply. When the handoff already answered the user, that call only restates the answer, and it is often the slowest call of the turn. A tool can skip it by calling `endTurn()` from `std::thread` before it returns. The tool's return value becomes the answer, and the `llm()` call that dispatched the tool returns it with no follow-up call.

The tool is the right place for this decision because it has the context: a handoff body has seen the user's whole request and the results of every other tool the model called. Usually the model inside the handoff makes the call. Here the calendar agent asks its last LLM call whether the answer covers everything, and a `@jsonSchema` description tells the model what that means:

```ts
import { endTurn } from "std::thread"

@jsonSchema({ description: "true only if your answer covers every part of the user's latest message" })
type AnsweredEverything = boolean;

type CalendarReply = {
  answer: string;
  answeredEverything: AnsweredEverything;
}

handoff def calendarAgent(userMessage: string): string {
  const reply: CalendarReply = llm("Answer the user's calendar question.", { tools: [listEvents] })
  if (reply.answeredEverything) {
    endTurn()
  }
  return reply.answer
}
```

An ordinary tool can end the turn too, when its result is the exact text the user should see:

```ts
def lookupOrder(id: string): string {
  endTurn()
  return "Order ${id} shipped yesterday and arrives Thursday."
}
```

A mark only counts when the tool was the last to run in its response: a handoff always is, and an ordinary tool counts only when it was the only tool the model called. A tool that ran beside others never saw their results, so its `endTurn()` is ignored.

Some things still make the turn go on, each with a warning in the statelog:

- The tool failed, was rejected, or returned nothing.
- The value is not a string, or does not match the structured output type the caller asked for.
- A tool in the same response handed back an image with `attachToReply`, which the model still has to see.

When the turn ends, the thread ends with the answer as an assistant message. If the body's last message was structured output, like the `CalendarReply` JSON above, the answer replaces it.

#### The `scope` argument

When a handoff's body has its own `llm()` call whose tool ends the turn, only that inner call ends by default. The body's code keeps running and returns, and the outer model still gets its follow-up call. `endTurn(scope: "turn")` ends every enclosing `llm()` call up to the user's turn. Code is never skipped at any level; only the model calls that would restate the answer are. Use `"turn"` only when the answer covers the whole request, because the agents above cannot refuse it.

#### Replacing the hand-back message

A handoff hands control back with `[name finished. <result>] Continue with the user's request.` To say something else, call `handBack(message)` before returning:

```ts
handoff def calendarAgent(userMessage: string): string {
  if (!calendarConnected()) {
    handBack("[calendarAgent could not help: no calendar is connected.] Tell the user how to connect one.")
    return "no calendar"
  }
  ...
}
```

The message is ignored from an ordinary tool, when the handoff was rejected (the model must see the rejection), when it is empty, and when `endTurn()` ends the turn. Both functions are ignored outside a tool invocation, for example when a handoff is called from code.

### System Messages in Handoff Tools

Suppose the handoff tool includes a system message. In a non-handoff context, this is fine, but in a handoff context, having this system message in the thread is going to be confusing, especially if the main thread already had a totally different system message. That is why system messages are inserted into the thread for the duration of the tool call, but they are removed from the thread after the tool call returns.