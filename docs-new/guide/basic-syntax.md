# Agency in Ten Minutes

Hello and welcome! Agency is a language for building agents, or any other type of system that is complex, hard to debug, and involves non-deterministic outputs. In this quick intro we'll cover some common problems while writing agents, and how Agency solves those problems.

Let's take two minutes to quickly cover installation and syntax.

Installation:

```
npm i agency-lang
```

Okay, that was easy. Now syntax.

Agency is a language that compiles down to TypeScript or JavaScript. It borrows its syntax from these languages, if you have used either JS or TS before, a lot of Agency will be familiar to you.

You've got primitives: strings, numbers, booleans:

```ts
const name: string = "Alice"
const age: number = 30
const isAgent: boolean = true
```

You can define variables with `let` or `const`. You can add type annotations, just like TypeScript.

You can define arrays and objects:

```ts
const names: string[] = ["Alice", "Bob", "Charlie"]
const person: { name: string, age: number } = { name: "Alice", age: 30 }
```

You can define functions:

```ts
def greet(name: string): string {
  return `Hello, ${name}!`
}
```

You can use if statements, while loops and for loops:

```ts
if (age > 18) {
  print("You are an adult.")
} else {
  print("You are a minor.")
}

while (age < 100) {
  print(`You are ${age} years old.`)
  age = age + 1
}

for (const name of names) {
  print(name)
}
```

So far so good. Now let's talk about what problems Agency is designed to solve, and how it solves them.

Before that though, we need to quickly cover nodes. We won't spend a ton of time on nodes right now, but you should know that a node defines an entry point into your agent. You'll need a node to write a hello world script, like this:

```ts
node main() {
  const greeting = llm("Say hello to world!")
  print(greeting)
}
```

If you're coming from Python, you might be familiar with the `if __name__ == "__main__"` pattern...`node main` is the same thing in Agency.

Save the "Hello World" code in `test.agency`, and then run:

```
npm run agency test.agency
```

You should see a hello world message get printed.

> If you get an error, make sure you have your OpenAI API key set up correctly. You can set it as an environment variable called `OPENAI_API_KEY`, or you can create a `.env` file in the root of your project with the line `OPENAI_API_KEY=your_api_key_here`. Or just remove the `llm` call and replace it with a string, like `const greeting = "Hello, World!"` for now.

Now we're ready to dive into the more exciting features of the Agency.