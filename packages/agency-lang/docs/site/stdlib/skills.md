# skills

## Functions

### readSkill

```ts
readSkill(filepath: string): string
```

Read a skill file colocated with this Agency module. `filepath` is
  resolved relative to the directory of the compiled `.js` (by
  convention, the same directory as the source `.agency` file). Use
  this to ship reusable prompt-shaped "skills" alongside an agent:

      import { readSkill } from "std::skills"

      systemPrompt = readSkill("skills/debug-loop.md") with approve

  Falls back to the current working directory when called from outside
  an Agency execution frame.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filepath | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/skills.agency#L3))
