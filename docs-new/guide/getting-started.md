# Getting Started

Agency is a domain-specific language for defining AI agent workflows. It compiles Agency code to executable TypeScript that calls OpenAI's structured output API.

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
pnpm run agency hello.agency
```

Now read [Agency in Ten Minutes](./agency-in-ten-minutes.md) to learn more about the language and how to use it!