Agency is a language for creating agents. It has language-level support for LLM features and allows you to quickly create an agent, defined as a graph.

## Core concepts
### Nodes
A node is a basic building block in Agency. You define a node like this:

```agency
node greet() {
  print("hi!");
}
```

Here are two nodes:

```agency
node greet() {
  print("hi!");
}

node main() {
  return greet()
}
```

You can see that the `main` node is calling the `greet` node. This defines an edge between the two nodes. This is a core feature of Agency: allowing you to build up a graph without needing much boilerplate code. Simply define the nodes and call them as functions; the function call will define an edge.

Note that a call to another node should always `return`. This is because when following an edge from one node to another, we never return to the first node after the second node is executed.

If you plan to run this agency file as a script, you will need a node named `main`, which is the entry point of the script. If you plan to import it into another script instead, the `main` node is not required. More on importing later.

### LLM Calls
To make an LLM call, use the `llm` function:

```agency
response: string = llm(`Say hi to me`)
magicNumber: number = llm(`Add 4 + 5`)
```

You can also use the older backticks syntax. Any text between backticks, gets sent to an LLM. For example:

```agency
greet = `Say hi to me`
```

The text "Say hi to me" will be sent as a user message to the LLM, and the variable `greet` will be set to the LLM's response.

If you want to request a specific output format, use a type hint.

### Type Hints

```agency
greet: number = llm("add 4 + 5")
```

This will tell the LLM to respond with a number. Here are some supported types:

Primitive types:
- string
- number
- boolean
- null
- undefined

Union types. Example:

```agency
status: "success" | "error" = llm("Respond with either 'success' or 'error'")
```

Array types. Example:

```agency
items: string[] = llm("List 5 fruits")
```

Object types. Example:

```agency
user: {name: string, age: number} = `Provide a user object with name and age`
```

You can define a new type:

```agency
type User = {
  name: string;
  age: number;
}
```

You can describe a property on an object for the LLM:

```agency
type User = {
  name: string # The name of the user
  age: number # The age of the user
}
```

NOTE: You currently CANNOT set a type on a variable. This will not work:

```agency
name: string[] = []
```

You'll need to skip the type:

```agency
name = []
```

### Functions / tools

Here is an example of a function in Agency:

```agency
def greet(name: string): string {
  greeting = `Greet the person named ${name}`
  return greeting
}
```

All functions in Agency can automatically be used as tools. For example, you can now use the `greet` function as a tool in a prompt.

```agency
+greet
response: string = `Use the greet function to greet Alice`
```

The `+greet` line tells Agency to make the `greet` function available as a tool in the LLM prompt.

### Control Flow

Agency supports `if` statements and `match` statements for control flow.
Here is an example of an `if` statement:

```agency
condition = false
if (condition) {
  print("You are an adult.")
}
```

Here is an example of a `match` statement:

```agency
status = "success"
match(status) {
  "success" => print("Operation was successful.")
  "error" => print("There was an error.")
  _ => print("Unknown status.")
}
```

Agency also supports `while` loops:

```agency
condition = true
while (condition) {
  print(count)
  condition = false
}
```

### Imports
When an agency file gets transpiled to TypeScript, all of the nodes and functions are available for import. You can import them into a typescript file like this:

```ts
// This imports the ingredients node
import { ingredients } from "./ingredients.agency"
```

and then simply call them as regular functions.

If you're importing into another agency file, you should use `import node` and `import tool` statements.

For example, to import nodes from another agency file:

```agency
import node { ingredients, steps } from "./recipe.agency"
```

If you use `import` instead of `import node`, the node won't get merged into the graph, which may be desirable if you want that node to be in a separate graph.

To import functions (tools) from another agency file:

```agency
import tool { fetchRecipe } from "./recipe.agency"
```

If you use `import` instead of `import tool`, you'll be able to use the imported function as a function but not as a tool.

If an agency file is going to be imported, don't define a `main` node because it will automatically be executed on import.

