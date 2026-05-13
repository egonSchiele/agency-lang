# Partial Application

## What is it?

Let's take a simple `readFile` function. Here is its function signature in three different languages, JavaScript, TypeScript and Agency:

```ts
// JavaScript
function readFile(dir, filename);

// TypeScript
function readFile(dir: string, filename: string): string;

// Agency
def readFile(dir: string, filename: string): string;
```

Now suppose you call this function with only one argument:

```ts
readFile("dirName")
```

What would happen? JavaScript allows you to call the function and the second argument is just `undefined`. TypeScript and Agency show a type error.

However! Agency has a special feature called **partial application** that does something neat.

## Basic usage

Use `.partial()`:

```ts
const readFromDir = readFile.partial(dir: "dirName")
```

`.partial()` creates a new function where the `dir` parameter is set to `"dirName"`. The new function only takes the remaining parameter `filename`:

```ts
readFromDir("file.txt") // calls readFile("dirName", "file.txt")
```

Partial application lets you make a new function where some of the arguments are already filled in. 

Partial function application is an old concept from functional languages. Why is it useful in agency? Is it just niche? No, it ends up having a pretty cool use case.

## Constraining LLM tools

Remember that every function is also a tool in Agency. Agency gives you a couple ways to make tool usage safe. One is interrupts, checking with the user before taking an action. Another one is PFA – partial function application.

If you give the readFile() function to an LLM call, all of a sudden it can read any file on your file system:

```ts
const result = llm("Read the config file", { tools: [readFile] })
```

You could make it safer by throwing an interrupt and checking with the user before you read any file, but you could also just limit what directories it can read from:

```ts
const readFromTemp = readFile.partial(dir: "/tmp")
const result = llm("Read the config file", { tools: [readFromTemp] })
```

Now the readFile function can only read the files in the `/tmp` directory!

PFAs are a really easy way to restrict the capabilities you provide to an LLM. The functions in the agency's standard library are written with PFA in mind. For example, `std::email` has several functions to send email. They have `allowList` and `blockList` parameters so that you can restrict who the LLM can send emails to.

Now obviously PFAs aren't magic. You as the function author need to make sure the restriction is actually obeyed. For example, if you wrote the readFile function in such a way that you just ignored the `dir` parameter, then the LLM could again read any file on your system. 

## Why not just use wrapper functions?

Why not just wrap the function call in another function call? This works fine:

```ts
function readFromTemp(filename: string): string {
  return readFile("/tmp", filename)
}
```

A couple of advantages to using PFAs:
1. You don't have to create wrappers for every possible iteration. PFAs are more flexible.
2. You don't have to copy over the function description into the wrapper.

When a tool gets sent to an LLM, we additionally send over a JSON schema containing the parameters and description of the tool. If you use a PFA, the function description from the original function will get sent, so you don't have to worry about adding a description to your wrapper function. If you mention any parameters in the function docstring, those parameters will get stripped from the docstring for you automatically, as long as you use the `@param name - description` format. Example:

```agency
def readFile(dir: string, filename: string): string {
  """
  Reads a file from the filesystem.
  @param dir - The directory to read from
  @param filename - The name of the file to read
  """
  // ...
}
```

When you use `.partial()`, any `@param` lines in the function's docstring for bound parameters are automatically stripped from the description the LLM sees.

If you write your functions well, users can use PFA to restrict its capabilities in all sorts of useful ways before handing the function to an agent.

## Custom descriptions with `.describe()`

Use `.describe()` to override the tool description that the LLM sees:

```ts
const add5 = add.partial(a: 5).describe("Adds 5 to any number")
```

## In pipes

Partial application works naturally with the [pipe operator](./error-handling):

```ts
def multiply(a: number, b: number): Result {
  return success(a * b)
}

def half(x: number): Result {
  return success(x / 2)
}

const result = success(10) |> half |> multiply.partial(a: 3)
```

The piped value fills the remaining unbound parameter.

## Auto-approving interrupts with `.preapprove()`

If you trust a function and want to auto-approve all its interrupts, use `.preapprove()`:

```ts
const tool = readFile.preapprove()
llm("Read the config", { tools: [tool] })
```

This is equivalent to wrapping every call in a handler that approves:

```ts
handle {
  readFile(filename)
} with (data) {
  return approve()
}
```

`.preapprove()` works on any function, not just PFAs, and chains with `.partial()` and `.describe()` in any order:

```ts
const safeTool = readFile.partial(dir: "/tmp").preapprove().describe("Read temp files")
```

Outer handlers still take precedence. If a handler further up the chain rejects the interrupt, it stays rejected — `.preapprove()` can't override an outer rejection. This follows the normal [handler rules](./handlers).

## Rules and restrictions

- You can only bind parameters by name: `fn.partial(x: 5)`, not by position.
- You cannot bind a parameter that is already bound.
- You cannot bind variadic parameters (`...args`).
