Agency is a language for building agents. Here are a couple short examples to help you get started, followed by a walkthrough of its main features.

## LLM Calls

You can make an LLM call in agency using the built-in LLM function. Here's an example:

```
node main() {
  const greeting = llm("Say hello to the world!");
  print(greeting);
}
```

You can request structured output from the LLM call simply by adding a type to the variable like so:

```
type Mood = "happy" | "sad"

node main() {
  const msg = "I feel great!"
  const prompt = "Please categorize the following message: ${msg}"
  const mood: Mood = llm(prompt)
  print(mood);
}
```

The agency language is very similar to TypeScript, and it's type system is similar as well, but not as powerful.

You can also pass tools to the LLM prompt. Here is an example where I pass in the built-in read and write functions to the LLM:

```
const result = llm("Read and summarize README.md", tools: [read, write])
```

Any agency function can be used as a tool. Here's an example where I define an `add` function and then pass it to the LLM. Tools can have doc strings just like in Python and the doc string is used as the tool description:

```
def add(a: number, b: number): number {
"""
Adds two numbers together.

@param a - first number
@param b - second number
"""
  return a + b
}

node main() {
  const result = llm("Use the add tool to add 3 and 5.", tools: [add])
}
```

There are also hosted tools, which are tools hosted by the LLM providers themselves. The most common one you will use is web search if it is available – not every provider supports it. You can specify hosted tools like this:

```
const result = llm("Get the latest news for Minnesota.", hostedTools: ["web_search"])
```

Some other options you can pass to the LLM function are model, provider, maxTokens, reasoningEffort, and thinking. You can also pass in a `timeout` and `retries` (a number). You don't need to pass an API key as that is read as an environment variable.

## Functions and nodes

Notice that agency has functions and nodes. They are both similar with a few important differences. A node is like a node in a state machine. It represents a permanent transition. If you run an agency script from the command line, the `main` node is what gets executed. In most programs you write, you will just have a main node and then functions for everything else.

# Basic syntax

A lot of Agency syntax is borrowed from TypeScript and Python. If you have used these languages, the code should look similar.

## Primitives and variables

You've got primitives: strings, numbers, booleans:

```ts
const name: string = "Alice";
const age: number = 30;
const isAgent: boolean = true;
```

You can define variables with `let` or `const`.

You can use double quotes, single quotes, or backticks for strings. All three allow string interpolation with `${...}`:

```ts
const name = "Alice";
const greeting1 = "Hello, ${name}!";
const greeting2 = "Hello, ${name}!";
const greeting3 = `Hello, ${name}!`;
```

To write a literal `${` without starting an interpolation, escape it as `\${`. This works in every string kind, including triple-quoted strings:

```ts
const price = "costs \${5}" // -> costs ${5}
const template = """let x = \${y}""" // -> let x = ${y} (useful for embedding code)
```

Multi-line strings use `"""` triple-quotes. They **also** support `${...}` interpolation, but otherwise do **not** interpret backslash escapes — `\n` is a backslash followed by an `n`, not a newline. The one exception is `\${`, which escapes an interpolation as shown above:

```ts
const block = """
 ${name} on the first line\n
 literal \${skip} on the second
"""
```

## Arrays and objects

You can define arrays and objects:

```ts
const names = ["Alice", "Bob", "Charlie"];
const person = { name: "Alice", age: 30 };
```

## If statements

```ts
if (age > 18) {
  print("You are an adult.");
} else if (age == 18) {
  print("You are exactly 18 years old.");
} else {
  print("You are a minor.");
}
```

Agency has no ternary (`? :`). Instead, `if ... then ... else` can be used as a
value when assigning to a variable or in a `return`:

```ts
const label = if isProd then "Production" else "Local"

def describe(n: number): string {
 return if n > 100 then "big" else "small"
}
```

The `else` is required (the expression always produces a value). Like `match`
expressions, an `if` expression is only allowed as a `const`/`let` value or a
`return` — not nested inside another value such as an object field or an
argument. To keep them readable they are also deliberately flat: no `else if`,
and a branch cannot itself be an `if ... then ... else`. For more than two cases,
or nested conditions, use [`match`](/guide/pattern-matching).

## Match expressions

```ts
const area = match(shape) {
 { type: "circle", radius } => 3.14 * radius * radius
 { type: "square", side } => side * side
}
```

