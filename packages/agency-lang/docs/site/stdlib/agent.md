---
name: "agent"
---

# agent

## Overview

  Helpers for building user-facing agents. Three independent
  features live here:

  - **`route`** — a multi-specialist dispatcher. Wire two or more
    "specialist" agents (each with its own system prompt, tool set,
    and optional memory scope) into one entry point. Each user
    message stays in its current specialist unless the LLM calls
    `handoff()` to re-route it. See below for usage.
  - **`question`** — ask the user a question via an interrupt so
    the host UI (CLI, web, etc.) can render the prompt.
  - **`todoWrite` / `todoList`** — a tiny in-process todo list an
    LLM can use to track multi-step work across turns.

  ## Router usage

  ```ts
  import { route } from "std::agent"

  // Two specialists, each with its own system prompt + tools.
  const codeAgent = {
    systemPrompt: "You write and edit code...",
    tools: [readFile, writeFile, typecheck],
    memory: true,
  }
  const researchAgent = {
    systemPrompt: "You answer questions by reading docs...",
    tools: [fetchUrl, wikipediaSearch],
    memory: true,
  }

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

  ### How handoff works

  Inside `route`, each specialist's tool set is augmented with a
  `handoff(category, reason)` tool. When the LLM calls it, the
  current LLM call ends and `route` re-runs the same user message
  in the named specialist's thread. The handoff cannot target the
  current specialist (PFA prevents self-targets).

  The cap `maxHops` bounds ping-pong: when reached, the next call
  is made WITHOUT the handoff tool so the LLM is forced to answer.

  ### Per-specialist state

  Each specialist runs inside its own `thread(session: <category>)`
  block, so conversation history is partitioned. When `memory: true`,
  `setMemoryId(<category>)` is also called so `remember`/`recall`
  inside the specialist's tools land in a per-specialist knowledge
  graph. Enable the memory subsystem first via `enableMemory(...)`
  in `std::memory`.

  ### Limits

  Router state (handoff signal, first-entry flags) lives in
  module-level `let`s, which live in the per-program GlobalStore.
  Concurrent calls to `route` in **separate** RuntimeContexts are
  fine; concurrent calls in the **same** program / RuntimeContext
  (e.g. parallel runners inside one process) will race. Not
  supported in v1.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L130))

### AgentSpec

```ts
export type AgentSpec = {
  type: "agent";
  name: string;
  agent: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L137))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L159))

## Functions

### todoWrite

```ts
todoWrite(todos: Todo[]): Todo[]
```

Replace the current todo list. Each todo has an id, text, and status (one of 'pending', 'in_progress', 'completed'). Use this to track multi-step work as you go: mark a todo 'in_progress' before starting it and 'completed' when done. Returns the new list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| todos | `Todo[]` |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L89))

### todoList

```ts
todoList(): Todo[]
```

Return the current todo list.

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L97))

### question

```ts
question(prompt: string): string
```

Ask the user a question and wait for their reply. Unlike input(), this raises an interrupt so the host (CLI, web UI, etc.) can present the prompt in its own way; the host resolves the interrupt with the answer string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

**Throws:** `std::question`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L104))

### handoff

```ts
handoff(category: string, reason: string, validCategories: string[]): string
```

Re-route the user's current message to a different specialist.
  After you call this, your turn closes and the original message
  is re-routed to the chosen specialist. Anything you say after
  `handoff()` is discarded — return immediately.

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
 * LLM call returns; `route` reads the target via `consumeHandoff`
 * and re-runs the user's original message in the new specialist's
 * thread. The handoff is rejected (with an error string the LLM
 * sees as the tool's result) if `category` isn't in
 * `validCategories`, so the LLM can't accidentally hand off to
 * itself or to an unregistered specialist.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| category | `string` |  |
| reason | `string` |  |
| validCategories | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L191))

### consumeHandoff

```ts
consumeHandoff(): string
```

Read and clear the pending handoff target. Returns "" when no
  handoff was requested. Used internally by `route()`; exposed for
  tests + advanced users writing custom dispatch loops.

* Read and clear the pending handoff target. Used internally by
 * `route` after each LLM call. Exposed for tests and for advanced
 * users writing their own dispatch loop on top of `handoff`.
 * Returns `""` when no handoff was requested.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L224))

### runOneTurn

```ts
runOneTurn(category: string, userMsg: string, config: RouterConfig, allowHandoff: boolean): string
```

Single iteration of route()'s hop loop. If user has given an agent,
  runs the agent. Else runs the prompt.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| category | `string` |  |
| userMsg | `string` |  |
| config | [RouterConfig](#routerconfig) |  |
| allowHandoff | `boolean` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L235))

### runOneTurnAgent

```ts
runOneTurnAgent(category: string, userMsg: string, config: RouterConfig, allowHandoff: boolean): string
```

Single iteration of route()'s hop loop. This version runs
  a custom agent instead of a prompt+tool specialist. The agent
  is expected to handle its own system prompt, tools, memory, and
  handoffs internally. It should return a string reply.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| category | `string` |  |
| userMsg | `string` |  |
| config | [RouterConfig](#routerconfig) |  |
| allowHandoff | `boolean` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L253))

### runOneTurnPrompt

```ts
runOneTurnPrompt(category: string, userMsg: string, config: RouterConfig, allowHandoff: boolean): string
```

Single iteration of route()'s hop loop. Owns the thread block,
  memory scoping, first-entry system-message seeding, and tool-array
  assembly. Returns the LLM's reply (string).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| category | `string` |  |
| userMsg | `string` |  |
| config | [RouterConfig](#routerconfig) |  |
| allowHandoff | `boolean` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L271))

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
 * 2. After the LLM call returns, check `consumeHandoff()`.
 *    - Empty → done, return the LLM's reply.
 *    - Non-empty → loop with the new category, up to `config.maxHops`
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L338))
