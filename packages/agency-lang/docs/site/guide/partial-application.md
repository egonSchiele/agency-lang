---
name: Partial Function Application
description: Explains Agency's `.partial()` method for creating new functions with some parameters pre-filled.
---

# Partial Function Application (PFA)

Partial function application, or PFA, is another way to make it safe to read and write files. Here's how it works. The `read` function has this signature.

```ts
read(filename: string, dir: string): Result
```

Instead of calling this function, I can choose to just lock one of its parameters.

```ts
const readFromTmp = readFile.partial(dir: "/tmp")
```

`readFromTmp` is now a new function that only takes the `filename` parameter. The `dir` parameter is locked to `"/tmp"`, so it can only read files from `"/tmp"`. 

Now I can give this function to an LLM, and it will only be able read files from the `/tmp` directory! Partial application lets you make a new function where some of the arguments are already filled in. 

Things to note:
- You use `.partial()` for PFAs.
- You *have* to specify named args. You can't use positional args, like `readFile.partial("/tmp")`. You have to use `readFile.partial(dir: "/tmp")`.

## Preapprove

`readFromTmp` will still raise an interrupt. You have three options:

- You could continue asking for user approval
- You could use the `with approve` shorthand syntax and auto-approve, since now it can only read from the `/tmp` directory.
- You could preapprove all interrupts for this function using `.preapprove()`:

```ts
const readFromTmp = readFile.partial(dir: "/tmp").preapprove()
```

`.preapprove()` is a method that you can call on any function, not just PFAs. It will return a new function, with all interrupts raised by that function automatically approved.

## Docstrings and JSON schemas

When we send a tool to an LLM, we're really sending some information:
- what parameters to call this tool with
- what this tool returns
- an optional tool description, which is the docstring.

If you use PFA to lock one of the arguments, it won't be sent to the LLM. With our `read` function, if we send the `read` function directly, the LLM will know it has to pass in two arguments, the file name and the directory name. But if we send `readFromTmp`, it will only know to pass in the file name. It won't even know that the directory parameter existed.

But what if your docstring talks about the directory parameter? If you mention any parameters in the function docstring, those parameters will get stripped from the docstring for you automatically, as long as you use the `@param name - description` format. Example:

```agency
def readFile(filename: string, dir: string): string {
  """
  Reads a file from the filesystem.
  @param filename - The name of the file to read
  @param dir - The directory to read from
  """
  // ...
}
```

When you use `.partial()`, any `@param` lines in the function's docstring for bound parameters are automatically stripped.

### Custom descriptions with `.describe()`

If you want to override the docstring completely, use `.describe()`:

```ts
const add5 = add.partial(a: 5).describe("Adds 5 to any number")
```

## Renaming tools with `.rename()`

`.partial()` and `.describe()` keep the original function's **name**. That
matters when you pass several derived copies of one function to the same
`llm(...)` call:

```ts
const readFromTmp = readFile.partial(dir: "/tmp")
const readFromHome = readFile.partial(dir: "/home")
const result = llm("read some files", { tools: [readFromTmp, readFromHome] })
```

Here, the LLM will see the same name for both `readFromTmp` and `readFromHome` – `readFile`. Each tool must have a unique name. Use `.rename()` to give each tool a unique name:

```ts
const readFromTmp = readFile.partial(dir: "/tmp").rename("readFromTmp")
const readFromHome = readFile.partial(dir: "/home").rename("readFromHome")
```

If you write your functions well, users can use PFA to restrict its capabilities in all sorts of useful ways before handing the function to an agent.

For example, the standard library has [functions for sending email](/stdlib/messaging/email.html#sendwithresend), and they have allowList and blockList parameters that you can use to set who the LLM can send the email to.

