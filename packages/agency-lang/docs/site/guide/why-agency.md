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

## Structured output

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

## Tool calling

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

## Retries and timeouts

Model calls fail and hang. In Agency, resilience is an option on the call. In TypeScript, you write the retry loop, the backoff, and the timeout wrapper yourself.

<CodeCompare>
<template #agency>

```ts
node main() {
  return llm("Summarize today's news.", {
    retries: 3,
    timeout: 5000,
  })
}
```

</template>
<template #typescript>

```ts
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ])
}

let delay = 500
for (let attempt = 0; ; attempt++) {
  try {
    const result = await withTimeout(callLLM("Summarize today's news."), 5000)
    break
  } catch (err) {
    if (attempt >= 3) throw err
    await new Promise((r) => setTimeout(r, delay))
    delay *= 2 // exponential backoff
  }
}
```

</template>
</CodeCompare>

The point isn't that any of this is impossible in TypeScript — it's all just code. It's that Agency makes the common shape of agent work a language feature, so you write the interesting part and let the compiler and runtime handle the plumbing.

## But some things aren't just plumbing

The examples above save you boilerplate. These next ones are different: the TypeScript version isn't "more code" — it's a fair amount of infrastructure, not something a library can bolt on. For these, the TypeScript side is a sketch of what you'd have to build, not a drop-in equivalent.

### Agents that write and run their own code — safely

You can build this in Agency in a few lines: an agent that asks the model to write a program, then runs it. The scary part is usually "…and now untrusted, model-written code is executing on my machine." In Agency, the generated code runs in a subprocess, and *every side effect it attempts* — writing a file, hitting the network, spawning more code — raises an interrupt that runs **your** handler in the parent. A [guard](/guide/guards) caps how long it can run and how much it can spend.

<CodeCompare>
<template #agency>

```ts
import { compile, run } from "std::agency"
import { guard } from "std::thread"

node main() {
  // The model writes a program to do the task.
  const source = llm("Write an Agency program whose main node
                      researches solar power and saves a report.")
  const program = compile(source)
  if (isFailure(program)) { return "did not compile" }

  handle {
    // Cap the generated code's runtime and spend.
    guard(cost: $0.50, time: 30s) as {
      run(program.value, "main")
    }
  } with (intr) {
    // Every file write, fetch, etc. the generated code
    // attempts comes here first. We decide what it may do.
    if (intr.effect == "std::write") { return reject() }
    return approve()
  }
}
```

</template>
<template #typescript>

```ts
// There's no built-in for "run this code, but govern what it
// can do." A faithful version means building, roughly:
//
//   • a child process to isolate the generated code
//   • an IPC protocol between parent and child
//   • interception of every side-effecting call the code
//     makes (fs, network, subprocess) — missing one is a hole
//   • routing each of those back to the parent to approve/deny
//   • metering token spend across the process boundary, live
//   • wall-clock, memory, and output caps with a hard kill
//
// That's closer to a sandbox runtime than a snippet.
```

</template>
</CodeCompare>

> **The research.** Code-as-action outperformed JSON tool calls in one controlled comparison ([CodeAct, ICML 2024](https://arxiv.org/abs/2402.01030)), and recent agent-safety work increasingly favors *execution-level, by-design* enforcement over detection-based defenses that adaptive attackers tend to break ([Adaptive Attacks, 2025](https://arxiv.org/abs/2503.00061); [Progent, 2025](https://arxiv.org/abs/2504.11703)). Agency's handler-per-effect model works along those lines, at the language level.

### Pausing for a human — and resuming exactly where you left off

An interrupt pauses execution — even deep inside the model's tool loop — hands control to a handler at the top, and then resumes *right where it paused*, with every local variable intact. Agency snapshots the whole execution state, so you can even serialize the pause, hand it to a web client, and [resume it later](/guide/interrupts-from-typescript).

<CodeCompare>
<template #agency>

```ts
def deleteEmails(count: number) {
  """Delete the user's emails."""
  raise interrupt("Delete ${count} emails?", { count: count })
  reallyDelete(count)
}

node main() {
  handle {
    llm("Clean up my inbox.", tools: [deleteEmails])
  } with (intr) {
    // Fires the instant the model's tool call tries to
    // delete — deep in the tool loop — then resumes there
    // once we answer.
    const answer = input("${intr.message} (y/n) ")
    if (answer == "y") { return approve() }
    return reject()
  }
}
```

</template>
<template #typescript>

```ts
// JavaScript can't pause a running call stack and resume it
// later. You either hoist every approval to the top...
const plan = await getPlan()
for (const step of plan) {
  if (step.risky && !(await askHuman(step))) continue
  await run(step)
}

// ...or, to survive a restart, hand-roll a state machine:
//   • serialize every local variable after each step
//   • persist it; return a "pending approval" to the caller
//   • on resume, rehydrate and re-enter at the exact step
// The deeper the call stack, the more state you thread by hand.
```

</template>
</CodeCompare>

> **The research.** Surveys of human-agent systems frame human control injected mid-run as one fix for autonomy's reliability and safety failures ([Zou et al., 2025](https://arxiv.org/abs/2505.00753)) — while noting that the *operator's* approval burden is itself under-studied. Agency's interrupts give you that control channel: resumable, and paired with `preapprove`/[policies](/guide/policies) to help keep the burden low.

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