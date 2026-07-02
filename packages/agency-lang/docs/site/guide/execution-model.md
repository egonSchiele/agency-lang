---
name: Agency's execution model
description: Explains how every Agency node call gets isolated state when invoked from TypeScript, and how `static` variables let you share expensive one-time initialization across runs.
---

# Agency's execution model

Every run of an agent gets full isolated state. Here's what I mean. Suppose you define an agent like this.

```ts
const log = []
node main(name:string) {
  const result = llm(`What is a nice greeting for ${name}?`)
  log.push(result)
  return log
}
```

You can see it's got a global variable, `log`. Now, suppose you're using this agent in a web server context. As you know, any node defined in Agency can be imported and run as a regular function in TypeScript:

```ts
// note you have to import from the compiled .js file, not the .agency file
import { main } from "./main.js";

async function run() {
  const result = await main("Adit");
  console.log(result);
}

run();
```

In a web server, you may have multiple requests concurrently calling this agent. Let's say you have *five* requests concurrently calling this agent, with these names:

```
Colin
Ed
Jonny
Phil
Thom
```

Five requests that call the `main` node and get the `log` array as the return value. What return value is each request going to get? Now, you may be thinking, it depends on the call order, but most of these requests are going to get an array with more than one value. Some may even get 5 values:


```ts
[
  "What is a nice greeting for Colin?",
  "What is a nice greeting for Ed?",
  "What is a nice greeting for Jonny?",
  "What is a nice greeting for Phil?",
  "What is a nice greeting for Thom?"
]
```

But that's not correct! Each request will get an array with a single value:

```ts
// 1
["What is a nice greeting for Colin?"]

// 2
["What is a nice greeting for Ed?"]

// 3
["What is a nice greeting for Jonny?"]

// 4
["What is a nice greeting for Phil?"]

// 5
["What is a nice greeting for Thom?"]
```

Every call to an Agency agent gets state isolation, so each run has its own copy of the global variables.

This makes it much easier to reason about your agent, as you don't have to think about concurrency. You don't have to design your agent differently based on whether it will be used in a CLI tool or in a web server. If you design a package for agency, you don't have to worry about how it will handle concurrent requests.

For example, let's say you design a todos package for agency. This package exposes a couple of simple functions that you can pass as tools to an agent to let it manage its todos. 

How do you store the todos state? This could get really complicated if you worry about concurrency. But you don't have to; just create a global variable:

```ts
const todos = []
export def addTodo(todo: string) {
  todos.push(todo)
}
export def getTodos() {
  return todos
}
```

## Exporting global variables

Global variables make it easy to store state, but can lead to spaghetti code. If your agent is spread across 20 different files, and you have lots of global variables, and each variable could be getting accessed from any file, you have spaghetti code. This sort of code really hard to reason about. This is why lots of languages either frown on allowing users to export global variables, or just ban it outright.

Agency bans exporting global variables. You cannot export a global variable. You can export functions that set and set those variables, though. This makes code easier to reason about.

## Isolation across concurrent branches

The same isolation property extends one level deeper. Each **branch** of a `parallel`, `fork`, or `race` block gets its own copy of globals too, snapshotted from the parent at the moment the fork runs. Writes a branch makes never leak back to the parent. This means you can confidently wrap two existing agents in `parallel` without worrying about them corrupting each other's internal state:

```ts
parallel {
  researchAgentA()   // each agent sees its own snapshot of any globals
  researchAgentB()   // they touch — writes don't leak to each other or the parent
}
```

If you actively *want* branches to cooperate on shared state, pass `shared: true` — see the [concurrency guide](./concurrency#state-isolation-across-branches) for details.

## State in TypeScript
This isolated state model only applies to state defined in agency. Any state that you define in TypeScript will not get this kind of state isolation, unless you explicitly code it to. In the agent code above, if the `log` array lived in TypeScript code, then the requests wouldn't have state isolation:

foo.ts:
```ts
export const log = []
```

main.agency:
```ts
import { log } from "./foo.js"
node main(name:string) {
  const result = llm(`What is a nice greeting for ${name}?`)
  log.push(result)
  return log
}
```

If you want to create global variables in TypeScript that get the same kind of state isolation, [Agency exports some helpers you can use](/guide/ts-helpers).
