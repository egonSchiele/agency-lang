---
name: "router"
description: "Given the user's message, which of research, code, or the"
---

# router

coordinator should handle it. One decision call on a thread of its own;
  every doubt goes to the coordinator. See docs/dev/agents/agent-router.md.

## Types

### Route

```ts
export type Route = "research" | "code" | "coordinator"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/router.agency#L9))

### RouteChoice

The route to take, and a line to show the user, "" for none. The line
  reports a failed router call, once per router model.

```ts
/** The route to take, and a line to show the user, "" for none. The line
  reports a failed router call, once per router model. */
export type RouteChoice = {
  route: Route;
  notice: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/router.agency#L13))

## Functions

### routeQuestion

```ts
routeQuestion(toolNames: string[]): string
```

The question the router asks: one line per option, the coordinator's
  line naming its other tools.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| toolNames | `string[]` |  | The coordinator's tools that are not routed subagents, the ones to keep first |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/router.agency#L44))

### pickRoute

```ts
pickRoute(
  text: string,
  toolNames: string[],
  model: string,
  provider: string,
): RouteChoice
```

Ask the router model which agent should handle the message. Anything
  short of a confident answer is the coordinator, and a failed call never
  fails the turn. A cancel is not a failure: `try` passes it through.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| text | `string` |  | The user's message |
| toolNames | `string[]` |  | The coordinator's tools that are not routed subagents |
| model | `string` |  | The router model |
| provider | `string` |  | The router model's provider |

**Returns:** [RouteChoice](#routechoice)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/router.agency#L106))
