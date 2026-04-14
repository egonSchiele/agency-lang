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

Now read [the docs](https://agency-lang.com) to learn more about the language and how to use it!

## License
[FSL](https://fsl.software).