Match expressions are like switch statements, but more powerful: they have exhaustiveness checking and great support for pattern matching.

Guards on match blocks:

```agency
match (request) {
    { kind: "user", age } if (age >= 18) => allow()
    { kind: "user" }                     => block()
    _                                    => unknown()
}
```

An arm whose value is an object needs parentheses around it. Without them, the `{` opens a block:

```ts
const reply = match (result) {
  success(value) => ({ ok: true, value: value })
  failure(error) => ({ ok: false, error: error })
}
```

A `return` inside an arm gives the arm its value. It does not return from the function. To return what a match produces, put `return` in front of the match:

```ts
def describe(result: Result<number, string>): string {
  return match (result) {
    success(value) => "got ${value}"
    failure(error) => "failed: ${error}"
  }
}
```

## Type annotations

You can add type annotations, just like TypeScript.

```ts
const name: string = "Alice";
const age: number = 30;
const names: string[] = ["Alice", "Bob", "Charlie"];
```

Types are covered in more detail in the [section on types](/guide/types).

## Loops

While loop:

```ts
while (age < 100) {
  print(`You are ${age} years old.`);
  age = age + 1;
}
```

For loop:

```ts
const names = ["Alice", "Bob", "Charlie"]
for (name in names) {
 print(name)
}

// or with index:
for (name, i in names) {
 print(`Person ${i}: ${name}`)
}
```

For loop with objects:

```ts
const person = { name: "Alice", age: 30 }
for (key, value in person) {
 print(`${key}: ${value}`)
}

// or just the key:
for (key in person) {
 print(`${key}: ${person[key]}`)
}
```

The second loop variable depends on what you're iterating: for an array it's
the numeric **index**, and for an object it's the **value** at that key.

For loops can also destructure arrays and objects:

```ts
const people = [
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 },
];
for ({ name, age } in people) {
  print(`${name} is ${age} years old.`);
}
```

## List comprehensions

Agency also supports Python-style list comprehensions:

```ts
const doubled = [x * 2 for x in numbers]
const bigNames = [name for name in names if name.length > 5]
```

## Comments

You can have single-line or multi-line comments.

```ts
// This is a single-line comment
/*
This is a multi-line comment
*/
```

Or doc comments for documentation generation:

```ts
/** This is a doc comment for the Person type */
type Person = {
  name: string;
  age: number;
};
```

Doc comments are wrapped in `/** ... */` and must be on their own line. They can be used to document types, functions, and variables. Doc comments support Markdown formatting.

A comment can also end a line of code:

```ts
const x = 5; // this is a comment
```

## Functions

You can define functions:

```ts
def greet(name: string): string {
 return `Hello, ${name}!`
}
```

### Named arguments

You can call functions with named arguments:

```ts
def greet(name: string, greeting: string = "Hello"): string {
 return `${greeting}, ${name}!`
}

greet(name: "Adit")
```

Functions can have default arguments:

```ts
def round(num: number, precision: number = 0): number
```

Optional arguments:

```ts
def greet(name: string, greeting?: string): string
```

And variadic arguments:

```ts
def print(...messages: string[]): void
```

## Blocks

Although Agency doesn't have lambdas the way JavaScript does, it has a similar feature called blocks. You can use this to define functions that take another function. For example, let's use Agency's built-in map function, which takes a block:

```ts
const numbers = [1, 2, 3, 4, 5]
const squares = map(numbers) as n {
 return n * n
}
```

There are also inline blocks:

```ts
const numbers = [1, 2, 3, 4, 5]
const squares = map(numbers, \n -> n * n)
```

## Writing functions that take blocks

```ts
def callMe(block: (any) -> any) {
 return block()
}
```

## Limitations of blocks

### Don't assign the block to another variable

```ts
def foo(block: () => any) {
 let saved = block
 doSomething()
 let result = saved()
}
```

### Don't return the block from a function

```ts
def foo(block: () => any) {
 // don't do this
 return block
}
```

## Regexes

Regexes are also supported as a primitive:

```ts
// you must use the `re` prefix:
const regex = re/(foo|bar)/

// Use the =~ operator to test if a string matches a regex:
if (name =~ re/^A/) {
 print("Your name starts with A!")
}

// or !~ to test if it doesn't match:
if (str !~ regex) {
 print("The string does not match the regex.")
}
```

## Array slice syntax

Python-style array slice syntax is supported:

