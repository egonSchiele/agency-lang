---
name: The Agency Programming Language
description: Introduction to the Agency language guide, covering installation, a quick "hello world" example, and how to navigate the rest of the documentation.
---

# The Agency Programming Language

Welcome! This guide will teach you all the major features of the Agency language, starting with basic syntax and  building up to more powerful features.

## Installation

```bash
npm install agency-lang
```

## Quick Start

Create a file called `hello.agency`:

```ts
node main() {
  const greeting = llm("Say hello to the world!");
  print(greeting);
}
```

Compile and run it:

```bash
npx agency hello.agency
```

Now you're ready to get started! Read [basic syntax](basic-syntax.md) next.

> A quick note before you start: Since Agency is a new language, syntax highlighters don't know how to highlight it. That's why all the code blocks have "TypeScript" set as the language. Don't get confused if you see "ts", it's still Agency code.