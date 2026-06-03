# Getting Started

Agency is a language for building agents that compiles to TypeScript.

## Installation

```bash
pnpm install agency-lang
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

The bundled agent's coding workflow skills (brainstorming, writing-plans, executing-plans, TDD, systematic debugging, verification-before-completion) are vendored from the [Superpowers](https://github.com/obra/superpowers) plugin by Jesse Vincent, used under the MIT license. See `lib/agents/agency-agent/skills/superpowers/ATTRIBUTION.txt`.

## License
MIT. See [LICENSE](./LICENSE).
