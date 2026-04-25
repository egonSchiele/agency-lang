# Agency's execution model

While Agency can be used anywhere, it's written to be especially useful for websites, thanks to its special execution model.

As you just saw, any node defined in Agency can be imported and run as a regular function in TypeScript:

```ts
// note you have to import from the compiled .js file, not the .agency file
import { main } from "./main.js";

async function run() {
  const result = await main("Adit");
  console.log(result);
}

run();
```

This makes it really easy to use your Agency agent from TypeScript code. Every call to an Agency agent gets state isolation. Suppose you define an agent like this.

```ts
const log = []
node main(name:string) {
  const result = llm(`What is a nice greeting for ${name}?`)
  log.push(result)
  return log
}
```

You can see it's got a global variable. Now suppose you have two different calls to this node running concurrently. Are they going to be stomping on each other's state because they're both modifying the global variable?

Nope. Both threads get isolated state, so that global variable is unique to each call.

This makes it much easier to write agents as you don't have to pass every bit of shared state into every single function call. You can just put it in the global state instead. 

## Shared variables

Now you might be thinking that's fine, but it looks like that code was about logging. What if you do want to log every single call to an agent from inside agency? How would you do that? Right now this `log` variable is useless because it just logs a single call!

If you do want state that is shared across all runs of an agent in Agency, you can mark it `shared`.

```ts
// now log is shared across all calls to main
shared const log = []
node main(name:string) {
  const result = llm(`What is a nice greeting for ${name}?`)
  log.push(result)
  return log
}
```

Shared variables are special. They are shared across all calls. Their state is not serialized when Agency serializes execution state due to an interrupt or a failure or some other reason. Its state is not restored when you restore a checkpoint using the `restore` function.

Shared state is great for things like building a cache or reading prompt files.

## Important point about Agency's execution model!

As you have just learned, global variables are unique to each run. That means that each time you call the main node, you will re-instantiate a `log` variable to an empty array. This is great for cheap operations, but what if one of your global variables is a file that you read, maybe one containing a big prompt? Then that file will be re-read for every call to the main node. If the only thing you're doing with that file is reading a prompt, and its contents are never going to change, mark it `shared` instead. Then you will only read that file once:

```ts
shared const prompt = read("prompt.txt")
```