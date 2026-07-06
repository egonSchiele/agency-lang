---
name: Why Agency?
description: Explains why Agency was created, and what makes it different from other programming languages like TypeScript or Python.
---

# Why Agency?

Why Agency? Learning a new language is not easy. Adding it to your stack is not easy. So, I think it's fair to ask: why use Agency? Why a new language? What can it do that can't be done in languages like TypeScript or Python? I'll try to answer that question here.

## The Dartmouth Summer Research Project on Artificial Intelligence

In the summer of 1956, a few academics came together for two months, with the goal of creating artificial intelligence.

> "We propose that a 2-month, 10-man study of artificial intelligence be carried out during the summer of 1956... to find how to *make machines use language, form, abstractions and concepts, solve kinds of problems now reserved for humans, and improve themselves*."

They believed they could make significant progress on all of these in a single summer. They were no slouches. Among the group:

- Marvin Minsky - "father of AI" (MIT) — co-founder of the MIT AI Lab, Turing Award winner, author of *Society of Mind* and *The Emotion Machine*
- Claude Shannon — father of information theory
- Herbert A. Simon - won both a Turing Award and a Nobel Prize in Economics

Now, with LLMs, we've made progress on all of these goals, but there's still a ways to go, and building agents is still hard today.

## Building agents is hard

Building an agent is not easy. Even if you start with a great model, building an agent that responds accurately, swiftly, and safely, is difficult.

People have a baseline level of expectation from using agents like ChatGPT and Claude Code, but that baseline is difficult to achieve. It takes more than strapping a basic harness on a large language model to get there. Just like the Dartmouth summer research project, I think we're seeing that problems like agent memory are harder to solve than we expected.

Building agents is difficult. I created Agency to make the easy parts of building agents simple, and the complex parts tractable.

Here are a few examples comparing Agency and TypeScript to show what's possible in both languages. We'll start with simple syntactical sugar, and move to features that would be genuinely hard to do in another language.

## Syntactical sugar

### Structured output

In Agency, you just write the type, and the compiler turns it into a JSON schema for you. In TypeScript, you declare a schema separately, wire it into the request, and parse the response.

<CodeCompare>
<template #agency>

```ts
type Recipe = {
  title: string
  ingredients: string[]
  steps: string[]
}

node main() {
  const recipe: Recipe = llm("Give me a recipe for pancakes.")
  print(recipe.title)
}
```

</template>
<template #typescript>

```ts
import OpenAI from "openai"
import { z } from "zod"
import { zodResponseFormat } from "openai/helpers/zod"

const Recipe = z.object({
  title: z.string(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
})

const openai = new OpenAI()

const completion = await openai.chat.completions.parse({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Give me a recipe for pancakes." }],
  response_format: zodResponseFormat(Recipe, "recipe"),
})

console.log(completion.choices[0].message.parsed?.title)
```

</template>
</CodeCompare>

### Tool calling

In Agency, every function *is* a tool. You can just pass it into the LLM call. Agency also orchestrates the full tool loop for you.

In TypeScript, you have to define the tool schema yourself. When the LLM responds, you have to check for tool calls, and call the appropriate functions yourself.

<CodeCompare>
<template #agency>

```ts
def getWeather(city: string): string {
  """Get the current weather for a city."""
  return lookupWeather(city)
}

node main() {
  return llm("What should I wear in Mumbai today?", { tools: [getWeather] })
}
```

</template>
<template #typescript>

```ts
import OpenAI from "openai"

const openai = new OpenAI()

const tools = [{
  type: "function",
  function: {
    name: "getWeather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
}];

const messages = [
  { role: "user", content: "What should I wear in Mumbai today?" },
];

let res;
while (true) {
  res = await openai.chat.completions.create({
    model: "gpt-4o", messages, tools,
  })
  const msg = res.choices[0].message;
  messages.push(msg);

  if (!msg.tool_calls) break;

  for (const call of msg.tool_calls) {
    const { city } = JSON.parse(call.function.arguments);
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: lookupWeather(city),
    })
  }
}
```

</template>
</CodeCompare>

### Cost and time budgets

Agency lets you set a budget for a block of code. You can set a dollar amount, a timeout, or both. In TypeScript, you would need to check every LLM call yourself. 



<CodeCompare>
<template #agency>

```ts
import { guard } from "std::thread"

node main() {
  // Cap this whole block at 50 cents and 30 seconds.
  const result = guard(cost: $0.50, time: 30s) as {
    const draft = llm("Research renewable energy and write a report.")
    return factCheck(draft)
  }

  match(result) {
    success(report) => print(report)
    failure(e) => print("Ran out of budget")
  }
}
```

</template>
<template #typescript>

```ts
import OpenAI from "openai"

const openai = new OpenAI()
const BUDGET = 0.50
const deadline = Date.now() + 30_000
let spent = 0

// You price each response yourself, from token usage × model rates.
function priceOf(usage): number { /* ... */ }

async function call(prompt: string, signal: AbortSignal): Promise<string> {
  const res = await openai.chat.completions.create(
    { model: "gpt-4o", messages: [{ role: "user", content: prompt }] },
    { signal },
  )
  spent += priceOf(res.usage)
  if (spent > BUDGET) throw new Error("over budget")
  return res.choices[0].message.content ?? ""
}

const ctrl = new AbortController()
const timer = setTimeout(() => ctrl.abort(), deadline - Date.now())
try {
  const draft = await call("Research renewable energy...", ctrl.signal)
  const report = await call(`Fact-check and tighten: ${draft}`, ctrl.signal)
} finally {
  clearTimeout(timer)
}
// ...and `spent`, the deadline, and the signal get threaded through
// every function that might make a call.
```