```ts
let arr = [1, 2, 3, 4, 5]

// sliced is [2, 3, 4]
const sliced = arr[1:4]

// slicedToEnd is [3, 4, 5]
const slicedToEnd = arr[2:]

// slicedFromStart is [1, 2, 3]
const slicedFromStart = arr[:3]

// negativeSlice is [3, 4]
const negativeSlice = arr[-3:-1]

// arr is now [10, 20, 30, 4, 5]
arr[:3] = [10, 20, 30]
```

## Unit literals

Agency supports unit literals for time, cost, and size values. They compile to plain numbers at compile time:

```ts
// time
const timeout = 30s // compiles to 30000 (milliseconds)
const delay = 500ms // compiles to 500
const duration = 2h // compiles to 7200000
const week = 1w // compiles to 604800000

// cost
const budget = $5.00 // compiles to 5.00

// size
const size = 100KB // compiles to bytes
const mediumSize = 500MB // compiles to bytes
const bigSize = 2GB // compiles to bytes
```

Supported time units: `ms` (milliseconds), `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks). All time units normalize to milliseconds.

Supported cost units: `$` (dollars).

Supported size units: `kb` (kilobytes), `mb` (megabytes), `gb` (gigabytes). Case insensitive. All size units normalize to bytes.

Unit math works:

```ts
1s + 500ms // 1000 + 500 = 1500
2s * 3 // 2000 * 3 = 6000
if (elapsed > 30s) { ... }
```

## Destructuring and pattern matching

Array and object destructuring work in `let` / `const` declarations and
in `for` loops:

```ts
let [a, b, ...rest] = items
let { name, age } = person
for ({ name, age } in users) { ... }
```

Pattern matching is covered in the [section on pattern matching](/guide/pattern-matching).

## Reserved names

Variables and functions beginning with two underscores (`__name`) are reserved for the compiler and runtime, so you cannot use them in your code.

## JavaScript features that don't exist in Agency

- Lambdas.
- Async/await. Everything is awaited by default, and there are specific constructs for concurrency.
- Classes.

## Imports

## Agency imports

Agency imports work just like JavaScript imports.

```ts
// default import
import foo from "./foo.agency";

// named import
import { foo } from "./foo.agency";

// alias import
import { foo as bar } from "./foo.agency";

// namespace import
import * as foo from "./foo.agency";

// mixed
import foo, { bar } from "./foo.agency";
import foo, * as bar from "./foo.agency";
```

## TypeScript imports

You can import TypeScript and JavaScript code the same way.

```ts
import foo from "./foo.js";
import { foo } from "./foo.js";
import { foo as bar } from "./foo.js";
import * as foo from "./foo.js";
```

Always use the `.js` extension, even if you are importing TypeScript code.

## Standard library imports

Agency also has a standard library. You can import from the standard library using the `std::` prefix.

```ts
import { bash } from "std::shell";
```

You can export stuff using `export`. What you can export

- Nodes
- Functions
- Types
- `static const` constants

## Common functions

Use the `print` function to print stuff to the console:

```ts
print("Hello, world!");
```

Use the `input` function to get user input:

```ts
const name = input("What is your name?");
print(`Hello, ${name}!`);
```

You can read and write files using the `read` and `write` functions. For example:

```ts
const content = read("file.txt") catch "" with approve
write("file.txt", "Hello, world!") with approve
```

`read` returns a `Result`, not a string. `catch ""` unwraps it, giving `""` if the read failed. Write `catch` before `with approve`. To handle the failure yourself, keep the Result and match on it:

```ts
const loaded = read("file.txt") with approve
if (loaded is success(text)) {
 print(text)
}
if (loaded is failure(error)) {
 print("Could not read the file: ${error}")
}
```

These functions raise interrupts and so we have to approve them using with approve. Let's talk about interrupts next.

## Interrupts

Interrupts are a core feature of agency.

Interrupts let you pause your code and ask for user approval.

```ts
def writeFile(filename: string, content: string) {
 raise interrupt(`Are you sure you want to write to this file?: ${filename}`)
 // write to file
}
```

A lot of functions in the Agency Standard Library raise interrupts, such as the `read` and `write` functions.

## Asking for user input

You can also use interrupts to get user input:

```ts
def writeFile(content: string) {
 const filename = interrupt("Where do you want to write this content?")
 // write to file
}
```

Now when you call `approve`, pass in the filename as an argument:

```ts
handle {
 const filename = writeFile("Hello, world!")
 print(`Wrote to file: ${filename}`)
} with (data) {
 // filename = "myfile.txt"
 return approve("myfile.txt")
}
```

## Rejecting with a message

When you reject an interrupt, it gets rejected with a generic "interrupt rejected" error. You can reject with a specific message if you would like instead.

```ts
handle {
 const filename = writeFile("Hello, world!")
 print(`Wrote to file: ${filename}`)
} with (data) {
 return reject("Don't write any files to disk!")
}
```

## Interrupts in tool calls

Interrupts get raised in tool calls as well. This is what makes them such critical safety infrastructure. You remember that when we read a file, we approved our own read:

```ts
const result = read("./README.md") with approve
```

But suppose you passed the `read` and `write` functions to an LLM instead to use as tools:

```ts
const result = llm("summarize README.md", tools: [read, write])
```

You wouldn't want it to be able to read and write _any_ file on your file system. With interrupts, it will need to ask you for permission before reading or writing any file.

## What happens when you approve or reject an interrupt?

- When you approve, that function or node keeps executing as normal.
- If you reject, that function or node halts execution immediately, and returns a failure.
- If you reject an interrupt during a tool call, the tool halts execution immediately and we send a message to the LLM explaining that the tool call was rejected.
- If you reject with a message, and the interrupt was raised by a tool call, then your message will get sent to the LLM along with the rejection.

## Handlers

Handlers are how you can respond to an interrupt in agency code.

## Syntax

### Shorthand syntax

```ts
const text = read("./README.md") catch "" with approve
```

### Block syntax

```ts
handle {
 const text = read("./README.md") catch ""
 print(text)
} with (data) {
 print(data.message)
 return approve()
}
```

### Block syntax with shorthand

```ts
handle {
 const text = read("./README.md") catch ""
 print(text)
} with approve
```

### Block syntax with named function

```ts
def handleInterrupt(data) {
 print(data.message)
 return approve()
}

