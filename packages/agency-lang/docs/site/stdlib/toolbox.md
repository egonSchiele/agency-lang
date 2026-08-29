---
name: "toolbox"
description: "Keep a directory of tools an agent wrote, and write new ones."
---

# toolbox

Keep a directory of tools an agent wrote, and write new ones. A tool is
  an Agency module that exports `type Request`, `def tool(request: Request)`,
  and `node main(request: Request)`. `tool` returns the `Result` of the
  guard that wraps its work. `listTools` reads a toolbox directory
  into a catalog; `writeTool` has the coding agent write a new tool, checks
  and tests it, shows it to the user through an interrupt, and saves it.

  The review interrupt is the point of the design: a person reads the
  generated code before it is saved. The handler below prints the source
  and asks. A policy that answers every interrupt with a bare `approve()`
  accepts the draft; `reject()` cancels the write.

  ```ts
  import { writeTool, listTools } from "std::toolbox"
  import { runFile } from "std::agency"

  const REVISE_PREFIX = "revise "

  node main() {
    handle {
      const written = writeTool(name: "getNews", purpose: "Summarize today's news for a list of topics as Markdown.")
      if (written is failure(err)) {
        print("not written: ${err}")
        return
      }
      printJSON(listTools())
      const news = runFile(written.value.dir, "tool.agency", "main", { request: { topics: ["tech"], maxItems: 5 } })
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

  A program imports a saved tool directly:
  `import { tool as getNews } from "~/.agency-agent/tools/getNews/tool.agency"`.

## Types

### ToolEntry

One tool in a toolbox: what `describe` says about its module plus the
  usage record from meta.json. `broken` carries the reason the directory
  could not be read as a healthy tool: a parse failure, no `tool` export,
  or a meta.json that is missing a field or has one of the wrong type.

```ts
/** One tool in a toolbox: what `describe` says about its module plus the
  usage record from meta.json. `broken` carries the reason the directory
  could not be read as a healthy tool: a parse failure, no `tool` export,
  or a meta.json that is missing a field or has one of the wrong type. */
export type ToolEntry = {
  name: string;
  dir: string;
  summary?: string;
  signature: string;
  docstring?: string;
  effects: string[];
  version: number;
  uses: number;
  lastUsedAt?: string;
  recentOutcomes: string[];
  broken?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L96))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L112))

## Effects

### std::toolbox::scan

```ts
effect std::toolbox::scan {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L82))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L84))

## Functions

### listTools

```ts
listTools(dir: string = "~/.agency-agent/tools"): Result<ToolEntry[]>
```

List the tools in a toolbox directory: each tool's name, signature,
  description, the interrupt effects it can raise, and its usage record.

  @param dir - The toolbox directory to scan

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` | "~/.agency-agent/tools" |

**Returns:** `Result<ToolEntry[]>`

**Throws:** `std::toolbox::scan`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L262))

### checkToolShape

```ts
checkToolShape(source: string): string[]
```

Check that Agency source has the shape of a toolbox tool: exactly the
  exports type Request, def tool(request: Request): Result<...>, and node
  main(request: Request): Result<...>; tool returns a guard with time and
  cost limits and a finalize; no `with approve`; a docstring on tool with
  @param request and an example call. Returns one message per problem,
  empty when the source conforms.

  @param source - Agency source code of a tool module

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L407))

### writeTool

```ts
writeTool(
  name: string,
  purpose: string,
  exampleRequest: string = "",
  dir: string = "~/.agency-agent/tools",
  maxRounds: number = 3,
  maxTime: number = 3m,
  maxCost: number = $1.00,
  model: string = "",
  provider: string = "",
): Result<ToolEntry>
```

Write a reusable tool into a toolbox directory. The coding agent drafts
  the tool against a fixed contract, the draft is checked, reviewed, and
  (when it is pure computation) tested, then shown to the user for
  acceptance or revision before it is saved.

  @param name - The tool's name; also its directory under dir
  @param purpose - What the tool should do, in plain language
  @param exampleRequest - The user request that prompted this tool, or ""
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
| exampleRequest | `string` | "" |
| dir | `string` | "~/.agency-agent/tools" |
| maxRounds | `number` | 3 |
| maxTime | `number` | 3m |
| maxCost | `number` | $1.00 |
| model | `string` | "" |
| provider | `string` | "" |

**Returns:** `Result<ToolEntry>`

**Throws:** `std::remove`, `std::mkdir`, `std::toolbox::review`, `std::write`, `std::move`, `std::read`, `std::guard`, `std::run`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/toolbox.agency#L764))
