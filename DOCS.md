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
