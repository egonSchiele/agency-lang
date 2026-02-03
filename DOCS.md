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
When an agency file gets transpiled to TypeScript, all of the nodes and functions are available for import. You can import them like this:

```agency
// This imports the ingredients node
import { ingredients } from "./ingredients.agency"
```

and then simply call them as regular functions. If an agency file is going to be imported, don't define a `main` node because it will automatically be executed on import.

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

### A few notes on agent design

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

Each agency file represents one graph. If you split up your code into multiple files, you're creating multiple graphs. This may be a good way to organize your code.

### Unsupported features
- else statements aren't supported yet -- use match statements with a default case instead
- loops aren't supported yet -- use recursion
- no higher order functions yet (e.g., `map`, `filter`, `reduce`, etc.) or lambda functions
- no infix operators yet (e.g., `+`, `-`, `*`, `/`, `&&`, `||`, `>=`, `<=`, `==`, `!=`, etc.)
- string interpolation is limited -- you can only interpolate variable names, not expressions.