### Built-in functions
Agency has some built-in functions for common tasks:
- `print(value: any): void` - prints a value to the console
- `sleep(seconds: number): void` - pauses execution for a specified number of seconds
- `input(prompt: string): string` - prompts the user for input and returns their response
- `fetch(url: string): string` - makes an HTTP GET request to the specified URL and returns the response body as a string
- `fetchJson(url: string): any` - makes an HTTP GET request to the specified URL and returns the response body parsed as JSON
- `read(path: string): string` - reads the contents of a file at the specified path and returns it as a string
- `write(path: string, content: string): void` - writes the specified content to a file at the specified path
- `readImage(path: string): Image` - reads an image file at the specified path and returns it as an Image object

### Typescript interop

There's not much more that agency can do. It is intentionally bare-bones. However, it transpiles to TypeScript and has great interoperability with it. You can import TypeScript code. Any import statement you can use in ESM modules will work:

```agency
import { someFunction } from "./someModule.js"
import * as foo from "foo.js"
import bar from "bar.js"
```

For any logic that is more complex, implement it in a separate TypeScript file, then import the relevant functions into Agency and use them.

## Using your agent

You can either run an agency file directly, in which case you need to define a node named `main` that will get executed as the entry point to your agent, or you can import your agent into a TypeScript file. Here is an example of that:

```agency
// foo.agency
node foo() {
  name = input("> ")
  response = llm("Greet the person named ${name}")
  return response
}
```

Compile the agency file to TypeScript using `agency compile foo.agency`, which will generate a `foo.ts` file. Then import the generated TypeScript file:

```ts
import { foo } from "./foo.ts"

async function main() {
  const response = await foo()

  // response is a string containing the LLM's response
  console.log(response)
}
```

You can import any node defined in your agency file and call it like a function to run the graph with that node as the entrypoint. You can also import the graph object as the default import from the generated file.

```ts
import graph from "./foo.ts"
```

## Interrupts and Human-in-the-loop
Agency has support for interrupts, which you can use to implement a human-in-the-loop system. Interrupts are very simple to use and work quite well.

Here's an example. Suppose I have the following agency code:

```ts
import { readTodos } from "./tools.ts"

def readTodosTool(filename: string) {
  return readTodos(filename)
}

node todos(prompt: string) {
  +readTodosTool
  response = llm("Help the user with their todos: ${prompt}")
}

node foo() {
  prompt = input("> ")
  return todos(prompt)
}
```

Here is an example of me using this agent in a TypeScript file:

```ts
import { foo } from "./foo.ts"
async function main() {
  const response = await foo()
  console.log(response)
}
```

This is an agent that helps a user manage their todos. It includes a read todos tool that will read the user's todos from a given file. Suppose we want to insert an approval step, so that the agent confirms this action with the user before reading the file. Here is how you would do that.

```ts
def readTodosTool(filename: string) {
  // just add this line!
  return interrupt(`Read file ${filename}`)
  return readTodos(filename)
}
```

All we need to do is return an interrupt. Then, in your code that's using this agent, check for interrupts and respond to them:


```ts
import { foo, isInterrupt, approveInterrupt, rejectInterrupt } from "./foo.ts"
async function main() {
  const response = await foo()
  while (isInterrupt(response)) {
    // input is a function that gets user input from stdin
    const userResponse = input(`The agent is requesting an interrupt with message: "${response.data}". Do you approve? (yes/no)`)
    if (userResponse.toLowerCase() === "yes") {
      response = await approveInterrupt(response)
    } else {
      response = await rejectInterrupt(response)
    }
  }
}
```

We check if the agent returned an interrupt. If so, we ask the user whether they approve or not, and call `approveInterrupt` or `rejectInterrupt` accordingly. We wrap all of this in a `while` loop in case there are more interrupts.

That's it! Execution will pick up exactly where it left off, down to the statement. Nothing else for you to manage. You can have multiple interrupts, interrupts that are several layers deep in the call stack, etc. Agency will handle all of it for you. Magic!

If you want to approve the interrupt but pass in new arguments, use the `modifyInterrupt` function.

