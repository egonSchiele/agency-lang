# Getting Started

Agency is a language for building agents that compiles to TypeScript.

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

Now read [the docs](https://agency-lang.com) to learn more about the language and how to use it!

## Attributions

Weather data in the standard library (`std::weather`) is provided by [Open-Meteo](https://open-meteo.com/). Data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free API is for non-commercial use only; commercial use requires a [paid subscription](https://open-meteo.com/en/pricing).

## License
[FSL](https://fsl.software).