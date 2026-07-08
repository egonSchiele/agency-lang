---
name: "agent"
---

# agent

Helpers for building user-facing agents. This module offers three
independent tools:
- `route` dispatches each user message to one of
several specialist agents (and lets the LLM hand off between them),
- `question` asks the user something through an interrupt the host UI
can render, and
- `todoWrite` / `todoList` give the LLM a small todo
list to track multi-step work across turns.

  ```ts
  import { route } from "std::agent"

  // Two specialists, each with its own system prompt and tools.
  const codeAgent = { systemPrompt: "You write and edit code...", tools: [readFile, writeFile] }
  const researchAgent = { systemPrompt: "You answer questions from docs...", tools: [fetchUrl] }

  node main() {
    let msg = input("> ")
    while (msg != "exit") {
      const reply = route({
        start: "code",
        agents: { code: codeAgent, research: researchAgent },
        maxHops: 3,
      }, msg)
      print(reply)
      msg = input("> ")
    }
  }
  ```

## Types

### PromptSpec

* Configuration for one specialist registered with `route`.
 *
 * - `systemPrompt` — system message seeded into the specialist's
 *   thread on first entry. The router appends `RouterConfig.context`
 *   (if set) to this string before seeding.
 * - `tools` — the tools this specialist sees. The router automatically
 *   appends a `handoff` tool PFA-bound to the other categories, so
 *   do NOT add `handoff` here yourself.
 * - `memory` (optional) — when `true`, the router calls
 *   `setMemoryId(<category>)` before each LLM call so this
 *   specialist's `remember`/`recall` lands in a per-specialist graph.
 *   You must `enableMemory(...)` separately for this to do anything.

```ts
/**
 * Configuration for one specialist registered with `route`.
 *
 * - `systemPrompt` — system message seeded into the specialist's
 *   thread on first entry. The router appends `RouterConfig.context`
 *   (if set) to this string before seeding.
 * - `tools` — the tools this specialist sees. The router automatically
 *   appends a `handoff` tool PFA-bound to the other categories, so
 *   do NOT add `handoff` here yourself.
 * - `memory` (optional) — when `true`, the router calls
 *   `setMemoryId(<category>)` before each LLM call so this
 *   specialist's `remember`/`recall` lands in a per-specialist graph.
 *   You must `enableMemory(...)` separately for this to do anything.
 */
export type PromptSpec = {
  type: "prompt";
  systemPrompt: string;
  tools: any[];
  memory?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L120))

### AgentSpec

```ts
export type AgentSpec = {
  type: "agent";
  name: string;
  agent: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L127))

### RouterConfig

* Top-level config for a single `route(config, msg)` call.
 *
 * - `start` — the category to dispatch the user's message to first.
 *   Must be a key of `agents`.
 * - `agents` — map of category name → `PromptSpec | AgentSpec`.
     Every key is a potential handoff target.
 * - `maxHops` — bound on per-turn handoffs (specialist A → B → A → …).
 *   When the cap is reached, the next LLM call drops the `handoff`
 *   tool so the agent is forced to answer in place. 3 is a sensible
 *   default for most agents.
 * - `context` (optional) — extra text appended to every specialist's
 *   `systemPrompt` on first entry. Use this for shared grounding
 *   (current date, working directory, project conventions) that
 *   every specialist should see.

```ts
/**
 * Top-level config for a single `route(config, msg)` call.
 *
 * - `start` — the category to dispatch the user's message to first.
 *   Must be a key of `agents`.
 * - `agents` — map of category name → `PromptSpec | AgentSpec`.
     Every key is a potential handoff target.
 * - `maxHops` — bound on per-turn handoffs (specialist A → B → A → …).
 *   When the cap is reached, the next LLM call drops the `handoff`
 *   tool so the agent is forced to answer in place. 3 is a sensible
 *   default for most agents.
 * - `context` (optional) — extra text appended to every specialist's
 *   `systemPrompt` on first entry. Use this for shared grounding
 *   (current date, working directory, project conventions) that
 *   every specialist should see.
 */
export type RouterConfig = {
  start: string;
  agents: Record<string, PromptSpec | AgentSpec>;
  maxHops: number;
  context?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L149))

## Effects

### std::question

```ts
effect std::question {
  prompt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L45))

