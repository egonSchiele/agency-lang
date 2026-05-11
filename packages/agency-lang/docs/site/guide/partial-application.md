# Partial Application

Partial application lets you bind some arguments to a function, producing a new function that takes fewer arguments. This is useful for constraining what an LLM can do with a tool, or for creating specialized versions of general functions.

## Basic usage

Use `.partial()` with named arguments to bind parameters:

```ts
def add(a: number, b: number): number {
  return a + b
}

const add5 = add.partial(a: 5)
// add5 now only takes `b`
const result = add5(7)
// result is 12
```

The returned value is a new function. The original function is not modified.

## Chaining

You can chain multiple `.partial()` calls to bind parameters one at a time:

```ts
def deploy(project: string, env: string, action: string): string {
  return "${project}/${env}/${action}"
}

const deployMyApp = deploy.partial(project: "myapp")
const deployMyAppProd = deployMyApp.partial(env: "prod")
const result = deployMyAppProd("migrate")
// result is "myapp/prod/migrate"
```

## Constraining LLM tools

Since every function in Agency is also a tool, partial application is a way to constrain what the LLM can do. Suppose you have a file reader:

```ts
def readFile(dir: string, filename: string): string {
  // reads a file from the given directory
}
```

You want the LLM to be able to read files, but only from a specific directory. Bind the `dir` parameter:

```ts
node main() {
  const readFromSafe = readFile.partial(dir: "/safe")
  const result = llm("Read the config file", { tools: [readFromSafe] })
  return result
}
```

The LLM only sees a tool that takes `filename` — it cannot choose the directory. The bound parameter is completely hidden from the tool schema.

## Custom descriptions with `.describe()`

Use `.describe()` to override the tool description that the LLM sees:

```ts
const add5 = add.partial(a: 5).describe("Adds 5 to any number")
```

When you use `.partial()`, any `@param` lines in the function's docstring for bound parameters are automatically stripped from the description the LLM sees. Using the `@param name - description` format in your docstrings enables this:

```ts
"""
Reads a file from the filesystem.
@param dir - The directory to read from
@param filename - The name of the file to read
"""
def readFile(dir: string, filename: string): string {
  // ...
}

const readFromSafe = readFile.partial(dir: "/safe")
// LLM sees: "Reads a file from the filesystem.\n@param filename - The name of the file to read"
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

## Rules and restrictions

- You can only bind parameters by name: `fn.partial(x: 5)`, not by position.
- You cannot bind a parameter that is already bound.
- You cannot bind variadic parameters (`...args`).
- `.partial()` with no arguments returns the same function unchanged.
- `.describe()` takes exactly one string argument.

## Interrupts

Partially applied functions survive [interrupts](./interrupts). If a partially applied function triggers an interrupt (or is used as a tool in a call that triggers one), all bound values are preserved through the interrupt cycle.
