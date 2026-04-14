# The Agency Programming Language

Welcome! This guide will teach you all the major features of the Agency language, starting with the basics like syntax and how to execute an Agency program, and building up to more powerful features.

A quick note before you start: since syntax highlighting libraries don't know about Agency, all the Agency code blocks are set to have the TypeScript as the language in order to get syntax highlighting. Just a heads up so you don't get confused if you see `ts` in the code block.

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