## Functions

### todoAdd

```ts
todoAdd(todo: Todo): Todo[]
```

Add a new todo to the list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| todo | [Todo](#todo) |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L49))

### todoUpdate

```ts
todoUpdate(id: string, status: "pending" | "in_progress" | "completed"): Todo[]
```

Update the status of a todo by id.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| status | `"pending" \| "in_progress" \| "completed"` |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L57))

### todoWrite

```ts
todoWrite(todos: Todo[]): Todo[]
```

Replace the current todo list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| todos | `Todo[]` |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L73))

### todoList

```ts
todoList(): Todo[]
```

Return the current todo list.

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L81))

### question

```ts
question(prompt: string): string
```

Ask the user a question and wait for their reply.

  @param prompt - The question to show the user

Alternative to the `input` function, raises an interrupt instead,
so it can be used anywhere (eg a web server) instead of just the CLI.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

**Throws:** `std::question`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L92))

### handoff

```ts
handoff(category: string, reason: string, validCategories: string[]): string
```

Re-route the user's current message to a different specialist.
  After you call this, your turn closes and the original message
  is re-routed to the chosen specialist. Anything you say after
  `handoff()` is discarded, so return immediately.

  Bias toward staying: most follow-ups are continuations of the
  current topic. Only call this when the message clearly needs
  a different specialist's tools.

  @param category - The specialist to re-route to
  @param reason - Brief explanation (recorded for debugging)
  @param validCategories - PFA-bound by `route()` — do not set manually

* Tool function the router injects into every specialist's tool
 * set. You should not register this manually — `route` adds it for
 * you with `validCategories` PFA-bound to the other registered
 * categories.
 *
 * When called, sets the module-level handoff target. The current
 * LLM call returns. `route` reads (and clears) the target and
 * re-runs the user's original message in the new specialist's
 * thread. If `category` isn't in `validCategories`, the handoff is
 * rejected and the LLM sees an error string as the tool's result.
 * This keeps the LLM from accidentally handing off to itself or to
 * an unregistered specialist.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| category | `string` |  |
| reason | `string` |  |
| validCategories | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L181))

### route

```ts
route(config: RouterConfig, userMsg: string): string
```

Run one user turn through a multi-specialist agent. Owns the hop
  loop, handoff signal, and force-answer fallback. The router
  injects a `handoff(category, reason)` tool into each specialist's
  toolset so the LLM can re-route the message when it's out of scope.
  When `maxHops` is reached, the handoff tool is stripped from the
  last call so the LLM is forced to answer.

  @param config - Start category, per-category agent specs, max hops, optional context string
  @param userMsg - The user's input message for this turn

* Run one user turn through a multi-specialist agent. Returns the
 * final reply (the text the user sees) after all handoffs settle.
 *
 * Lifecycle of a single call:
 *
 * 1. Dispatch `userMsg` to `config.start`'s specialist. The
 *    specialist's `thread(session: <category>)` block is opened,
 *    its system message is seeded on first entry, memory is scoped
 *    if requested, and `llm(userMsg, { tools: [...spec.tools,
 *    handoff] })` runs.
 * 2. After the LLM call returns, check whether `handoff` was called
 *    during the turn.
 *    - No → done, return the LLM's reply.
 *    - Yes → loop with the new category, up to `config.maxHops`
 *      total iterations.
 * 3. If the hop cap is reached without a final answer, run one more
 *    LLM call WITHOUT the `handoff` tool so the agent must answer.
 *
 * Call once per user turn — `route` does not own the outer REPL
 * loop. Threads, memory state, and the policy file (if you install
 * `cliPolicyHandler`) persist across calls so the user can have a
 * stateful conversation.
 *
 * @param config - Specialists, start category, hop cap, optional
 *   shared context appended to every system prompt.
 * @param userMsg - The user's input for this turn.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| config | [RouterConfig](#routerconfig) |  |
| userMsg | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L336))