handle {
 const text = read("./README.md") catch ""
 print(text)
} with handleInterrupt
```

## Handlers vs try/catch

Handlers kind of look like try/catch statements, but there's a very important difference. Let's go back to the email example. You raised an interrupt before deletion so users have a chance to reject the action. But suppose someone auto-approves this interrupt using one of the ways we've seen. Either using `with approve`:

```ts
def unsafeDelete() {
 const aMillion = 1000000
 deleteEmail(aMillion) with approve
}
```

Or with `.preapprove()`:

```ts
const unsafeDelete = deleteEmail.partial(numEmails: 1000000).preapprove()
```

Now they pass this `unsafeDelete` function to an LLM:

```ts
const result = llm("delete some emails", tools: [unsafeDelete])
```

Doesn't this negate the whole point of interrupts, because now the interrupt is pre-approved, and so the user can't stop the deletion? Not quite.

Handlers are different from try/catch statements. With a try/catch, if an exception is raised, it bubbles up to the closest try/catch, and doesn't go any further. But with handlers, _every single handler up the chain gets executed_. And if _any_ handler rejects, the interrupt is rejected.

You could wrap the LLM call in a second handler that rejects the interrupt:

```ts
node main() {
 handle {
 const result = llm("delete some emails", tools: [unsafeDelete])
 } with (data) {
 // emails never get deleted, because even though unsafeDelete pre-approved the interrupt,
 // this handler rejects it.
 return reject()
 }
}
```

This simple behavior is really important, because it means that _users will always have a chance to respond to interrupts_.

Suppose you use someone else's agency code, but don't trust it. You can wrap their code in a handler that rejects all interrupts:

```ts
node main() {
 handle {
 someOtherAgencyCode()
 } with reject
}
```

Now, all of their interrupts get rejected. As long as all destructive actions are gated behind an interrupt, you will be able to decide whether or not to approve them.

## Propagate

`propagate` means "I don't want to reject the interrupt, but I don't want anyone to be able to programmatically approve it either. I want to make sure it always goes to a user for approval or rejection."

## Pass

The final keyword is `pass`. `pass` just says, "I don't have an opinion about this interrupt." If you don't return anything, `pass` is the default. It's useful in match blocks, when you need some sort of value to return:

```ts
handle {
 doSomeWork()
} with (data) {
 return match (data.effect) {
 "std::guard" => reject()
 _ => pass()
 }
}
```

## The rules of handlers

The rules of handlers are thus:

1. If any handler rejects, the interrupt is rejected.
2. Otherwise, if any handler propagates, the interrupt propagates to the user for a decision.
3. Otherwise, if a handler approves, the interrupt is approved.
4. A handler that passes does none of these. It steps aside and lets the rest of the chain decide.

Of course, a handler doesn't need to approve, reject, or propagate. It can simply choose to log the interrupt data, print out the lyrics to "A Day in the Life," or whatever. A handler that never returns a verdict has passed, whether or not it said `pass()` out loud. And if _every_ handler passes, nobody in the chain made a decision, so the interrupt propagates up to the user — the same safe default you get when there is no handler at all.

## Effects

All interrupts contain three fields:

- message
- data
- effect.

Message and data are the first and second parameters to the `interrupt()` function:

```ts
raise interrupt("Are you sure you want to write to this file?", { filename: filename })
```

This will have `effect = "unknown"`. You can set the effect by using the structured interrupt format:

```ts
raise foo::write(
 "Are you sure you want to write to this file?",
 { filename: filename }
)
```

- `interrupt` = generic interrupt with effect = "unknown"
- `foo::write` = interrupt with effect = "foo::write"

It's good to have to create interrupts that have effects because then users can match on those effects inside of a handler:

```agency
handle {
  doSomething()
} with (data) {
  return match(data.effect) {
    "std::read" => approve()
    "std::write" => reject()
  }
}
```

## Payload types

You can also define the type for the `data` parameter for an effect. This is called the _payload type_, and you use `effect` to define it.

```
effect std::read {
 dir: string,
 filename: string
}
```

This does two things:

- It enforces that any place that raises a `std::read` effect _must_ specify a directory and filename.
- Gives you better typing for the `data` object in the handler function (including auto-completion if you're using the Agency plugin!)

## Partial Function Application (PFA)

Partial function application, or PFA, is another way to make it safe to read and write files. Here's how it works. The `read` function has this signature.

```ts
read(filename: string, dir: string): Result
```

Instead of calling this function, I can choose to just lock one of its parameters.

```ts
const readFromTmp = read.partial(dir: "/tmp")
```

`readFromTmp` is now a new function that only takes the `filename` parameter. The `dir` parameter is locked to `"/tmp"`, so it can only read files from `"/tmp"`.

Now I can give this function to an LLM, and it will only be able read files from the `/tmp` directory! Partial application lets you make a new function where some of the arguments are already filled in.

Things to note:

- You use `.partial()` for PFAs.
- You _have_ to specify named args. You can't use positional args, like `read.partial("/tmp")`. You have to use `read.partial(dir: "/tmp")`.

## Error handling

Agency does not have exceptions:

- Exceptions can crash your program
- Exceptions can't be represented in the type system

Instead Agency has the `Result` type.

## The `Result` type

When you write a function you can either return a plain value:

```ts
def divide(a: number, b: number): number {
 return a / b;
}
```

Now if users divide by zero, you're out of luck. Instead, you can return a `Result`, which can be a `success` or a `failure`:

```ts
def divide(a: number, b: number): Result {
 if (b == 0) {
 return failure("Can't divide by zero!")
 }
 return success(a / b)
}
```

Now, `divide` returns a Result type. Unwrap it with pattern matching. `success` and `failure` work as patterns, and the name in the parentheses is bound to the unwrapped value:

```ts
const result = divide(10, 0)
if (result is success(value)) {
 return "The result is ${value}"
}
if (result is failure(error)) {
 return "Error: ${error}"
}
```

`result is success` and `result is failure`, with no parentheses, are plain boolean tests. Do not read `result.value` or `result.error` directly.

Or as a match:

```ts
const result = divide(10, 0)
return match (result) {
 success(value) => "The result is ${value}"
 failure(error) => "Error: ${error}"
}
```

The first argument to the `failure` function is always a string error message. You can have an optional second argument where you can pass in an object containing extra data.

```ts
def parseConfig(path: string): Result {
 return failure("Bad syntax in ${path}", { line: 4, column: 12 })
}
```

## The `catch` keyword

You can use the `catch` keyword to specify a default value in case of failure.

```ts
node main(msg: string) {
 // `result` is a Result type
 const result = divide(10, 0)

 // `result2` is a number. If `divide` is a failure,
 // `result2` gets the default value of 3
 const result2 = divide(10, 0) catch 3
}
```

## State isolation

Every run of an agent gets full isolated state. Suppose you define an agent like this.

```ts
const log = []
node main(name:string) {
 const result = "Hello, ${name}!"
 log.push(result)
 return log
}
```

This agent has a global variable, `log`. Now, suppose you're using this agent in a web server context. As you know, any node defined in Agency can be imported and run as a regular function in TypeScript:

```ts
// note you have to import from the compiled .js file, not the .agency file
import { main } from "./main.js";

