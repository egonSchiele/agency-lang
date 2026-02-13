# How to Write Agency Code

Act as an expert Agency language developer. When a user asks you to write Agency code, follow the rules, patterns, and examples in this document exactly. Agency is a domain-specific language that compiles to TypeScript for building AI agent workflows as graphs. See DOCS.md for the full language reference.

---

## Quick Reference

### Program Structure

An Agency program is made up of **nodes**, **functions**, **type definitions**, and **import statements** at the top level. Nodes define the graph; function calls between nodes define edges.

```agency
// imports go at the top
import { someHelper } from "./helper.ts"

// type definitions
type Recipe = {
  title: string;
  ingredients: string[];
  instructions: string
}

// function definitions
def greet(name: string): string {
  greeting = `Greet the person named ${name}`
  return greeting
}

// node definitions (these form the graph)
node main() {
  return router()
}

node router() {
  msg = input("> ")
  print(msg)
}
```

### Entry Point

If the file will be run directly (not imported), define a `node main()` as the entry point. If the file will be imported by another Agency file, do NOT define a `main` node.

---

## Nodes

Nodes are the building blocks of the graph. Define them with the `node` keyword. Calling one node from another creates a graph edge.

```agency
node greet() {
  print("Hello!")
}

node main() {
  // This call creates an edge from main -> greet
  return greet()
}
```

**Rules:**
- A call to another node should always use `return`. When following an edge from one node to another, execution never returns to the first node.
- Nodes can accept parameters: `node router(userMessage: string) { ... }`
- Node names must be unique across all Agency files that get merged into the same graph.

---

## LLM Calls

Use the `llm()` function to call an LLM. Always assign the result to a typed variable so the LLM knows what format to respond in.

```agency
// With llm() function (preferred)
response: string = llm("Say hi to me")
magicNumber: number = llm("Add 4 + 5")

// Legacy backtick syntax (also works)
greet = `Say hi to me`
```

### Type Hints for LLM Responses

Type hints tell the LLM what structured output format to use. Always provide a type hint for LLM calls.

```agency
// Primitives
name: string = llm("What is your name?")
count: number = llm("How many planets are there?")
isHappy: boolean = llm("Are you happy?")

// Union types (for classification)
intent: "mood" | "todo" = llm("Classify the user's intent: ${msg}")

// Arrays
items: string[] = llm("List 5 fruits")

// Objects (inline)
user: {name: string, age: number} = llm("Provide a user object")

// Named types (preferred for complex objects)
type User = {
  name: string # The user's full name
  age: number # The user's age in years
}
result: User = llm("Extract user info from: ${text}")
```

### Legacy Type Hint Syntax

You may also see the `::` syntax for type hints. This is equivalent to the colon syntax above:

```agency
name :: string
name = `What is your name?`
```

### Prompt Options

You can pass options to an LLM call using the `~` syntax:

```agency
result: string = llm("Tell me a joke") ~ { retries: 3 }
```

### Streaming

Use the `stream` keyword before `llm()` to enable streaming:

```agency
response: string = stream llm("Tell me a long story")
```

Streaming requires a TypeScript caller to provide an `onStream` callback.

---

## Type Definitions

Define reusable types with the `type` keyword. Use `#` comments to describe properties for the LLM.

```agency
type Recipe = {
  title: string # The name of the recipe
  ingredients: string[] # List of ingredients needed
  instructions: string # Step-by-step cooking instructions
}
```

**Rules:**
- You CANNOT use a type annotation when assigning a non-LLM value. `name: string = "hello"` will NOT work. Use `name = "hello"` instead.
- Type annotations on variables are ONLY for LLM calls, where they define the structured output format.

---

## Functions and Tools

Define functions with `def`. All functions can be used as tools for LLM calls.

```agency
def greet(name: string): string {
  greeting = `Greet the person named ${name}`
  return greeting
}
```

To make a function available as a tool in an LLM prompt, use `+functionName` before the LLM call:

```agency
node main() {
  +greet
  response: string = llm("Use the greet function to greet Alice")
}
```

You can also use docstrings to describe tools:

```agency
def getTopStories() {
  """
  Get today's top hacker news stories.
  """
  return fetch("https://hacker-news.firebaseio.com/v0/topstories.json")
}
```

### sync Functions

By default, function calls run async (in parallel when possible). Use `sync` to force sequential execution:

```agency
sync def foo() {
  return llm("Say hi")
}
```

---

## Control Flow

### if Statements

```agency
if (condition) {
  print("It's true")
}
```

Note: `else` is NOT supported. Use `match` with a default case instead.

### match Statements

```agency
status: "success" | "error" = llm("Did it work?")
match(status) {
  "success" => print("It worked!")
  "error" => print("Something went wrong")
  _ => print("Unknown status")
}
```

Use `_` as the default/wildcard case.

### while Loops

```agency
while (true) {
  msg = input("> ")
  print(msg)
}
```

---

## Message Threads

