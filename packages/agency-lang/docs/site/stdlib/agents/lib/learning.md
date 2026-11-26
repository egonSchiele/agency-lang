---
name: "learning"
description: "The tools an agent has learned in this run, kept as plain"
---

# learning

records so they survive a checkpoint and a saved session.

  `learn` in `std::agency` returns tools and keeps nothing. An agent that
  wants a learned tool on its next turn keeps it here: `learnSessionTools`
  learns and records, and `getGeneratedTools` rebuilds the tools each time
  the agent assembles its tool list.

  The records belong to the run. Two agents in one run share them.

## Functions

### getGeneratedTools

```ts
getGeneratedTools(): any[]
```

Return every tool learned in this run, in the order they were learned.

Rebuild the learned tools from their records. Call it each time the
  agent assembles its tool list.

**Returns:** `any[]`

**Throws:** `std::run`, `std::guard`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/learning.agency#L43))

### learnSessionTools

```ts
learnSessionTools(
  source: AgencySource,
  names: string[] = [],
  namespace: string = "session",
  offeredNames: string[] = [],
): Result<string[]>
```

Learn exported Agency functions and keep them for the rest of the run.
  Returns the names the tools are offered under.

Learn the functions and record them. The whole batch is refused when a
  new name is in `offeredNames` or is already learned, so an existing tool
  is never replaced.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| source | [AgencySource](../../agency.md#agencysource) |  | A std:: module, an Agency file, or Agency source text |
| names | `string[]` | [] | The exported functions to learn, or empty for every public function |
| namespace | `string` | "session" | A prefix for each tool's name, as `namespace_name`, or "" for none |
| offeredNames | `string[]` | [] | Names the agent already offers, which a learned tool may not take |

**Returns:** `Result<string[]>`

**Throws:** `std::run`, `std::guard`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/learning.agency#L53))
