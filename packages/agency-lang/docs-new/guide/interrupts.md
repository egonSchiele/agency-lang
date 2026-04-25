# Interrupts

Interrupts are a core feature in Agency. They allow you to pause execution at any step and ask the user for input. I think it's fair to say that Agency does interrupts better than any other library. Most libraries, if they offer interrupts, can only resume execution from the start of the function where the interrupt was defined, but Agency can resume execution from the exact point that we left off. Interrupts work inside if statements, inside loops, inside tool calls. They are a very powerful feature and they're also very easy to use.

Here is what an interrupt looks like.

```ts
def writeFile(filename: string, content: string) {
  return interrupt(`Are you sure you want to write to this file?: ${filename}`)
  // write to file
}
```

Before writing to this file, this function will now first confirm with the user. If the user approves, the rest of the function will continue. If the user rejects, then the function will exit immediately with a `failure` [Result value](./error-handling).

You can also use interrupts to ask the user for data:

```ts
def writeFile(content: string) {
  const filename = interrupt(`Where do you want to write this content?`)
  // write to file
}
```

Here, the user can choose to resolve the interrupt with a filename, or they can reject the interrupt, in which case the function will return immediately with a failure value. 

You can use the `writefile` function directly or pass it as a tool to an LLM call, and either way the interrupt will be triggered. Interrupts are a powerful feature, and they're especially good when combined with handlers. Let's look at handlers next.