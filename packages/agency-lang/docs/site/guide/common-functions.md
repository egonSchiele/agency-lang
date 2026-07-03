---
name: Common functions
description: How to use common functions in Agency, such as printing, getting user input, and reading/writing files.
---

# Common functions

## Printing stuff

Use the `print` function to print stuff to the console:

```ts
print("Hello, world!")
```

## Getting user input

Use the `input` function to get user input:

```ts
const name = input("What is your name?")
print(`Hello, ${name}!`)
```

## Reading and writing files

You can read and write files using the `read` and `write` functions. For example:

```ts
const content = read("file.txt") with approve
write("file.txt", "Hello, world!") with approve
```

These functions raise interrupts, which is why you need to append `with approve` to the calls. We will cover [interrupts](/guide/interrupts) and [handlers](/guide/handlers) in future sections.

There's also `readBinary` and `writeBinary` for reading and writing binary files.