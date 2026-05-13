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
  const filename = interrupt("Where do you want to write this content?")
  // write to file
}
```

Here, the user can choose to resolve the interrupt with a filename, or they can reject the interrupt. If they reject, the function will return immediately with a failure value.

You can use the `writefile` function directly or pass it as a tool to an LLM call, and either way the interrupt will be triggered.

## `interrupt()` function parameters

The first parameter of the interrupt function is the message you want to show the user. You can also return some data as the second parameter. The data must be an object.

```ts
def writeFile(filename: string, content: string) {
  const filename = interrupt(
    "Are you sure you want to write to this file?",
    { filename: filename }
  )
  // write to file
}
```

## Responding to interrupts in TypeScript

You can respond to interrupts either in TypeScript code or in Agency code. If you're running a website, and you want to show the user a dialogue asking them to respond to an interrupt, here is how you would do it.

```ts
// call the `main` node in typescript
const result = await main();

// check if the result is an interrupt
if (hasInterrupts(result.data)) {
  const responses = [];
  for (const interrupt of result.data) {
    console.log("Please respond to this interrupt: " + interrupt.message);

    // Pretend there's a getUserResponse function that gets a y/n
    // response from the user
    const userResponse = await getUserResponse(interrupt);

    if (userResponse === "y") {
      responses.push(approve());
    } else {
      responses.push(reject());
    }
  }
  // respond to the interrupts and get the final result
  // `respondToInterrupts` takes in the original interrupts and the responses
  // and returns `newResult` after resuming execution.
  // `newResult` could have interrupts too.
  const newResult = await respondToInterrupts(result.data, responses);
}
```

A couple callouts:

- Notice that in TypeScript, you get an array of interrupts. This is because Agency supports concurrent execution, and so you might have interrupts getting thrown from multiple threads.
- All interrupts have a standard format... more on this in the section on [structured interrupts](./structured-interrupts). This means all interrupts will have a message you can print for the user. If you pass in data to the interrupt, that will be at `result.data[0].data`.
- The responses are always in the same order as the interrupts, so you can just loop through them together and respond to each one.

To approve or reject, call the `approve()` or `reject()` functions. If you want to approve with a response – to respond with a filename for example:

```ts
def writeFile(content: string) {
  const filename = interrupt(`Where do you want to write this content?`)
  // write to file
}
```

 You can pass that response as an argument to `approve()`, like `approve("myfile.txt")`. If you want to reject, but give a reason for the rejection, you can pass that to the reject function as a string: `reject("I don't think it's safe to write to this file")`.

## Responding to interrupts in Agency

You can also respond to interrupts in Agency code. This is done using handlers, which have their own chapter! We'll talk about them in the next chapter.