```ts
const response = await modifyInterrupt(interruptResponse, newArguments);
```


> Note: currently you have to return an interrupt from an Agency file. You can't return an interrupt from a TypeScript file, because Agency can't jump to a specific line in TypeScript code, but it can with Agency code.

> Note #2: if you have provided callbacks (for example, the onStream callback for streaming), you'll need to provide those as the last argument. We can serialize the state, but we can't serialize functions.


```ts
await approveInterrupt(response, { callbacks });
await rejectInterrupt(response, { callbacks });
await modifyInterrupt(interruptResponse, newArguments, { callbacks });
```

## Streaming

You can optionally stream responses from Agency by using the Stream keyword.

```agency
node foo() {
  response: string = stream llm("Tell me a joke and explain it")
  print(response)
  return response
}

Streaming only works when you run your agent from a TypeScript file and provide an `onStream` callback.

```ts
const callbacks = {
  onStream: (chunk: any) => {
    if (chunk.type === "text") {
      process.stdout.write(chunk.text);
    }
  },
};

async function main() {
  const resp = await foo({ callbacks });
  console.log({ resp });
}

main();
```

If you choose to use streaming, your agent will continue to function exactly as is, but will also stream the response to your callback. This means you can continue to use tools etc, and the rest of the code will flow exactly as is.

```agency
node foo() {
  response: string = stream llm("Tell me a joke and explain it")
  print(response) // the response variable will still be set to the full response once the stream is complete, so you can use it as normal
}
```

The returned chunks are of the `StreamChunk` type from the `smoltalk` package:

```ts
export type StreamChunk = {
    type: "text";
    text: string;
} | {
    type: "tool_call";
    toolCall: ToolCall;
} | {
    type: "done";

    // the complete result of the prompt,
    // as you would have received if you weren't streaming
    result: PromptResult;
} | {
    type: "error";
    error: string;
};
```

## Parallel calls
Where possible, Agency will try to run your code async, which often means llm calls will happen in parallel when possible. Let's look at some examples.

Both of these LLM calls can be run in parallel because they don't depend on each other.

```ts
node example() {
  // both should run in parallel
  fibs: number[] = llm("Get the first 10 Fibonacci numbers.")
  story: string = llm("Write a short story about a cat and a dog.")
  print(fibs)
  print(story)
}
```

story does not need to run at all since the value is never used.

```ts
node example() {
  fibs: number[] = llm("Get the first 10 Fibonacci numbers.")

  story: string = llm("Write a short story about a cat and a dog.")
  print(fibs)
}
```

`sum` can only run after `fibs` is done, since it depends on the value of `fibs`.
```ts
node example() {
  fibs: number[] = llm("Get the first 10 Fibonacci numbers.")
  // 
  sum: number = llm("Add up these numbers ${fibs}.")
  print(sum)
}
```

These two calls can't run in parallel because they might throw interrupts, and we can only handle one interrupt at a time.
```ts
def readFile(name: string) {
  return interrupt("Reading file ${name}")
  return "file contents"
}

node example() {
  uses readFile
  todos = llm("Get a list of todos from todos.json.")

  uses readFile
  reminders = llm("Get a list of reminders from reminders.json.")
}
```

```ts
def foo() {
  return llm("Say hi")
}

def bar() {
  return llm("Write a joke")
}

node example() {
  // These two calls can run in parallel:
  foo()
  bar()
}
```

```ts
sync def foo() {
  return llm("Say hi")
}

sync def bar() {
  return llm("Write a joke")
}

