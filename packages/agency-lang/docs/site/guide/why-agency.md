---
name: Why Agency?
description: Explains why Agency was created, and what makes it different from other programming languages like TypeScript or Python.
---

# Why Agency?

Why Agency? Learning a new language is not easy. Adding it to your stack is not easy. So, I think it's fair to ask: why use Agency? Why a new language? What can it do that can't be done in languages like TypeScript or Python? I'll try to answer that question here.

## The Dartmouth Summer Research Project on Artificial Intelligence

In the summer of 1956, a few academics came together for two months, with the goal of creating artificial intelligence.

> "We propose that a 2-month, 10-man study of artificial intelligence be carried out during the summer of 1956... An attempt will be made to find how to make machines use language, form, abstractions and concepts, solve kinds of problems now reserved for humans, and improve themselves."

They believed they could make significant progress on all of these in a single summer. They were no slouches. Among the group:

- Marvin Minsky - "father of AI" (MIT) — co-founder of the MIT AI Lab, Turing Award winner, author of *Society of Mind* and *The Emotion Machine*
- Claude Shannon — father of information theory
- Herbert A. Simon - won both a Turing Award and a Nobel Prize in Economics

Even though they didn't achieve their goal, they set the research agenda for the next 70 years. AI is hard. It was hard then, and it's still hard today.

## Building agents is hard

Building an agent is not easy. Even if you start with a great model, building an agent that responds accurately, swiftly, and safely, building an agent that's able to have a long conversation, and still remember context from early in the conversation, is really difficult.

These are all genuinely hard engineering problems, and in fact each one is big enough that it's turning into its own area of research.

Building agents is difficult. I created Agency to make the easy parts of building agents simple, and the complex parts tractable.

Here are a few examples comparing Agency and TypeScript to show what's possible in both languages. I have done my best to represent both languages fairly.

## Structured output

Ask for a typed value and get one back. In Agency, you annotate the result and the compiler turns your type into a JSON schema for you. In TypeScript, you declare a schema separately, wire it into the request, and parse the response.

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

## Calling tools

Give the model a function it can call. In Agency, a function *is* a tool — pass it in and Agency runs the whole tool loop for you (calling the tool, feeding the result back, repeating until the model is done). In TypeScript, you describe the tool's schema by hand and write that loop yourself.

<CodeCompare>
<template #agency>

```ts
def getWeather(city: string): string {
  """Get the current weather for a city."""
  return lookupWeather(city)
}

node main() {
  return llm("What should I wear in Paris today?", { tools: [getWeather] })
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
}]

const messages = [
  { role: "user", content: "What should I wear in Paris today?" },
]

while (true) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o", messages, tools,
  })
  const msg = res.choices[0].message
  messages.push(msg)

  if (!msg.tool_calls) break // model gave a final answer

  for (const call of msg.tool_calls) {
    const { city } = JSON.parse(call.function.arguments)
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