</template>
</CodeCompare>

All of these things are possible in TypeScript, Agency just provides some tactical sugar for it. Now let's look at some things that would be genuinely hard to do in TypeScript.

## Genuinely hard to do

The examples above save you boilerplate, but these next ones are different. They would be a lot of work to do in TypeScript... enough work that you would essentially be rebuilding Agency to do them.

### Agents that write and run their own code

Agency lets you define what an agent can and can't do – no writes, no network requests, etc.  You can enforce these rules at compile time and at run time. The cool part is, *you can enforce them at runtime for any code that your agent writes and runs as well*.

You can build this in Agency in a few lines:

<CodeCompare>
<template #agency>

```ts
import { compile, run } from "std::agency"
import { guard } from "std::thread"

node main() {
  // The model writes a program to do the task.
  const prompt = "Write an Agency program that researches solar power."
  const source = llm(prompt)
  const program = compile(source)

  handle {
    // Cap the generated code's running time and cost
    guard(cost: $0.50, time: 30s) as {
      run(program.value, "main")
    }
  } with (intr) {
    // reject all writes
    if (intr.effect == "std::write") { return reject() }
    return approve()
  }
}
```

</template>
</CodeCompare>

There are different sandboxing options (eg Deno), but what Agency allows is very precise control. For example, you could say that the agent is only allowed to read files in a specific directory, it's allowed to run `git log` but not `git checkout` ... whatever logic you can write in code. The time and cost guards automatically work too.

### Pausing for human input

Agency lets you pause the agent at any point for human input with a single line. This isn't like getting input on the command line – Agency is actually halting and resuming execution of your agent, which means you could use this code from a web server, and your agent could wait for human input indefinitely without blocking any threads.

<CodeCompare>
<template #agency>

```ts
def deleteEmails(count: number) {
  """Delete the user's emails."""
  raise interrupt("Delete ${count} emails?", { count: count })
  reallyDelete(count)
}

node main() {
  llm("Clean up my inbox.", tools: [deleteEmails])
}
```
</template>
</CodeCompare>

This feature just works. You could write an agent, that calls a sub-agent, that makes several tool calls in parallel, and some of those tool calls need to pause for human input – and when you resume execution, you would still pick up right where you left off. See [interrupts](/guide/interrupts) for more information.

### Concurrency you don't have to think about

Agency globals are *per-run*: every call to an agent — and every parallel branch — gets its own copy. So you can keep mutable state in a plain global and never worry about concurrent requests stepping on each other. (See [state isolation](/guide/state-isolation).)

<CodeCompare>
<template #agency>

```ts
const todos = []

def addTodo(todo: string) { todos.push(todo) }
def getTodos() { return todos }

node main() {
  // Five requests can run this at once, each with its
  // own `todos`. No shared state, no races.
  return llm("Plan my day.", tools: [addTodo, getTodos])
}
```

</template>
<template #typescript>

```ts
// A module-level array is shared by every concurrent
// request — their todos interleave and corrupt each other.
const todos: string[] = [] // shared across all requests

// So you thread a per-request context through everything:
function addTodo(ctx: RequestContext, todo: string) {
  ctx.todos.push(todo)
}
// ...and every function that touches state now takes `ctx`.
```

</template>
</CodeCompare>

### A subagent is just a tool

Want a subagent? Write a function that calls `llm`, give it its own [thread](/guide/message-threads) for a clean context, and hand it to another `llm` call as a tool. That's it — no graph, no special node type, no framework concepts to learn. Subagents compose like ordinary functions, because they *are* functions.

<CodeCompare>
<template #agency>

```ts
def researcher(topic: string): string {
  """Research a topic and return a short summary."""
  let summary = ""
  thread {
    // Its own conversation — doesn't pollute the caller's.
    summary = llm("Research ${topic} and summarize.")
  }
  return summary
}

node main() {
  // The lead agent calls the researcher whenever it needs to.
  return llm("Write a report on renewable energy.",
             tools: [researcher])
}
```

</template>
<template #typescript>

```ts
// The subagent needs its own tool loop and message history...
async function researcher(topic: string): Promise<string> {
  const messages = [{ role: "user", content: `Research ${topic}.` }]
  // ...run a full create()/tool-dispatch loop here (see above)...
  return finalSummary
}

// ...then wrap THAT as a tool for the lead agent's loop — so now
// you're running nested tool loops and juggling two histories.
```

</template>
</CodeCompare>

> **The research.** Multi-agent collaboration measurably helps, but the frameworks that deliver it add real orchestration machinery — roles, standard operating procedures, conversation patterns ([AutoGen, 2023](https://arxiv.org/abs/2308.08155); [MetaGPT, 2023](https://arxiv.org/abs/2308.00352)). In Agency a subagent is just a function you pass as a tool, so composing them takes no extra machinery.

And there's more where that came from: [message threads](/guide/message-threads) and [cross-thread context](/guide/cross-thread-context) let a router keep a separate, auto-resuming conversation per topic; [effects and `raises`](/guide/effects-and-raises) let the compiler track and constrain what your code is allowed to do; and [checkpointing](/guide/checkpointing) lets you rewind and retry a run. Each of these is a language-level capability, not a library you wire in.