node example() {
  // These two calls WON'T run in parallel,
  // because the user specifically marked them as sync functions.
  foo()
  bar()
}
```

LLM calls inside `thread`s never run in parallel, because the message history accumulates. See below.
```ts
node example() {
  thread {
    fibs: number[] = llm("Get the first 10 Fibonacci numbers.")
    story: string = llm("Write a short story about a cat and a dog.")
  }
  print(fibs)
  print(story)
}
```

When calls run async, their value is `await`ed right before it is actually used.
```ts
node example() {
  fibs: number[] = llm("Get the first 10 Fibonacci numbers.")
  story: string = llm("Write a short story about a cat and a dog.")
  // Agency will add an await call here,
  // so that it waits for both fibs and story to be done before printing:
  print(fibs, story)
}
```

To see which calls will run in parallel, you can use the `graph` command in the Agency CLI.

Save this as `foo.agency`:
```ts
node main() {
  bar: string = stream llm("Define the word 'bar'.")
  thread {
    story: string = stream llm("Write a 100 word story about a cat and a dog.")
    fibs: number[] = stream llm("Get the first 10 Fibonacci numbers.")
  }
  print(bar)
  print(fibs, story)
}
```

Run:

```bash
agency graph foo.agency
```

Now move the llm calls outside of the thread and run the graph command again to see the difference!

## Message threads
Agency gives you a few ways to manage message history. By default, every LLM call will be isolated. That means these two calls won't share any history:

```ts
node main() {
  res1: number[] = llm("What are the first 5 prime numbers?")
  res2: number = llm("And what is the sum of those numbers?")
  print(res1, res2)
}
```

In fact, as you have just learned, Agency will run both of these calls in parallel, so the second one might actually finish before the first!
I ran it and got this output:

```
[ 2, 3, 5, 7, 11 ] 0
```

In this case, though, it makes sense that you would want to share history between them. How can you accomplish this? A simple way is to use a message thread:

```ts
node main() {
  thread {
    res1: number[] = llm("What are the first 5 prime numbers?")
    res2: number = llm("And what is the sum of those numbers?")
  }
  print(res1, res2)
}
```

The only change is that both calls are now in a `thread` block, but it now means they will run synchronously and share message history. Now when I run this code, I get this output

```
[ 2, 3, 5, 7, 11 ] 28
```

### Nested threads
You can also nest threads inside of each other. There are two ways to nest threads. Let's look at them both. To start, let's look at some code with a single thread block.

```ts
node main() {
  thread {
    res1: number[] = llm("What are the first 5 prime numbers?")
    res2: number = llm("And what is the sum of those numbers?")
    res3: number[] = llm("What are the next 2 prime numbers after those?")
    res4: number = llm("And what is the sum of all those numbers combined?")
    res5: number[] = llm("What are the next 2 integers after that?")
    res6: number = llm("And what is the sum of all those numbers combined?")
    res7: number = llm("What was that last number again?")
  }
  print("res1", res1)
  print("res2", res2)
  print("res3", res3)
  print("res4", res4)
  print("res5", res5)
  print("res6", res6)
  print("res7", res7)
}
```

This asks the LLM to get the first five prime numbers, and then repeatedly asks follow-up questions. In this case, all of these messages are part of a single message thread. Run this code, and you should see the following (comments by me):

```
res1 [ 2, 3, 5, 7, 11 ] // first 5 primes
res2 28 // summed
res3 [ 13, 17 ] // next 2 primes
res4 58 // summed
res5 [ 59, 60 ] // next 2 integers
res6 118 // summed (not correct, but close)
res7 118 // repeated
```

Even though the LLM got one of the answers wrong, it's clear that it is treating all of those messages as a single thread. Now, let's see what happens when we nest threads.

```ts
node main() {
  thread {
    res1: number[] = llm("What are the first 5 prime numbers?")
    res2: number = llm("And what is the sum of those numbers?")
    thread {
      res3: number[] = llm("What are the next 2 prime numbers after those?")
      res4: number = llm("And what is the sum of all those numbers combined?")
    }
    thread {
      res5: number[] = llm("What are the next 2 integers after that?")
      res6: number = llm("And what is the sum of all those numbers combined?")
    }
    res7: number = llm("What was that last number again?")
  }
  print("res1", res1)
  print("res2", res2)
  print("==========") // added for readability
  print("res3", res3)
  print("res4", res4)
  print("==========")
  print("res5", res5)
  print("res6", res6)
  print("==========")
  print("res7", res7)
}
```

Note that I'm printing some dividers so you can see exactly where the threads are being nested.
When you run this code, you should see output similar to this:

```
// same as before
res1 [ 2, 3, 5, 7, 11 ]
res2 28
==========
// not correct!
res3 [ 29, 31 ]
res4 160
==========
// not correct!
res5 [ 9, 10 ]
res6 36
==========
// this is the sum from the first thread
res7 28
```
Each thread creates a new message history. So the two nested threads have their own history, completely unconnected to the parent's history. When Agency executes this call, there is no previous message history:

```ts
res3: number[] = llm("What are the next 2 prime numbers after those?")
```

The LLM doesn't know what you mean by "next 2" because it doesn't know what prime numbers you've already seen. Similarly, when you ask for the sum of all those numbers, it doesn't know what came before the two prime numbers it's sent in this current thread, so the number it returns is completely made up.

After the two nested threads, there is a final call in the main thread.

```ts
res7: number = llm("What was that last number again?")
```

You can see it returns 28 because that was the last number in the main thread.

### subthreads

The other way to nest threads is with subthreads, using the `subthread` keyword. Here's what the code for that looks like.

```ts
node main() {
  thread {
    res1: number[] = llm("What are the first 5 prime numbers?")
    res2: number = llm("And what is the sum of those numbers?")
    subthread {
      res3: number[] = llm("What are the next 2 prime numbers after those?")
      res4: number = llm("And what is the sum of all those numbers combined?")
    }
    subthread {
      res5: number[] = llm("What are the next 2 integers after that?")
      res6: number = llm("And what is the sum of all those numbers combined?")
    }
    res7: number = llm("What was that last number again?")
  }
  print("res1", res1)
  print("res2", res2)
  print("==========")
  print("res3", res3)
  print("res4", res4)
  print("==========")
  print("res5", res5)
  print("res6", res6)
  print("==========")
  print("res7", res7)
}
```

When you run this code, you should see output similar to this:

```
res1 [ 2, 3, 5, 7, 11 ]
res2 28
==========
// next primes in the sequence
res3 [ 13, 17 ]
res4 58
==========
// next integers in the sequence
res5 [ 12, 13 ]
res6 41
==========
res7 28
```

Each subthread forks the message history of its parent thread. This means that if you have two sibling threads, they won't share history with each other, but they will both share history with their parent thread. You can see that the first subthread is correctly getting the next two prime numbers in the sequence, and the second subthread is correctly getting the next two integers in the sequence.

## A few notes on agent design

As you build more complex agents, a good way to design them is with a decision tree-style approach. Instead of having one big prompt, use several smaller prompts to categorize a user's message and then use the appropriate prompt. This should make your agent faster and more reliable. For example, suppose you are building an agent that a user can use to either report their mood or add an item to their to-do list.

Start with a node that classifies the user's intent:

```agency
node router(userMessage: string) {
  intent: "mood" | "todo" = `Classify the user's intent as either "mood" or "todo" based on the message: ${userMessage}`

  match(intent) {
    "mood" => return handleMood(userMessage)
    "todo" => return handleTodo(userMessage)
    _ => print("Unknown intent.")
  }
}
```

Then have separate nodes for handling each intent:

```agency
node handleMood(userMessage: string) {
  mood = `Extract the user's mood from the message: ${userMessage}`
  print(`User's mood is: ${mood}`)
}

node handleTodo(userMessage: string) {
  item = `Extract the to-do item from the message: ${userMessage}`
  print(`Adding to-do item: ${item}`)
}
```

### Multiple agency files

When you create multiple agency files and import nodes from one file into another, the nodes in all the files will get merged into a single graph. This means the node names must be unique across all files.

### Unsupported features
- else statements aren't supported yet -- use match statements with a default case instead
- loops aren't supported yet -- use recursion
- no higher order functions yet (e.g., `map`, `filter`, `reduce`, etc.) or lambda functions
- no infix operators yet (e.g., `+`, `-`, `*`, `/`, `&&`, `||`, `>=`, `<=`, `==`, `!=`, etc.)
- string interpolation is limited -- you can only interpolate variable names, not expressions.
