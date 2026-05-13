# Odds and Ends
Here is a variety of stuff you might find useful. It's covered in more detail in later sections, but until you get there, this will help you get going quickly.

Agency has a large standard library with all kinds of useful functionality. You can import and use functions like Wikipedia search using

```ts
import { search } from "std::wikipedia"
```

See [here](/appendix/agency-stdlib) for more information, or see the [standard library docs](/stdlib/overview). 

If any of the functions are marked as throwing an interrupt, you will need some special syntax to call them. For example, the `read` and `write` functions throw interrupts, so you will need to call them like this:

```agency
const content = read("file.txt") with approve
```

We will cover [interrupts](./interrupts) and [handlers](./handlers) in a future section.


Another tip: you know you can run your agents using `agency run foo.agency`. Did you know that you can also serve them over HTTP using `agency serve http foo.agency`? Or expose your nodes and functions as tools in an MCP server using `agency serve mcp foo.agency`? You just need to `export` all the functions and nodes you want to expose:

```
export def greet(name: string): string {
  return "Hello, " + name + "!"
}
```

Then you can hit it:

```
curl -X POST http://127.0.0.1:3545/function/greet \
  -d '{"name": "World"}'
```

[More on serving your code here](/cli/serve).