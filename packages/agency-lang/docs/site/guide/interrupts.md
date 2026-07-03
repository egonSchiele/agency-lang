---
name: Interrupts
description: Introduces Agency's interrupt feature for pausing execution and asking for user approval.
---

# Interrupts

Interrupts let you pause your code and ask for user approval.

```ts
def writeFile(filename: string, content: string) {
  raise interrupt(`Are you sure you want to write to this file?: ${filename}`)
  // write to file
}
```

A lot of functions in the Agency Standard Library raise interrupts, such as the `read` and `write` functions. Earlier, we had just auto-approved reading a file with the shorthand `with approve` syntax. Here's an example where we ask the user for approval instead.

```ts
node main() {
  handle {
    const results = read("./README.md")
    print(results)
  } with (data) {
    printJSON(data)
    const decision = input("Do you want to continue? (yes/no): ")
    if (decision == "yes") {
      return approve()
    }
    return reject()
  }
}
```

There's a couple new things here that we will discuss in detail, but here's a quick summary for now:
1. We wrap the code that could throw an interrupt inside a `handle` block.
2. If an interrupt is raised, we print it.
3. We ask for user input using the `input` function.
4. If the user approves, we return `approve`.
5. Otherwise, we return `reject`.

Now you might be thinking, "couldn't I just use the `input` function to ask the user for input directly?".

Or you might be thinking, "so the user has to approve every little action? That doesn't seem like a very good user experience."

We'll address both of these questions, but lets look at a couple more examples of interrupts first.

## Other ways to approve or reject interrupts

### Shorthand syntax

We had seen this earlier.

```ts
const results = read("./README.md") with approve
```

### Shorthand syntax with a block

```ts
handle {
  const results = read("./README.md")
  print(results)
} with approve
```

### Named function as handler

```ts
def handleInterrupt(data: any) {
  return approve()
}

handle {
  const results = read("./README.md")
  print(results)
} with handleInterrupt
```

## Asking for user input

You can also use interrupts to get user input:

```ts
def writeFile(content: string) {
  const filename = interrupt("Where do you want to write this content?")
  // write to file
}
```

Now when you call `approve`, pass in the filename as an argument:

```ts
handle {
  const filename = writeFile("Hello, world!")
  print(`Wrote to file: ${filename}`)
} with (data) {
  // filename = "myfile.txt"
  return approve("myfile.txt")
}
```

## Rejecting with a message

When you reject an interrupt, it gets rejected with a generic "interrupt rejected" error. You can reject with a specific message if you would like instead.

```ts
handle {
  const filename = writeFile("Hello, world!")
  print(`Wrote to file: ${filename}`)
} with (data) {
  return reject("Don't write any files to disk!")
}
```

## Interrupts in tool calls

Interrupts get raised in tool calls as well. This is what makes them such critical safety infrastructure. You remember that when we read a file, we approved our own read:

```ts
const result = read("./README.md") with approve
```

But suppose you passed the `read` and `write` functions to an LLM instead to use as tools:

```ts
const result = llm("summarize README.md", tools: [read, write])
```

You wouldn't want it to be able to read and write *any* file on your file system. With interrupts, it will need to ask you for permission before reading or writing any file.

All of these examples so far involve auto-approving or asking the user for input. Let's see other ways to make reads and writes safe without needing user input.