# Getting Started

Agency is a language for building agents that compiles to TypeScript.

## Installation

```bash
npm install agency-lang zod
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
pnpm run agency hello.agency
```

Next, you should check out the [basic syntax](./basic-syntax.html) and tour the [features](/features/intro.html) that make Agency great for building agents.