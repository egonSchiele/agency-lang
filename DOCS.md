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
  greet()
}
```

You can see that the `main` node is calling the `greet` node. This defines an edge between the two nodes. This is a core feature of Agency: allowing you to build up a graph without needing much boilerplate code. Simply define the nodes and call them as functions; the function call will define an edge.

If you plan to run this agency file as a script, you will need a node named `main`, which is the entry point of the script. If you plan to import it into another script instead, the `main` node is not required. More on importing later.

### LLM Calls
Any text between backticks, gets sent to an LLM. For example:

```agency
greet = `Say hi to me`
```

The text "Say hi to me" will be sent as a user message to the LLM, and the variable `greet` will be set to the LLM's response.

If you want to request a specific output format, use a type hint.

### Type Hints

```agency
greet :: number
greet = `add 4 + 5`
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
status :: "success" | "error"
status = `Respond with either "success" or "error"`
```

Array types. Example:

```agency
items :: string[]
items = `List 5 fruits`
```

Object types. Example:

```agency
user :: {name: string, age: number}
user = `Provide a user object with name and age`
```

You can define a new type:

```agency
type User = {
  name: string;
  age: number;
}
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
response :: string
+greet
response = `Use the greet function to greet Alice`
```

The `+greet` line tells Agency to make the `greet` function available as a tool in the LLM prompt.