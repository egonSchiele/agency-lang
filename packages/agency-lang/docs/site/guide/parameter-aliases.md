---
name: Parameter aliases
description: If you find that models are consistently calling a tool with the wrong param name, parameter aliases provide a way to allow multiple different parameter names for the same parameter for tool calls.
---

### Parameter aliases

When a model makes a tool call, it sometimes uses the wrong parameter name. For example, you may have a parameter name like `baseUrl`, and the model may use `url` in the tool call instead. If you see it doing this frequently, it's a good idea to change that parameter name. However, if it seems to use a couple of different parameter names, then you can use parameter aliases.

Parameter aliases allow you to set multiple names for a parameter. The first name in the list is the actual parameter name, and any of the ones after it are aliases:

```ts
def fetch(baseUrl | url: string, path: string = ""): Result<string> {
  ...
}
```

In this example, `baseUrl` is the actual param name, and `url` is the alias. If the model uses any of the aliases, we will normalize it to the parameter name and call the tool with that parameter name. Parameter aliases offer an easy way to work around this basic model failure pattern so that you don't have to waste a tool call.

Note that this feature is purely for fixing this model issue with tool calls, and you should still use the variable `baseUrl` in your code, not `url`.