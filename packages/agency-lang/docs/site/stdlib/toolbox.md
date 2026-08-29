---
name: "toolbox"
description: "Keep a directory of tools an agent wrote."
---

# toolbox

A tool is a directory holding two Agency files. `impl.agency` is the
  part the coding agent writes: `export type Request` and
  `export def run(request: Request): Json`. `tool.agency` is generated
  from a fixed template and wraps `run` in a guard with time and cost
  limits. It exports `tool` and `node main`, both taking a `Request`.

  ## Useful exports
  - `listTools` reads a toolbox directory into a catalog. It raises a
    `std::toolbox::scan` interrupt first, so the caller must handle it.
  - `writeTool` has the coding agent draft a new tool. `writeTool` then
    reviews and tests the draft, shows it to the user through an
    interrupt, and saves it.
  - `runTool` runs a saved tool and records the outcome.

  ```ts
  import { writeTool, listTools, runTool } from "std::toolbox"

  const REVISE_PREFIX = "revise "

  node main() {
    handle {
      const written = writeTool(
        name: "getNews",
        purpose: "Summarize today's news for a list of topics as Markdown.",
        request: "{ topics: string[]; maxItems: number }",
      )
      if (written is failure(err)) {
        print("not written: ${err}")
        return
      }
      printJSON(listTools())
      const news = runTool("getNews", { topics: ["tech"], maxItems: 5 })
      print(news)
    } with (intr) {
      return match (intr.effect) {
        "std::toolbox::review" => {
          print(intr.data.source)
          print("effects: ${intr.data.effects.join(", ")}")
          const answer = input("accept / revise <feedback> / reject: ")
          if (answer == "accept") {
            return approve({ verdict: "accept" })
          }
          if (answer.startsWith(REVISE_PREFIX)) {
            return approve({ verdict: "revise", feedback: answer.slice(REVISE_PREFIX.length) })
          }
          return reject("cancelled by user")
        }
        _ => pass()
      }
    }
  }
  ```

  A program can also import a saved tool directly:
  `import { tool as getNews } from "~/.agency-agent/tools/getNews/tool.agency"`.

## Types

### ModuleFacts

What `describe` says about a tool's `run` function.

```ts
/** What `describe` says about a tool's `run` function. */
export type ModuleFacts = {
  signature: string;
  docstring?: string;
  effects: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L120))

### ToolMeta

The usage record in meta.json.

```ts
/** The usage record in meta.json. */
export type ToolMeta = {
  purpose: string;
  request: string;
  version: number;
  uses: number;
  lastUsedAt?: string;
  recentOutcomes: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L127))

### ToolEntry

One tool in a toolbox. This is what `listTools` returns. If the tool
  could not be read correctly, `broken` holds the reason.

```ts
/** One tool in a toolbox. This is what `listTools` returns. If the tool
  could not be read correctly, `broken` holds the reason. */
export type ToolEntry = {
  name: string;
  dir: string;
  module: ModuleFacts;
  meta: ToolMeta;
  broken?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L138))

### WriteToolReview

The value a handler passes to approve() for std::toolbox::review. A
  bare approve() counts as accept.

```ts
/** The value a handler passes to approve() for std::toolbox::review. A
  bare approve() counts as accept. */
export type WriteToolReview =
  | { verdict: "accept" }
  | { verdict: "revise"; feedback: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L148))

## Effects

### std::toolbox::scan

```ts
effect std::toolbox::scan {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L107))

### std::toolbox::review

```ts
effect std::toolbox::review {
  name: string;
  stagingDir: string;
  source: string;
  effects: string[];
  tested: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L111))

## Functions

### listTools

```ts
listTools(dir: string = "~/.agency-agent/tools"): Result<ToolEntry[]>
```

List the tools in a toolbox directory. Raises a `std::toolbox::scan`
  interrupt before reading anything. Each entry has: the tool's name and
  directory; what `describe` says about its `run` function (signature,
  docstring, effects); and its meta.json record (purpose, request type,
  version, run count, last-run time, recent outcomes).

  @param dir - The toolbox directory to scan

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` | "~/.agency-agent/tools" |

**Returns:** `Result<ToolEntry[]>`

**Throws:** `std::toolbox::scan`, `std::ls`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L284))

### writeTool

```ts
writeTool(
  name: string,
  purpose: string,
  request: string,
  dir: string = "~/.agency-agent/tools",
  maxRounds: number = 3,
  maxTime: number = 3m,
  maxCost: number = $1.00,
  model: string = "",
  provider: string = "",
): Result<ToolEntry>
```

Write a reusable tool into a toolbox directory. The coding agent drafts
  the tool's `run` function against the request type. writeTool wraps it
  in the guarded tool module, typechecks and reviews the pair, tests it
  when it is pure computation, shows it to the user for acceptance or
  revision, and saves it.

  @param name - The tool's name; also its directory under dir
  @param purpose - What the tool should do, in plain language
  @param request - The tool's input type as Agency type text, such as `{ topics: string[]; maxItems: number }`
  @param dir - The toolbox directory to write into
  @param maxRounds - Draft-review rounds before giving up
  @param maxTime - Time limit baked into the tool's guard
  @param maxCost - Cost limit baked into the tool's guard
  @param model - Model override for the coding and review agents, or ""
  @param provider - Provider for the model override

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| purpose | `string` |  |
| request | `string` |  |
| dir | `string` | "~/.agency-agent/tools" |
| maxRounds | `number` | 3 |
| maxTime | `number` | 3m |
| maxCost | `number` | $1.00 |
| model | `string` | "" |
| provider | `string` | "" |

**Returns:** `Result<ToolEntry>`

**Throws:** `std::remove`, `std::mkdir`, `std::toolbox::review`, `std::write`, `std::move`, `std::read`, `std::guard`, `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L724))

### runTool

```ts
runTool(
  name: string,
  request: Json,
  dir: string = "~/.agency-agent/tools",
): Result<Json>
```

Run a saved tool's `main` node in a subprocess and return what it
  returned. The tool's meta.json records the run: one more use, the
  time, and whether it succeeded.

  @param name - The tool's name under dir
  @param request - The tool's input, a value of its Request type
  @param dir - The toolbox directory holding the tool

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| request | [Json](validation.md#json) |  |
| dir | `string` | "~/.agency-agent/tools" |

**Returns:** `Result<Json>`

**Throws:** `std::run`, `std::guard`, `std::write`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L819))
