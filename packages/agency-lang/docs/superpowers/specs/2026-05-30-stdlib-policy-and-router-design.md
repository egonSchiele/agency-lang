# Stdlib Policy Helpers + Router — Design

## Problem

The Agency Agent (`lib/agents/agency-agent/`) accreted two big mechanisms
that are not agent-specific and should be reusable across other Agency
programs:

1. **An interactive policy handler** — the chain of "check policy → ask
   the user with (a)/(r)/(aa)/(ap)/(rr) → record the decision →
   approve/reject the interrupt → persist to disk" lives entirely in
   `agent.agency`. Any CLI agent that wants the same UX has to copy
   ~150 lines of `defaultHandler` + `askUser` + scoped-match builders.

2. **A multi-agent router** — the hop loop, the `handoff` LLM tool, the
   handoff-target signal, the force-answer fallback, and the
   per-category thread/memory wiring add another ~100 lines spread
   across `agent.agency`, `shared.agency`, `code.agency`,
   `research.agency`. Anyone building a multi-specialist agent
   re-implements all of it.

The recently shipped typechecker rule that forbids handlers from
raising interrupts ([docs/site/guide/handlers.md#handlers-cant-raise-interrupts](../../packages/agency-lang/docs/site/guide/handlers.md))
also makes the policy code's load/save lifecycle subtler to get right.
A reusable abstraction can encode the correct pattern once.

Goal: lift both mechanisms into the standard library so a CLI agent
becomes a small declaration plus a few hand-written tools, while
leaving the door open for non-CLI (web, IPC) consumers to reuse the
pure parts.

## Non-goals

- A web/HTTP policy adapter. The web case is sketched in the policy
  section and supported by the pure primitives, but we ship no web
  helper this round. First web user proves out the shape.
- A non-loop routing scheme (e.g. parallel dispatch, fan-out). The
  hop loop is the abstraction; weirder shapes are user-implemented.
- Per-runner custom turn logic (multiple `llm()` calls per turn,
  preprocessing, custom thread setup). The router is declarative —
  `systemPrompt + tools + memory` — and intentionally rigid for v1.
  An escape hatch (`runners: { ... }`) can be added later if needed.
- Lifting `Workspace` / `setCwd` / per-agent-specific tool bundles
  into the router. Those stay in user code.

## What already exists

[`stdlib/policy.agency`](../../packages/agency-lang/stdlib/policy.agency)
already exports the policy primitives:

- `checkPolicy(policy, interrupt) → approve | reject | propagate`
- `validatePolicy(policy) → { success, error? }`
- `writePolicyFile(path, policy, allowedPaths)`
- Types: `Policy`, `PolicyRule`, `InterruptDataKey`, `InterruptDataVal`,
  `InterruptKind`

The runtime side (`lib/runtime/policy.ts`) supports rules with a
`match` map keyed by `origin`, `message`, or any top-level
`interrupt.data` field; values are picomatch globs. First-matching
rule wins inside `checkPolicy`.

No router-related primitives exist in stdlib today.

## Design

The change splits into two independent stdlib additions:

1. **Extensions to `stdlib/policy.agency`** — pure recording primitives
   plus a CLI sugar handler.
2. **Router added to `stdlib/agent.agency`** — declarative multi-agent
   router exported from the existing `std::agent` module.

### 1. Policy extensions

#### 1.1 New types

```agency
export type Decision =
  | "approve"
  | "reject"
  | "approve-always"
  | "approve-always-here"
  | "reject-always"
// Note: intentionally no `reject-always-here`. Reject-always is rare
// in practice; scoped reject is rarer still. Add later if asked.

export type FieldSpec = {
  field: string;            // top-level key in interrupt.data
  wildcardSubpaths: boolean // true → brace-expand "foo" → "foo,foo/**"
}

export type AlwaysFields = Record<InterruptKind, FieldSpec[]>
```

`AlwaysFields` is the per-kind config the user passes when they want
the "approve-always-here" option to record a scoped rule. Kinds not
present in the map fall back to the four-option prompt (a/r/aa/rr) —
no `ap` offered.

#### 1.2 Pure recording primitives

```agency
export def recordRule(
  policy: Policy,
  kind: InterruptKind,
  action: "approve" | "reject",
): Policy
```

Returns a new policy with a bare (catch-all) rule appended for `kind`.
First-match-wins in `checkPolicy` means a single bare rule covers every
future interrupt of that kind. Pure — no I/O.

```agency
export def recordScopedRule(
  policy: Policy,
  intr: Record<string, any>,
  fields: AlwaysFields,
): Policy
```

Returns a new policy with a *scoped* approve rule prepended (so the
more-specific rule wins over a later catch-all if any). The match
object is built from the kind's `FieldSpec[]` entries: each field
pulls the value from `intr.data[field]`; `wildcardSubpaths: true`
brace-expands the value to also match subpaths
(`"/Users/x" → "{/Users/x,/Users/x/**}"`). Pure.

```agency
export def buildScopedMatch(
  intr: Record<string, any>,
  fields: AlwaysFields,
): Record<string, string>
```

The match-object builder behind `recordScopedRule`, exposed because
the prompt UI needs it to render the "approve always where dir=..."
preview before the user commits. Pure.

```agency
export def parsePolicyFile(path: string): Policy
```

Read + parse a policy file from disk, returning the validated
`Policy`. Wraps `read` + `parseJSON` + `validatePolicy` with the
warn-and-return-empty behavior of the agent's current `loadPolicy`
helper (so a missing, unreadable, malformed, or invalid file does
**not** throw — it warns and returns `{}`). Raises `std::read`,
hence the `with approve` usage in the flip-flag example below.

These four primitives are the only ones any non-CLI consumer (web,
IPC, custom workflow) needs on top of the existing
`checkPolicy` / `validatePolicy` / `writePolicyFile`.

#### 1.3 CLI sugar: `cliPolicyHandler`

```agency
export def cliPolicyHandler(opts: {
  file: string;
  fields: AlwaysFields;
}): (intr: any) => any
```

Returns a *function* that the user passes to `handle { ... } with`.
The returned function:

1. On first invocation, lazy-loads the policy from `opts.file` via
   `with approve`. Subsequent invocations reuse the in-memory copy.
   The lazy load uses the [flip-flag-first](../../packages/agency-lang/docs/site/guide/handlers.md#handlers-cant-raise-interrupts)
   pattern so the read interrupt's re-entry into the handler
   short-circuits cleanly.
2. Calls `checkPolicy(policy, intr)`. If a rule matches, returns
   approve/reject without prompting.
3. Otherwise, prompts the user with the (a)/(r)/(aa)/(ap)/(rr) menu.
   `(ap)` (approve-always-here) is offered only when `opts.fields`
   has an entry for `intr.kind`. The (a)/(r) options end the round;
   `(aa)`/`(rr)` call `recordRule` and persist; `(ap)` calls
   `recordScopedRule` and persists.
4. Rejection offers a follow-up free-text "Why are you rejecting?"
   prompt; the answer becomes `reject(reason)`, so the LLM sees
   concrete feedback as the tool's return value.

Persistence happens *inside* the handler body — `with approve` on
the write. There is no way to avoid this without giving up the
"writes are gated by interrupts" guarantee. Two complementary
mechanisms keep it safe:

**Runtime: flip-flag-first re-entry guard.** Both the lazy load and
each save use the flip-flag-first pattern documented in
[handlers.md §"Fixing it"](../../packages/agency-lang/docs/site/guide/handlers.md).
Illustrative sketch (real call sites pass the full signatures —
`writePolicyFile(path, policy, allowedPaths)` etc.):

```agency
let loaded: boolean = false
let pendingSave: boolean = false

def maybeFlush() {
  if (pendingSave) {
    pendingSave = false                                 // flip FIRST
    writePolicyFile(opts.file, policy, []) with approve // re-enters; guard short-circuits
  }
}

def maybeLoad() {
  if (!loaded) {
    loaded = true                                       // flip FIRST
    policy = parsePolicyFile(opts.file) with approve    // re-enters; guard short-circuits
  }
}
```

The order matters: flip the flag *before* the interrupt-raising
call, not after. The re-entered handler invocation sees the flag
already flipped and returns without recursing. The agent's existing
`ensurePolicyLoaded` is the canonical example.

**Compile-time: `// @tc-ignore` at the user's `handle` site.** The
handler-interrupt typechecker rule is structural — it fires on any
transitive interrupt call in the handler body, regardless of whether
runtime guards prevent recursion. Since `cliPolicyHandler` *must*
do I/O (read/write/input are all interrupts), users have no choice
but to suppress the diagnostic at the call site:

```agency
// @tc-ignore — cliPolicyHandler is the documented "unavoidable
// I/O in handler" case; runtime flip-flag-first prevents recursion.
handle { ... } with cliPolicyHandler
```

This is exactly the escape-hatch case the typechecker docs already
flag. The stdlib helper itself is a `def` whose body raises the
interrupts honestly; we do not invent a special "trusted handler"
exemption.

**Save granularity.** The flush runs whenever the handler is next
invoked. A decision recorded on the *final* interrupt of a session
(no later interrupts before the program exits) will not be written
to disk. Acceptable per the existing module-level note in
`agent.agency` — losing one decision is better than crashing the
REPL. An optional `flushPolicy()` export lets users force a write
between turns if they care.

**Library-state-is-singleton contract.** `cliPolicyHandler` stores
the active `Policy`, `opts.file`, `opts.fields`, and the in-flight /
pending-save flags in **module-level state inside
`stdlib/policy.agency`**. Calling `cliPolicyHandler` more than once
in the same program silently overwrites that state — the
second-to-last call's `file` and `fields` are lost. The handler
contract is therefore **call exactly once per program**, install on
the outermost `handle`. If users need multiple independent policy
files within one program (rare), they fall back to the pure
primitives + their own I/O.

If users hit the other edge cases — concurrent agent instances
writing the same file, atomic-write requirements, etc. — they also
fall back to the pure primitives.

### 2. Router: extension of `stdlib/agent.agency`

Lives alongside `todoWrite`, `todoList`, and `question` in the existing
`stdlib/agent.agency` module. The router is one *coordination strategy*
for building agents; future strategies (supervisor/worker, parallel
dispatch, pipeline, single-agent loop) will sit alongside it under the
same `std::agent` namespace. No new module file.

#### 2.1 Types

```agency
export type AgentSpec = {
  systemPrompt: string;
  tools: any[];
  memory?: boolean;   // default false
}

export type RouterConfig = {
  start: string;
  agents: Record<string, AgentSpec>;
  maxHops: number;
  context?: string;   // appended verbatim to every systemPrompt
}
```

#### 2.2 The function

```agency
export def route(config: RouterConfig, userMsg: string): string
```

Returns the final LLM reply (string).

**Behavior**, per invocation:

1. Start at `category = config.start`. Initialize `hop = 0`.
2. Loop:
   a. Open the per-category thread session
      (`thread(session: category, label: category, summarize: true) { ... }`).
   b. If `config.agents[category].memory == true`, call
      `setMemoryId(category)`.
   c. If this is the first time the router has entered this thread
      session in the current program lifetime, call
      `systemMessage(systemPrompt + (context ?? ""))`. Router tracks
      "first entry per session" in module-level state — persists
      across multiple `route()` calls within one program (so the
      system prompt is **not** re-seeded each turn of a REPL loop)
      and rehydrates through checkpoint restore via the same
      GlobalStore path as today's `codeFirstEntry` flag.
   d. Build the tool array: `[...config.agents[category].tools,
      handoff.partial(validCategories: <all categories except this one>)]`.
      Drop the `handoff` entry when in fallback mode (step 4).
   e. Call `llm(userMsg, { memory: <category's memory flag>,
      tools: <built array> })`. Capture the reply.
   f. Read `consumeHandoff()`. If empty, return the reply.
   g. Otherwise, set `category` to the handoff target, increment
      `hop`. The next iteration re-uses the **original** `userMsg` —
      handoff means "this message belongs to a different specialist",
      not "advance the conversation". (Matches today's
      `runForCategory(category, userMsg, ctx)` behavior in
      `agent.agency`.) If `hop < maxHops`, goto (a).
3. If we exit the loop because `hop == maxHops`, set "fallback mode"
   on, run one more iteration of (a)–(e), return that reply.
4. **Fallback mode** strips the `handoff` tool from (d) so the LLM
   has no escape. Mirrors `runForCategory(allowHandoff: false)` in
   `agent.agency` today.

The router owns:
- the handoff-target slot (a module-level `let _handoffTarget = ""`
  + `pushHandoff` / `consumeHandoff` plumbing — moved here from
  `shared.agency`)
- the `handoff` tool itself (declared here, takes `(category, reason,
  validCategories)`, validates the target, sets the slot, returns the
  "Handoff scheduled" filler string)
- the per-category first-entry-system-message flag map
- the hop loop and fallback mode

The user owns:
- the system prompt per category
- the tools array per category
- any module-level state their tools depend on (e.g. the agent's
  `workspace` bundle + `setCwd`)
- the per-turn invariants string (`context`)

#### 2.3 Scope of `_handoffTarget`

Module-level `let` lives in the per-RuntimeContext `GlobalStore`, so
two concurrent agent runs in the same process are isolated. Two
**parallel threads inside the same run** would race on the slot. We
do not solve this for v1 — documented as a constraint. Use case is
hypothetical (the agent today has no parallel-runner pattern), and
the fix (per-thread slot) is straightforward to retrofit.

#### 2.4 Edge cases

- `config.start` not in `config.agents`: throw at the router entry.
- A handoff target not in `config.agents`: the `handoff` tool's
  `validCategories` check already rejects this — the LLM sees an
  error string as the tool's result and continues without state
  change.
- `maxHops <= 0`: treat as 0, run one iteration in fallback mode.
- An `AgentSpec` with empty `tools`: legal (the handoff tool is
  still injected unless in fallback).

## How the Agency Agent collapses

Before (rough):

```
lib/agents/agency-agent/
├── agent.agency       ~500 lines (defaultHandler, hop loop, ...)
├── shared.agency      ~150 lines (handoff plumbing)
├── code.agency        ~150 lines (runCode + allowHandoff)
├── research.agency    ~150 lines (runResearch + allowHandoff)
```

After:

```ts
// agent.agency, in full (sketch)
import { route } from "std::agent"
import { cliPolicyHandler } from "std::policy"
import { codeSysPrompt, codeTools } from "./code.agency"
import { researchSysPrompt, researchTools } from "./research.agency"
import { ALWAYS_FIELDS } from "./fields.agency"

node main() {
  printBanner()
  const ctx = "\nDate: ${today()}\nCWD: ${cwd()}\n${loadAgentsMd(cwd())}"
  const handler = cliPolicyHandler({
    file: "${env(\"HOME\")}/.agency-agent/policy.json",
    fields: ALWAYS_FIELDS,
  })
  let userMsg = input("> ")
  while (userMsg != "exit") {
    handle {
      const reply = route({
        start: "code",
        agents: {
          code:     { systemPrompt: codeSysPrompt,     tools: codeTools,     memory: true },
          research: { systemPrompt: researchSysPrompt, tools: researchTools, memory: true },
        },
        maxHops: 3,
        context: ctx,
      }, userMsg)
      print(highlight(reply, language: "markdown"))
    } with handler
    userMsg = input("> ")
  }
}
```

`code.agency` and `research.agency` shrink to: the system prompt
string, the workspace/state, the safe-def tools (like `setCwd`), and
an exported tools array. No `runCode`/`runResearch`, no
`allowHandoff`, no `handoff.partial`, no first-entry flag.

`shared.agency` deletes the handoff plumbing entirely (now in
`std::agent`). `AgentContext` becomes just `context: string` on the
router call site.

`defaultHandler`, `loadPolicy`, `savePolicy`, `policyDir`,
`policyPath`, `ensurePolicyLoaded`, `recordAlways`,
`recordAlwaysScoped`, `buildScopedMatch`, `describeScopedMatch`,
`askUser`, `Decision` type, the `policy`/`policyLoaded` module state,
`ALWAYS_FIELDS` (if kept agent-specific) — all replaced by the single
`cliPolicyHandler` call.

Net deletion: ~300 lines from the agent. The agent reads as
"here's my context, here's two specialists, route between them."

## Testing

### Policy primitives

Unit tests in `tests/stdlib/policy-primitives.test.ts`:
- `recordRule` adds bare rule, preserves existing rules.
- `recordScopedRule` prepends scoped rule, builds correct match
  object from `FieldSpec[]`, brace-expands when
  `wildcardSubpaths: true`.
- `buildScopedMatch` handles missing fields gracefully, empty
  `fields` map, kinds not present.

### CLI policy handler

Integration test under `tests/agency-js/` driving the handler with
mocked `input()` responses and a temp policy file:
- First interrupt of kind X with no policy: prompts, "a" approves.
- Second interrupt of kind X after "aa": auto-approved, no prompt.
- "ap" with `fields[X]` set: prompts, records scoped rule, second
  interrupt with matching data auto-approves; mismatching data
  still prompts.
- "ap" with `fields[X]` *not* set: option is hidden from the prompt.
- Reject with reason: `intr.value` carries the reason string.
- Persistence: kill the handler, reload, prior decisions still
  effective.

### Router

Agency tests under `tests/agency/`:
- Single-agent run (no handoff possible) returns LLM reply.
- Two-agent run, handoff fires, second agent answers, reply returned.
- Hop limit reached: fallback mode runs, no `handoff` tool in the
  final LLM call, reply returned.
- Per-category memory scoping: `setMemoryId(category)` called when
  `memory: true`.
- First-entry system message: seeded once per session per run.
- Invalid handoff target: tool returns error string, no state change.

### Agent regression

The agency-agent integration suite (whatever currently exercises
`agent.agency`) must keep passing after the agent is rewritten to
use the new stdlib. This is the load-bearing acceptance test for
the design.

## Open questions / risks

- **Deferred-flush correctness**: the "flush on next invocation"
  scheme means the final decision of a session is never written to
  disk unless another interrupt follows. Acceptable per the policy
  module docstring (losing one decision is better than crashing),
  but worth flagging. An optional `flushPolicy()` export lets users
  force a write between turns.
- **First-entry-per-session tracking**: lives in router module state.
  After a checkpoint restore, that state must rehydrate correctly
  (it's a module-level `let`, so it goes through GlobalStore — same
  as today's `codeFirstEntry`). Worth a focused test.
- **Coupling of `_handoffTarget` to the router**: moving the slot
  from `shared.agency` into `std::agent` means any non-router
  consumer of `handoff()` breaks. Mitigation: the `handoff` tool
  also moves into `std::agent`, and nothing outside the agent
  currently calls it. Greenfield change.

## File summary

- **Modify**: `stdlib/policy.agency` (+ types, + primitives, +
  CLI helper).
- **Modify**: `stdlib/agent.agency` (+ `route` + `handoff` +
  `AgentSpec` / `RouterConfig` types + internal handoff-target
  plumbing).
- **Modify**: `lib/agents/agency-agent/agent.agency`,
  `shared.agency`, `code.agency`, `research.agency` — collapse onto
  the new stdlib (this is the regression test, not the change
  itself).
- **Tests**: `tests/stdlib/policy-primitives.test.ts` (new),
  policy + router integration tests under `tests/agency-js/` and
  `tests/agency/` (new), plus the existing agent integration suite
  (must keep passing).