async function run() {
  const result = await main("Adit");
  console.log(result);
}

run();
```

In a web server, you may have multiple requests concurrently calling this agent. Let's say you have _five_ requests concurrently calling this agent, with these names:

```
Colin
Ed
Jonny
Phil
Thom
```

Five requests that call the `main` node, push an entry to `log`, and then return `log` as the return value. What return value is each request going to get? You may think each request is mutating the same array, so at least one request will get an array with all five values.

```ts
["Hello, Colin!", "Hello, Ed!", "Hello, Jonny!", "Hello, Phil!", "Hello, Thom!"];
```

But that's not correct! Each request will get an array with a single value:

```ts
// 1
["Hello, Colin!"][
  // 2
  "Hello, Ed!"
][
  // 3
  "Hello, Jonny!"
][
  // 4
  "Hello, Phil!"
][
  // 5
  "Hello, Thom!"
];
```

Every call to an Agency agent gets state isolation, so each run has its own copy of the global variables. This makes it much easier to reason about your agent, as you don't have to think about concurrency.

## Global vs Static Variables

As you just learned, each run gets its own copy of any global variables. This also means that _each global variable is reinitialized for every run_. This is okay when initialization is cheap, like for an empty array.

```
const log = []
```

But what about if you're reading a system prompt from a file? Or making a fetch request?

```
const prompt = read("./prompts/system.md") catch "" with approve
```

Initializing these every time can get expensive. That's why we have static variables.

## Static variables

If a variable should get initialized exactly once at the start of each agent, and get shared across all the different runs, mark it `static`.

```ts
// initialized once, shared across all runs, immutable
static const prompt = read("prompt.txt") catch "" with approve
```

Static variables:

- Are initialized when when the module loads
- Are **immutable** — you cannot reassign them or modify their contents. The static var is actually **deeply immutable**. For example, if your static variable is an array, you cannot add or remove values from that array.
- Are **shared across all runs** — every call to the agent sees the same value.
- Are always `const`, never `let`.

## Exporting variables

You cannot export a global variable. This is because global variables can lead to spaghetti code. If you want to access your global variables in other files, you can export functions that get and set those variables.

You _can_ export static variables.

## Global statements

Statements in the global scope also get run once per run (same as global variables):

```ts
// runs every time the agent is called
initTelemetry();
```

If you only want the statement to run once when the agent starts, mark it as `static`.

## `static` on statements

The `static` prefix also works on a bare top-level statement. Use it for function calls that should run once per process, rather than once per run:

```ts
// runs once, the first time this module is touched
static logger.flush()
static initTelemetry()

