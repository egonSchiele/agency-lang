Agency is a language for creating agents. It has language-level support for LLM features and allows you to quickly create an agent, defined as a graph.

## Core concepts
### Nodes
A node is a basic building block in Agency. You define a node like this:

```ts
node greet() {
  print("hi!");
}
```

Here are two nodes:

```ts
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

```ts
response: string = llm(`Say hi to me`)
magicNumber: number = llm(`Add 4 + 5`)
```

If you want to request a specific output format, use a type hint.


### Type Hints

```ts
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

```ts
status: "success" | "error" = llm("Respond with either 'success' or 'error'")
```

Array types. Example:

```ts
items: string[] = llm("List 5 fruits")
```

Object types. Example:

```ts
user: {name: string, age: number} = llm("Provide a user object with name and age")
```

You can define a new type:

```ts
type User = {
  name: string;
  age: number;
}
```

You can describe a property on an object for the LLM:

```ts
type User = {
  name: string # The name of the user
  age: number # The age of the user
}
```

### Functions / tools

Here is an example of a function in Agency:

```ts
def greet(name: string): string {
  greeting = `Greet the person named ${name}`
  return greeting
}
```

All functions in Agency can automatically be used as tools. For example, you can now use the `greet` function as a tool in a prompt.

```ts
use greet
response: string = `Use the greet function to greet Alice`
```

The `use greet` line tells Agency to make the `greet` function available as a tool in the LLM prompt.

### Control Flow

Agency supports `if` statements and `match` statements for control flow.
Here is an example of an `if` statement:

```ts
condition = false
if (condition) {
  print("You are an adult.")
}
```

Here is an example of a `match` statement:

```ts
status = "success"
match(status) {
  "success" => print("Operation was successful.")
  "error" => print("There was an error.")
  _ => print("Unknown status.")
}
```

Agency also supports `while` loops:

```ts
condition = true
while (condition) {
  print(count)
  condition = false
}
```

## Message threads
By default, every LLM call will be isolated. That means these two calls won't share any history:

```ts
node main() {
  res1: number[] = llm("What are the first 5 prime numbers?")
  res2: number = llm("And what is the sum of those numbers?")
  print(res1, res2)
}
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
You can also nest threads inside of each other. There are two ways to nest threads. Let's look at them both

### Nested threads with `thread`

```ts
node main() {
  thread {
    res1: number[] = llm("What are the first 5 prime numbers?")
    res2: number = llm("And what is the sum of those numbers?")
    thread {
      res3: number[] = llm("What are the next 2 prime numbers after those?")
      res4: number = llm("And what is the sum of all those numbers combined?")
    }
  }
}
```

Each thread creates a new message history. So the nested thread has its own history, completely unconnected to the parent's history. When Agency executes this call, there is no previous message history:

```ts
res3: number[] = llm("What are the next 2 prime numbers after those?")
```

The LLM doesn't know what you mean by "next 2" because it doesn't know what prime numbers you've already seen. 

### Nested threads with `subthread`

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
  }
}
```

Each subthread forks the message history of its parent thread. This means that if you have two sibling threads, they won't share history with each other, but they will both share history with their parent thread.