---
name: State Isolation
description: Explains how every Agency node call gets isolated state when invoked from TypeScript, and how `static` variables let you share expensive one-time initialization across runs.
---

# State Isolation

Every run of an agent gets full isolated state. Suppose you define an agent like this.

```ts
const log = []
node main(name:string) {
  const result = "Hello, ${name}!"
  log.push(result)
  return log
}
```

This agent has a global variable, `log`. Now, suppose you're using this agent in a web server context. As you know, any node defined in Agency can be imported and run as a regular function in TypeScript:

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

Five requests that call the `main` node, push an entry to `log`, and then return `log` as the return value. What return value is each request going to get? You may think each request is mutating the same array, so at least one request will get an array with all five values.

```ts
[
  "Hello, Colin!",
  "Hello, Ed!",
  "Hello, Jonny!",
  "Hello, Phil!",
  "Hello, Thom!"
]
```

But that's not correct! Each request will get an array with a single value:

```ts
// 1
["Hello, Colin!"]

// 2
["Hello, Ed!"]

// 3
["Hello, Jonny!"]

// 4
["Hello, Phil!"]

// 5
["Hello, Thom!"]
```

Every call to an Agency agent gets state isolation, so each run has its own copy of the global variables. This makes it much easier to reason about your agent, as you don't have to think about concurrency. 

## Todos example

It's a common pattern to have agents keep track of their work by creating todos. Let's create an agent that keeps track of its todos:

```ts
const todos = []

def addTodo(todo: string) {
  todos.push(todo)
}

def getTodos() {
  return todos
}

def markDone(todo: string) {
  const index = todos.indexOf(todo)
  if (index !== -1) {
    todos.splice(index, 1)
  }
}

node main() {
  const result = llm("Do some stuff", tools: [addTodo, getTodos, markDone])
}
```

We can just create a global variable, `todos`, and then add todos to it. Each run of the agent will have its own copy of the `todos` array, so you don't have to worry about concurrency issues.

## Isolation across concurrent branches

Suppose you want to run three research agents in parallel to explore a topic in different ways. You want all three agents to keep track of their todos. *The same isolation property also extends to branches.*

You can still use the same todos code without worrying about concurrency, because each agent will get their own copy of the `todos` variable.

```ts
parallel {
  // both have their own copy of the todos array
  researchAgentA()
  researchAgentB()
}
```

If you *want* branches to have shared state, you can get that too; pass `shared: true`. See the [concurrency guide](/guide/concurrency) for details.

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
  const result = llm(`Hello, ${name}!`)
  log.push(result)
  return log
}
```

If you want to create global variables in TypeScript that get the same kind of state isolation, [Agency exports some helpers you can use](/guide/ts-helpers).