node main() {
 // ...
}
```

## Message Threads

By default, all LLM calls share a message history:

```ts
const result1 = llm("Hi my name is Alice. What is your name?");
const result2 = llm("Do you remember my name?");
print(result1);
print(result2);
```

Prints something like:

```
Hello Alice! I'm an AI assistant and I don't have a personal name, but you can call me Assistant. How can I help you today?
Yes, I remember your name is Alice! How can I assist you today?
```

This message history gets shared across function calls and across nodes.

## `thread` and `subthread`

Sometimes you want to have a side conversation that doesn't pollute the main message history. You can use threads and subthreads for this.

`thread` creates an isolated conversation. The thread block starts a new empty conversation. All the LLM calls within the thread block share message history, but they don't touch the main conversation.

```ts
 const result1 = llm("Hi my name is Alice. What is your name?")
 thread {
 const result2 = llm("Do you remember my name?")
 }
 print(result1)
 print(result2)
```

Prints something like:

```
Hello Alice! I'm an AI assistant, and I don't have a personal name, but you can call me Assistant. How can I help you today?
I don’t have the ability to remember personal details or past interactions, including your name. However, I’m here to help you with any questions or tasks you have! How can I assist you today?
```

If you want to create a side conversation but want to inherit the message history thus far, use a `subthread` instead:

```ts
 const result1 = llm("Hi my name is Alice. What is your name?")
 subthread {
 const result2 = llm("Do you remember my name?")
 const result3 = llm("Just fyi my favorite ice cream flavor is chocolate sorbet.")
 }
 const result4 = llm("What is my favorite ice cream flavor?")
 print(result1)
 print(result2)
 print(result3)
 print(result4)
