# The Agency Programming Language

Welcome! This guide will teach you all the major features of the Agency language, starting with the basics like syntax and how to execute an Agency program, and building up to more powerful features.

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

## Reading the guide

If you have never built agents before, start [here](./agents-101).

This guide is divided into three sections.
- **Basic** is all you need to know to get started with Agency. If all you want to do is play around and explore and build a couple of simple things, Basic is all you need. Basic will show you how to make some simple requests to an LLM and get some responses back.
- For anything but the most basic stuff, you'll want to check out the things in **Intermediate**. If you want to read and write files, for example, you'll want to read this section. Basic just makes it easy to get started, but the expectation is that most people will read through Intermediate.
- And finally, if you spend enough time building Agents, you'll start to ask yourself questions like, "can I run these two requests in parallel so the Agent responds faster?" Once you start asking these sorts of questions, Agency will be there to support you. You can go pretty deep into designing a sophisticated agent, and that's what the **Advanced** section is all about. Notice that "advanced" doesn't mean "hard"... it just means you don't need to know this stuff right away.

> A quick note before you start: since syntax highlighting libraries don't know about Agency, all the Agency code blocks are set to have the TypeScript as the language in order to get syntax highlighting. Just a heads up so you don't get confused if you see `ts` in the code block.
