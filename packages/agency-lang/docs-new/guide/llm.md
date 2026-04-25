
# LLM Calls

Agency provides a lot of functionality to make it easier to make LLM calls. Let's look at some of them. To make a basic LLM call, use the LLM built-in function.

```ts
const response = llm("What is the capital of France?")
print(response)
```

To specify a structured output, simply add a type annotation.

```ts
type Response = {
  capital: string
}
const response: Response = llm("What is the capital of France?")
print(response)
```

Any function defined in Agency can automatically be used as a tool for the LLM.

```ts
def add(a: number, b: number): number {
  return a + b
}

uses add
const result = llm("What is 4 + 5?")
print(result)
```

## Streaming

To stream your response back, you will need two things:
1. You will need to set the stream option on the LLM call to true.

```ts
const response = llm("What is the capital of France?", { stream: true })
```

2. You will need to provide an `onStream` callback function to handle the streamed data. Streaming only works when you use your agent through TypeScript or JavaScript, though hopefully this limitation will be resolved soon. When you call a node through TypeScript, provide the callbacks: 

```ts
const callbacks = {
  onStream: console.log
}

const result = await main("some-param", { callbacks })
```

## Other options to llm()

Agency uses the [Smoltalk library](https://github.com/egonSchiele/smoltalk) behind the scenes so any options you can pass into Smoltalk ([SmolConfig](https://github.com/egonSchiele/smoltalk#client-options-smolconfig) or [PromptConfig](https://github.com/egonSchiele/smoltalk#request-options-promptconfig)) you can pass in as part of the config object, which is the optional second parameter to the `llm` call.

## Interrupts
Any [interrupts](./interrupts) thrown in tools will just work with no extra work required.

## The `safe` keyword
LLMs are often flaky and it's possible that your LLM will call a tool incorrectly for some reason. If this happens, it's possible to get the LLM to retry the tool call.

Some functions are okay to retry and some aren't. If you have a function that has a side effect, like writing to a database

```ts
def writeToDatabase(data: string) {
  // code to write to database
}
```

and it is called as part of a tool call, you probably don't want the LLM to retry that tool call automatically. However, if you have a function that doesn't have any side effects

```ts
def add(a: number, b: number): number {
  return a + b
}
```

then the LLM can retry the tool call if it fails.

Agency provides functionality to conditionally let LLMs retry tool calls if they fail. Agency keeps track of what code was executed before the tool call failed, and based on that, whether it is okay to retry a tool call or not. This works by using the `safe` keyword. If a function is safe to retry, you can use the `safe` keyword to mark it safe. Let's see a real example.

```ts
def writeToDatabase(data: string) {
  // code to write to database
}

// safe to retry
safe def add(a: number, b: number): number {
  return a + b
}

def myTool() {
  const sum = add(4, 5)
  writeToDatabase(sum)
  print("Done!")
}
```

Suppose `myTool` fails while being called as a tool. If it fails after the call to add, we know it's safe to retry this tool call. 

```ts
def myTool() {
  const sum = add(4, 5)
  // if it fails here, we can retry
  writeToDatabase(sum)
  print("Done!")
}
```

However, if the tool call fails after writing to the database, then we can't retry this tool call.

```ts
def myTool() {
  const sum = add(4, 5)
  writeToDatabase(sum)
  // if it past this point, we can't retry
  // because we don't want to write to the database twice
  print("Done!")
}
```