```

Prints something like:

```
Hello Alice! I'm an AI assistant and I don't have a personal name, but you can call me Assistant. How can I help you today?
Yes, I remember your name is Alice! How can I assist you today?
Chocolate sorbet sounds delicious! A great choice for chocolate lovers. Do you have any favorite toppings to go with it?
I don't have access to personal data, so I can't know your favorite ice cream flavor. However, if you tell me what it is, I’d love to hear about it!
```

You can also nest threads and subthreads to create side conversations branching off other side conversations.

Message threads work everywhere except module top-level code.

## systemMessage

Use this to send a systemMessage:

```ts
import { systemMessage } from "std::thread"

node main() {
 systemMessage("You are a helpful assistant.")
 const result = llm("Do you remember my name?")
 print(result)
}
```

## Guards

Guards let you limit the **cost** and/or **compute time** of a block of work.

```ts
node main() {
 const result = guard(cost: $0.2) {
 const category = llm("classify this email: I love you")
 const reply = llm("draft a reply")
 return category
 }

 match(result) {
 success(value) => print("Category: ${value}")
 failure(error) => print(error)
 }
}
```

Things to note:

- You don't have access to all the variables inside the guard, only to the return value.
- `result` is a `Result` type. On success, it has the return value. On failure, its message says which guard tripped and by how much, and its `data` holds the numbers:

```ts
// "guardFailure" = cost, "timeoutFailure" = time.
// Every field is always present; the ones that don't apply are null.
type GuardFailureData = {
  type: "guardFailure" | "timeoutFailure";
  label: string | null;
  maxCost: number | null;
  actualCost: number | null;
  maxTime: number | null;
  actualTime: number | null;
};
```

`guard` takes one or both of:

- `cost:` — a `number` of dollars, eg `$2.0`.
- `time:` — a `number` of milliseconds (or use the [unit literals](/guide/basic-syntax.html#unit-literals): `30s`, `5m`, `100ms`, `1h`).

## The standard library

### Already in scope: never import these, never prefix them

- Output and input: `print`, `printJSON`, `input`, `sleep`
- Files: `read`, `write`, `readBinary`, `writeBinary`
- Lists: `map`, `mapWithIndex`, `filter`, `exclude`, `find`, `findIndex`, `reduce`, `flatMap`, `flatten`, `every`, `some`, `count`, `sortBy`, `unique`, `groupBy`, `range`
- Model calls: `llm`, `saveDraft`

Before you write a loop that builds a list, counts, groups, or removes duplicates, check this list, the function may already exist.

### Modules you import

- `std::thread`: the conversation with the model. `systemMessage`, `ensureSystemMessage`, `userMessage`, `image`, `file`, `getCost`, `getTokens`
- `std::system`: the process and its environment. `cwd`, `env`, `setEnv`, `args`, `isTTY`, `readStdin`, `exit`
- `std::shell`: commands and looking at the file system. `bash`, `exec`, `ls`, `grep`, `glob`, `exists`, `stat`, `which`
- `std::fs`: changing files (`read` and `write` are already in scope). `edit`, `mkdir`, `copy`, `move`, `remove`
- `std::path`: `join`, `resolve`, `basename`, `dirname`, `extname`, `relative`
- `std::object`: `keys`, `values`, `entries`, `mapValues`, `mapEntries`, `filterEntries`
- `std::date`: `now`, `today`, `format`, `parse`, `elapsedTime`, `formatDuration`
- `std::validation`: types and checks for structured output. `Json`, `JsonObject`, `Email`, `MatchesPattern`, `isInt`, `isPositive`
- `std::http`: `fetch`, `fetchJSON`, `fetchMarkdown`

The standard library has many more modules than these: web search, data sources, git, GitHub, images, speech, terminal UI, memory, and ready-made agents. When a task needs something not listed here, look through the `agencyStdlib` tool's file list before writing it by hand. The task is likely already a function.