By default, each LLM call is isolated (no shared history). Use `thread` blocks to share message history between LLM calls:

```agency
node main() {
  thread {
    res1: number[] = llm("What are the first 5 prime numbers?")
    res2: number = llm("And what is the sum of those numbers?")
  }
  print(res1, res2)
}
```

LLM calls inside a `thread` always run sequentially (never in parallel).

### Subthreads

Use `subthread` to fork the parent's message history (the subthread inherits the parent's history but doesn't write back to it):

```agency
thread {
  res1 = llm("What are the first 5 primes?")
  subthread {
    // This sees res1's conversation history
    res2 = llm("What are the next 2 primes after those?")
  }
  // Back in parent thread, res2's messages are NOT visible here
  res3 = llm("What was the last number?") // sees only res1
}
```

---

## Imports

### Importing TypeScript

Any valid ESM import works:

```agency
import { someFunction } from "./someModule.ts"
import * as ext from "./hello.mjs"
```

### Importing Nodes from Another Agency File

Use `import node` to merge imported nodes into the current graph:

```agency
import node { ingredients, steps } from "./recipe.agency"
```

### Importing Tools from Another Agency File

Use `import tool` to make imported functions usable as tools:

```agency
import tool { fetchRecipe } from "./recipe.agency"
```

---

## Built-in Functions

- `print(value)` - Print to console
- `input(prompt: string): string` - Prompt user for input
- `sleep(seconds: number)` - Pause execution
- `fetch(url: string): string` - HTTP GET, returns body as string
- `fetchJson(url: string): any` - HTTP GET, returns parsed JSON
- `read(path: string): string` - Read a file
- `write(path: string, content: string)` - Write a file
- `readImage(path: string): Image` - Read an image file
- `exit(code: number)` - Exit the program

---

## Interrupts (Human-in-the-Loop)

Use `interrupt()` inside a function to pause execution and return control to the caller:

```agency
def readTodosTool(filename: string) {
  return interrupt("Read file ${filename}")
  return readTodos(filename)
}
```

The caller (in TypeScript) handles the interrupt with `isInterrupt`, `approveInterrupt`, `rejectInterrupt`, or `modifyInterrupt`.

---

## Unsupported Features

Do NOT use any of these in Agency code:
- `else` blocks (use `match` with `_` default instead)
- Infix operators (`+`, `-`, `*`, `/`, `&&`, `||`, `>=`, `==`, etc.)
- Higher-order functions (`map`, `filter`, `reduce`) or lambdas
- Complex expressions inside string interpolation (only variable names work: `${name}` is ok, `${a + b}` is NOT)
- Type annotations on non-LLM assignments

---

## Common Patterns

### Router Pattern (Decision Tree)

Classify user intent first, then route to specialized nodes:

```agency
node main() {
  msg = input("> ")
  return router(msg)
}

node router(userMessage: string) {
  intent: "mood" | "todo" | "quit" = llm("Classify the user's intent: ${userMessage}")
  match(intent) {
    "mood" => return handleMood(userMessage)
    "todo" => return handleTodo(userMessage)
    "quit" => print("Goodbye!")
    _ => print("Unknown intent.")
  }
}

node handleMood(userMessage: string) {
  mood: string = llm("Extract the user's mood from: ${userMessage}")
  print("User's mood is: ${mood}")
}

node handleTodo(userMessage: string) {
  item: string = llm("Extract the to-do item from: ${userMessage}")
  print("Adding to-do item: ${item}")
}
```

### REPL Pattern (Looping Agent)

Use a `while` loop for interactive agents:

```agency
node main() {
  while (true) {
    msg = input("> ")
    +someTool
    response: string = llm("Respond to: ${msg}")
    print(response)
  }
}
```

### Tool-Using Agent

Import TypeScript helpers, wrap them as Agency functions, then attach as tools:

```agency
import { getSummary } from "./wikipedia.ts"

def wikipediaSummary(page: string): string {
  """
  Fetches a summary for a given Wikipedia page
  """
  return getSummary(page)
}

node research(topic: string) {
  +wikipediaSummary
  answer: string = llm("Research this topic using Wikipedia: ${topic}")
  print(answer)
}
```

### Multi-Step Extraction

Chain LLM calls, using the output of one as input to the next:

```agency
type Url = {
  url: string # website url
}

type Recipe = {
  title: string;
  ingredients: string[];
  instructions: string
}

node importRecipe(msg) {
  url: Url = llm("Extract the URL from this message: ${msg}")
  html = fetch(url.url)
  recipe: Recipe = llm("Extract the recipe from this HTML: ${html}")
  print(recipe)
  return recipe
}
```

### Parallel LLM Calls

LLM calls that don't depend on each other run in parallel automatically:

```agency
node main() {
  // These run in parallel (no dependency between them)
  fibs: number[] = llm("Get the first 10 Fibonacci numbers")
  story: string = llm("Write a short story about a cat")
  print(fibs)
  print(story)
}
```

To force sequential execution, put them in a `thread` or use `sync` functions.
