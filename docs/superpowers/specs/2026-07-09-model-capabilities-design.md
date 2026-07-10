# Design: Declarative model capabilities + /settings command

**Status:** design approved in brainstorm 2026-07-09; not yet planned.
**Idea doc:** `docs/superpowers/ideas/2026-07-09-model-capabilities.md` (carries the full bug narrative).
**Companion ideas (separate tracks):** `2026-07-09-async-background-work.md`, `2026-07-09-statelog-hidden-calls.md`.

## Why

The agency agent runs on models from opus-4-8 down to SmolLM2-135M, but its
features assume one capability profile. The assumptions live in scattered
conditionals or nowhere at all. This bit hard on 2026-07-09: the eager thread
summarizer — free on hosted models — ran away on qwen3.5-2b and blocked every
reply behind a hidden LLM call that never finished (see memory file
`eager-summarize-local-hang.md` and the idea doc). Other standing examples:
memory needs an embeddings endpoint that Anthropic and llama-cpp don't have;
the ~3,400-token coordinator prompt eats 40% of an 8K-context model.

This design gives the agent a declarative capability table per model, with
provider-level and global fallbacks, user overrides, and a `/settings` UI.

## Decisions made in the brainstorm

1. **Agent-local table only.** No stdlib-level capability registry. The table
   lives in agent code and can iterate freely.
2. **Lookup: exact model name → provider default → global default.**
3. **V1 fields: `prompt` (large/small), `summarize` (on/off), `memory`
   (on/off), `maxTokens` (number | null).**
4. **Cross-provider memory reuses the slot system.** The table only holds
   memory on/off; "memory on OpenAI while main is Anthropic" is an embedding-
   slot assignment through the existing `model.slots` settings + resolution
   machinery.
5. **UI: a new `/settings` REPL command** (generic name; capabilities first,
   other settings can move in later).
6. **User overrides are three-tier like the built-ins** (per-model /
   per-provider / global). Full precedence: user model > user provider >
   user global > built-in model > built-in provider > built-in global.
   Consequence (intentional): a user global override beats a built-in model
   entry.
7. **API-key validation at both set-time and startup.** Set-time refuses;
   startup degrades with a notice.

## 1. Data model and resolution

New module `lib/agents/agency-agent/lib/capabilities.agency` (pure, mirrors
`slots.agency`):

```
type Capabilities = {
  prompt: string;            // "large" | "small"
  summarize: boolean;
  memory: boolean;
  maxTokens: number | null   // null = no cap
}

// Partial — an entry states only what it changes
type CapabilityPatch = {
  prompt?: string;
  summarize?: boolean;
  memory?: boolean;
  maxTokens?: number
}

static const GLOBAL_DEFAULT: Capabilities = {
  prompt: "large", summarize: true, memory: true, maxTokens: null
}

static const PROVIDER_CAPABILITIES: Record<string, CapabilityPatch> = {
  // No embeddings endpoint. Matches the owner's sketch; CHANGES today's
  // behavior (memory currently enables for anthropic with a degraded-tier
  // notice). Users flip it back on by assigning the embedding slot to a
  // provider that has embeddings, or via /settings.
  "anthropic": { memory: false },
  // Small/local safety profile. Any un-curated local model lands here.
  "llama-cpp": { prompt: "small", summarize: false, memory: false, maxTokens: 2000 }
}

static const MODEL_CAPABILITIES: Record<string, CapabilityPatch> = {
  // Curated exceptions, grown over time, e.g.:
  // "smollm2-135m": { maxTokens: 1000 }
}
```

**Resolution is per-field.** Each of the four fields resolves independently
through the six layers (decision 6). The result is a total `Capabilities`
value; `GLOBAL_DEFAULT` guarantees totality.

**Keying.** Capabilities key off the **main slot's resolved model**: the
curated short name for local models (`configureLocalModel` has it before it
becomes a .gguf path), the canonical model name for hosted ones. The provider
key is the resolved provider string the slot system already produces. One
profile per session — the reasoning slot does not get its own profile in v1.

**When resolution runs.** At startup immediately after
`configureModels`/`configureLocalModel`, cached behind a `getCapabilities()`
accessor (same pattern as `_resolved` + `getResolvedSlots()`). It re-runs at
the `applyResolved` chokepoint so a mid-session `/model` switch re-derives
capabilities immediately.

## 2. Consumption — the four wiring points

- **summarize** → `thread(label: "main", summarize: getCapabilities().summarize,
  session: "main")` in `mainAgent` (`agent.agency:906`). Data, not branching.
- **memory** → `if (getCapabilities().memory) { enableAgentMemory() }`,
  replacing the hosted-vs-local conditional at `agent.agency:1395-1403`.
- **maxTokens** → applied once at startup via `setLlmOptions({ maxTokens })`
  when non-null. Branch-scoped default; per-call `llm(..., { maxTokens })`
  still wins, so the summarizer's own 256 cap is unaffected.
- **prompt** → the coordinator selects `LARGE_PROMPT` / `SMALL_PROMPT` at
  `systemMessage` time. **Content lift:** v1 writes a small variant for the
  coordinator only (the 3.4K-token offender). Subagent prompt trimming is a
  follow-up.

## 3. The /settings command

New REPL command registered alongside `/model`.

**Display.** For the currently resolved main model, one row per field showing
the effective value and its source layer, e.g.:

```
summarize   off     (provider default: llama-cpp)
prompt      large   (your override for qwen3.5-2b)
memory      off     (provider default: llama-cpp)
maxTokens   2000    (provider default: llama-cpp)
```

Source visibility is what keeps six-layer resolution debuggable.

**Editing.** Pick a field → pick a value → pick scope: *this model* (default)
/ *this provider* / *all models*. Writes settings.json:

```json
{ "capabilities": {
    "models":    { "qwen3.5-2b": { "prompt": "large" } },
    "providers": { "llama-cpp": { "summarize": true } },
    "global":    {}
} }
```

Loaded with warn-and-drop sanitization for unknown fields and non-object
entries, mirroring `sanitizeModelSettings`.

**Taking effect.** After an edit, capabilities re-resolve immediately.
`summarize` and `maxTokens` apply from the next turn. `memory` toggles live
(`enableAgentMemory` / `disableMemory`). `prompt` applies on next agent start
(the session's system message is already sent); `/settings` states this
inline when the user changes it.

## 4. Cross-provider memory validation

- **Set-time:** assigning the embedding slot to a provider (via `/model` or
  `/settings`) checks `envVarFor(provider)` (std::llm) against the
  environment. Missing key → refuse with a concrete message ("OPENAI_API_KEY
  not set — export it or pick another provider"). Never save a setting that
  cannot work.
- **Startup:** re-check every launch (env changes between sessions). Missing
  key → disable memory for the run with a one-line notice. Never crash.

## 5. Edge cases

- Unknown local model → `llama-cpp` provider default (the safe, small-model
  direction). Unknown hosted model → its provider's patch, else global.
- settings.json without a `capabilities` key (all existing installs) → pure
  built-ins. No migration needed.
- One-shot `-p` runs resolve capabilities identically; `/settings` is
  REPL-only.
- Subagents inherit `maxTokens` automatically via branch llm defaults.

## 6. Testing

- **Resolution merge:** pure function → agency execution tests covering
  per-field six-layer precedence, including "user global beats built-in
  model".
- **Settings load/sanitize:** unit tests mirroring the existing settings
  tests (unknown fields, unknown scopes, corrupt file → empty).
- **Regression tie-in:** an agent-harness test asserting that with
  `summarize: false` a turn emits exactly one `promptCompletion` and no
  summarizer call — the exact signature of the 2026-07-09 bug.
- **Key validation:** unit tests for the env-check helper (present, missing,
  unknown provider).

## Out of scope (follow-ups)

- Small-prompt variants for subagents.
- Per-slot capability profiles (reasoning model differing from main).
- Additional capability fields (tool-count limits, structured-output
  reliability — the llama.cpp grammar-not-honored bug is a separate
  investigation).
- Moving other settings (search backend) into `/settings`.

## Addendum (2026-07-09, post plan review): approved deviations

1. **`CAPABILITY_DEFAULT.maxTokens` is `20000`, not `null`.** The agent
   already raises smoltalk's 4096 default to 20000 in a TEMPORARY
   `setLlmOptions` block, because an adaptive-thinking turn can spend the
   whole 4096 budget thinking and return an empty reply. The capability
   table takes ownership of that number and the temporary block is deleted.
   `null` stays representable ("skip the setLlmOptions call") but no
   built-in layer uses it.
2. **Cross-provider memory + embedding-slot key validation is descoped**
   (owner approved 2026-07-09). The embedding slot is a no-op end to end
   today: resolution yields an empty model/provider, `applyResolved` skips
   the `derived` kind, and `enableMemory` receives only `dir`. V1 gates
   memory purely on the capability field. Follow-up: spike std::memory's
   embed path (its config has `embeddings.model` but no provider field),
   wire the resolved embedding slot into `enableMemory`, and add key
   validation there.
3. **The §6 summarize-regression harness test ships as manual
   verification**, because the assertion needs a working local model on
   the machine. Recorded as a plan Task 7 step; revisit if the agent test
   harness grows a mock-LLM statelog assertion path.
