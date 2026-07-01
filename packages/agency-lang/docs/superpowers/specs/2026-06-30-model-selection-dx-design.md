# Model & Provider Selection DX for the Agency Agent — Design

Status: Draft (brainstormed + reviewed, pending implementation plan) · 2026-06-30
Scope: `lib/agents/agency-agent/` + supporting stdlib (`stdlib/llm.agency`,
catalog accessor) and the `agency models` CLI.

Supersedes the exploratory draft `model-selection-dx-spec.md` (in
`packages/agency-lang/`). **On merge: delete that draft** — it predates the
decisions here. Review notes that produced this revision:
`2026-06-30-model-selection-dx-design.review.md`.

---

## 1. Background & motivation

smoltalk 0.6.0 (smoltalk commit `11bf763`) added LiteLLM, OpenRouter,
DeepInfra, and openai-compat providers + `registerProvider`, and bakes in the
models.dev catalog with a runtime refresh (`07440b2`, `63876f2`). That closes
the **provider/model reach** gap with OpenHands / opencode / pi.

What remains is the **selection DX** gap: today the only way to choose models
is launch-time flags plus env auto-detection — no in-session switch, no
catalog discovery, and the persisted default isn't honored.

### The central tension

Agency uses **different models for different purposes** (today: a fast model
for routine work, a slow reasoning model for the `oracle`/`explorer`
subagents), and may expand toward Amp-style proliferation
(https://ampcode.com/models). That is at odds with letting a user "pick the
model." The resolution (§3): "pick a model" is **four intents**, only one of
which fights purpose-routing. Omnigent (https://omnigent.ai) frames the
surrounding layer — model routing as policy + non-destructive composition —
which informs the cross-provider/forking calls.

---

## 2. Goals / non-goals

**Goals**

1. In-session switching without restart (`/model`, `/price`, `/models`).
2. A persisted default the agent honors, stored in **agent `settings.json`**.
3. Accept the ecosystem-standard unified `provider/model` string.
4. Hosted discovery: `agency models` + `agency models refresh`.
5. One declarative resolution model spanning slots and the four intents.
6. Live cross-provider switching with state caveats handled (not just warned).
7. A read-side accessor that powers both the "explain" view and tests.

**Non-goals (explicit)**

- **Named profiles** — deferred. (A profile is a saved bundle of §3 intents =
  one more immediacy layer; the matrix leaves room, nothing here builds it.)
- **Subscription / OAuth login** — dropped for now (large, cross-repo).
- **Session forking** — roadmap; depends on session persistence the agent lacks.
- **Project/team-scoped settings** — `settings.json` is per-user.
- **`agency.json` changes** — it stays for compile/runtime client config (API
  keys under `client.apiKey`, base URLs under `client.baseUrl`). Only the
  **model choice** default moves to agent `settings.json` (§3.4, two-file note).

---

## 3. Core architecture

### 3.1 Slot registry

A small, **extensible** set of named purposes. Ship **three**, two user-facing:

| Slot | Today | User-facing | Read by |
|---|---|---|---|
| `main` | "fast" model | yes | run-wide default (`setLlmOptions`) |
| `reasoning` | "slow" model | yes | `oracle`/`explorer` via the resolved slot |
| `embedding` | provider-derived embed model | no (auto) | `std::memory` indexing/recall |

`fast → main`, `slow → reasoning` are kept as CLI **aliases**, resolved to the
canonical slot name **at the CLI boundary, before resolution** (not a hidden
ordering rule). Adding `subagent`, `summarize`, etc. later is additive.

Modeling `embedding` as a slot (per review) collapses the cross-provider
memory special case (§5) into the normal resolution path.

```text
type SlotId = string                              // open registry
SLOTS = ["main", "reasoning", "embedding"]        // shipped
SLOT_ALIASES = { fast: "main", slow: "reasoning" } // CLI-boundary translation
```

### 3.2 The four intents as a 2-D matrix

Model selection is a matrix of **immediacy** (where the instruction comes from)
× **specificity** (how targeted it is). This is *the* resolution spec; §3.3
just states how it's walked.

```text
                  per-slot   global-pin   price-default
   in-session        ·           ·             —
   CLI flags         ·           ·             —
   settings.json     ·           ·             —
   built-in          —           —         priceDefault(provider, slot, price)
```

- **per-slot** — pin one slot (`reasoning = opus`).
- **global-pin** — one model fills *all* slots (the escape hatch; what a future
  fork snapshots; the only intent that collapses routing).
- **price-default** — the curated default for `(provider, slot, price-band)`;
  only the built-in row has it.
- **provider/family constraint** (`allowedProviders`) filters which models are
  eligible and powers `/models` filtering — *Phase 3*, orthogonal to the matrix.

### 3.3 Resolution: immediacy-outer, specificity-inner

**The rule, stated once:** to resolve slot S, walk rows **most-immediate →
least** (in-session → CLI → settings → built-in); within a row, walk columns
**per-slot → global-pin**; return the **first non-empty cell**. If no row
populates a cell, fall to the built-in `price-default`.

> **Decision (immediacy-outer):** this-run flags beat saved settings beat
> built-ins; per-slot beats global-pin only *within* a level. So
> `--model gpt-5.5` (CLI global-pin) overrides a saved `slots.reasoning=opus`
> (settings per-slot) **this run** — matching the universal "CLI flags override
> config" convention and keeping `--model X` a clean escape hatch. The saved
> per-slot value reasserts next run. (This is why review item 1 is *not* a bug.)

**Config is immutable layered.** Each immediacy level is a read-only
`ModelLayer` (built-in, settings, CLI, in-session). Resolution **composes them
at read time** — layers are never mutated in place. Adding a level (profiles
later) = inserting a layer; adding a slot = another key. No imperative steps to
reorder. Implementation is a double loop over (rows, cols), not a switch.

**Context resolved by the same immediacy rule (separately):**

- `provider` = in-session › CLI `--provider` › `settings.model.provider` › env
  auto-detection (`pickProvider`).
- `price` = in-session `/price` › CLI `--price` › `settings.model.price` ›
  `"standard"`.

**Source → cell mapping** (this is the whole behavior table):

| Input | Cell |
|---|---|
| `/model X` (this run) | in-session · global-pin |
| `/model reasoning=X` (this run) | in-session · per-slot[reasoning] |
| `--model X` | CLI · global-pin |
| `--model reasoning=X` | CLI · per-slot[reasoning] |
| `--fastmodel X` / `--slowmodel Y` | CLI · per-slot[main] / per-slot[reasoning] (aliases) |
| `settings.model.pin` | settings · global-pin |
| `settings.model.slots[S]` | settings · per-slot[S] |
| *(nothing)* | built-in · `priceDefault(provider, S, price)` |

**Worked example.** Saved `settings.model.slots.reasoning = "opus"`; run with
`--model gpt-5.5`:
- `main`: first non-empty cell is CLI·global-pin → **gpt-5.5**.
- `reasoning`: in-session (empty) → CLI·per-slot (empty) → CLI·global-pin →
  **gpt-5.5** (the saved per-slot is a lower row; immediacy-outer). Next run
  with no `--model`, `reasoning` → **opus** again.

**`priceDefault` is partial (review item 2).** For a provider absent from the
tiered `MODELS` table (proxy/local like `litellm`), `priceDefault` returns
failure and resolution surfaces the existing "explicit model required" error —
preserving today's `resolveDetected` guard for default-less providers.

### 3.4 State, defaults, validation

- **Persisted choice** → extend the agent `Settings` type
  (`lib/agents/agency-agent/lib/settings.agency`; existing
  `loadSettings`/`saveSettings` over `~/.agency-agent/settings.json`):

  ```text
  type ModelSettings = {
    price?: "economy" | "standard" | "premium"   // default "standard"; Phase 2
    provider?: string                            // tie-break when several keys present
    allowedProviders?: string[]                  // constraint (Phase 3)
    slots?: Record<string, string>               // per-slot override
    pin?: string                                 // global pin
  }
  type Settings = { search?: SearchSettings; model?: ModelSettings }
  ```

- **Slot-key validation (review item 3).** `slots` keys are validated against
  the registry on load. Unknown keys (e.g. a `resoning` typo) are **ignored
  with a one-time warning** — matching `settings.agency`'s tolerant philosophy
  (a bad settings file must never brick startup), but loud enough to notice.

- **Built-in defaults** → today's `MODELS` (`lib/models.agency`) gains a price
  dimension: `priceDefault(provider, slot, price)`. `standard` keeps today's
  values exactly (back-compat); `economy`/`premium` are curated in **Phase 2**
  (Open Q2). Stays pure and unit-testable like `planModels`/`resolveDetected`.

- **Two-file note (review).** Provider *credentials* (`client.apiKey`,
  `client.baseUrl`) stay in `agency.json`; provider *choice* (`provider`,
  `slots`, `pin`, `price`) lives in `settings.json`. Justification: keys are
  secrets/compile-client config with env fallback (most users set them via env
  and never edit `agency.json`), whereas model choice is a runtime preference
  the agent reads and writes. Documented so a reader isn't surprised the two
  live apart.

---

## 4. Surfaces

### 4.1 `/model` — the everyday command

- Picker mirroring `/search` (`chooseOption` over the catalog). Shows the
  current resolved assignment first (via `getResolvedSlots()`, §6).
- **Default action: sets the `main` slot** (in-session · per-slot[main]).
- One keystroke **"apply to all"** → in-session · global-pin.
- Advanced: pick a slot, then a model (sets in-session · per-slot[S]).
- Free-text accepts a unified `provider/model` string (§4.5).
- Registered in `builtinPalette()`; handled in `_runTurn` beside `/search`.

### 4.2 `/price economy|standard|premium` (Phase 2)

Shifts the whole assignment up/down a band without changing routing; persists
to `settings.model.price`. Ships with the curated table (no dead knob).

### 4.3 `/models` — list + filter

Lists the catalog. A bare `/models` prints the **resolved assignment** at the
top (the "explain" view). v1 filter axes (models.dev fields):

| Filter | Notes |
|---|---|
| Provider / family (incl. `local`) | primary axis; also the constraint UI |
| License: open-weights vs proprietary | the "open-source only" toggle |
| Price (`$/1M`) | filter + sort |
| Context window (min) | big-input fit |
| Parameter size | **best-effort** — open-weights disclose it; most closed don't |

Pickers **re-read the catalog on every open** (review item 8) — no in-process
cache, so a sibling-shell `agency models refresh` is picked up next open.

### 4.4 `agency models` / `agency models refresh` (CLI)

Hosted sibling of `agency local`, formatted the same way (mirror
`lib/cli/local.ts`). `refresh` triggers smoltalk's refresh, mirroring
`agency local refresh` exactly (including surfacing failure with non-zero exit,
not swallowing). Shares the catalog accessor (§6).

### 4.5 Unified `provider/model` string

`parseModelSpec(spec) → { provider, model }` (pure, `lib/models.agency`):

- If a provider is already established (`--provider` set, or settings provider),
  **do not split** — the whole `spec` is the model id.
- Else split on the **first `/`** only if the prefix is a **recognized
  provider**, where "recognized" = the **live smoltalk provider list** (open),
  not just `Object.keys(MODELS)`. Otherwise the whole `spec` is a bare model id.
- `local/` is **not** a first-class prefix in v1; local models use
  `--local-model` (unchanged).

> Canonical fixture: `deepseek/deepseek-r1` (it's `MODELS.openrouter.fast`).
> Cases enumerated in §8.

### 4.6 Flags — back-compat + equivalence

- `--model` accepts **either** `slot=model` (→ CLI·per-slot[slot]) **or** a bare
  `model` (→ CLI·global-pin). This replaces a separate `--slot` flag.
  **Hosted models only** — local models use `--local` (§4.7); passing both
  `--model` and `--local` is a validation error.
- `--fastmodel`/`--slowmodel` = aliases for `--model main=…`/`--model reasoning=…`.
- `--provider`, `--price` (new) unchanged in spirit; `--local` is §4.7.
- **Equivalence (state explicitly):** `--model anthropic/claude-opus-4-8` ≡
  `--provider anthropic --model claude-opus-4-8`. `--provider X` alone selects
  X's price-defaults. The unified string is the convenience form; the pair is
  canonical. No semantic difference.

### 4.7 Local models (`--local`)

Local models differ in kind (provider `llama-cpp`, an install/download path, no
embedding endpoint), so they get a **separate, mutually-exclusive** flag rather
than overloading `--model`.

- **Rename:** `--local-model` → **`--local`**; keep `--local-model` as a
  deprecated alias (scripts may use it).
- **Mutual exclusivity:** `--model` (hosted: proprietary or open-weights) and
  `--local` (run locally) cannot both be passed — validation error at parse.
- **`--local <model>`** (curated short name, `hf:` URI, or `.gguf` path)
  resolves to **CLI·global-pin with provider `llama-cpp`** — fills `main` and
  `reasoning` (collapses routing), exactly as today's `configureLocalModel`.
  The `embedding` slot resolves to **none** (llama-cpp has no embed endpoint),
  so tier-2 recall stays disabled — consistent with §3.1 / §5 and today. No
  per-slot local overrides in v1.
- **`--local` with no value → guided setup (interactive TTY):**
  1. Check `hasLocalModelSupport` (smoltalk-llama-cpp installed). If missing,
     print the install command and **suggest the user run
     `! npm i -g smoltalk-llama-cpp`**, then exit — we do not auto-install a
     global package.
  2. If present, show a **picker** (`chooseOption` over the local catalog — the
     interactive form of today's `printLocalCatalog`).
  3. On selection, download if needed (`registerLocalModel`) and **continue
     into the session** on that local model (improves on today's
     print-list-and-exit).
- **Non-interactive** (`--local` bare, no TTY / one-shot): cannot prompt — keep
  today's behavior: print the catalog + install hint and exit.
- **In-session `/local`:** runs the same detect → pick → switch flow. Switching
  to/from local is a provider change, so the §5 recall-disable + turn-boundary
  rules apply.

---

## 5. Cross-provider switching

- **Allowed live**, across any provider including `local` ("live switch now,
  fork later").
- **Within a provider** (Sonnet→Opus): no caveats.
- **Across providers** — the `embedding` slot (§3.1) re-resolves to the new
  provider's embed model, which means the existing on-disk vector index was
  stamped with the *old* embedding model. Rather than return garbage neighbors:
  > **On a switch that changes the resolved `embedding` slot, disable tier-2
  > (vector) recall for the rest of the session**, with a one-time notice:
  > *"Memory recall is off until reindex (provider changed)."* Structured
  > recall is unaffected. The warning fires **once per switch** (review item 5).
- **Turn-boundary semantics (review item 7):** a switch takes effect at the
  **next turn boundary**. An in-flight subagent (e.g. `oracle`) **finishes on
  the previously resolved slot**; no model changes mid-call.
- **Forking** (fresh session on the new model, original untouched) is the clean
  fix and is **roadmap** — it needs session persistence the agent lacks today.

Implementation of a live switch: recompose the in-session layer, then apply the
newly resolved `main`/`reasoning` (and `embedding`) at the next turn.

---

## 6. New APIs / dependencies

| Need | Where | Blocks |
|---|---|---|
| **Hosted catalog as queryable data** (`listHostedModels(filter?)`, `modelInfo(name)`, incl. license/price/context/param-size) | smoltalk export → `stdlib/llm.agency` | `agency models`, pickers, all filters |
| `getResolvedSlots(): Record<SlotId, {model, provider, via}>` — **single** read accessor (replaces the mooted `getModel`/`getLlmOptions`) | `stdlib/llm.agency` or `shared.agency` | `/model` "Current" view, `/models` explain, agent-turn tests |
| `applyResolved(slots)` — apply resolved `main`/`reasoning`/`embedding` at a turn boundary | `shared.agency` (wraps `setLlmOptions` + slow/embedding state) | live switch |
| `getModelSettings()` | `settings.agency` | resolution |
| Tiered `MODELS` + `priceDefault` + `parseModelSpec` (pure) | `lib/models.agency` | defaults, unified string |

`via` on `getResolvedSlots()` is the winning cell (e.g. `"CLI·global-pin"` /
`"settings·slots"` / `"built-in·price=standard"`) — this is the explain view's
data and the testable seam, in one place.

**The catalog accessor is the one hard external prerequisite.** It relates to
`2026-06-27-model-catalog-refresh-design.md` and
`2026-06-29-smoltalk-hosted-providers-design.md` — confirm whether the baked
catalog is already exposed as data or only consumed internally (Open Q1).

---

## 7. Phasing

| Phase | Lands | Dependency |
|---|---|---|
| **1** | Slot registry (`main`/`reasoning`/`embedding` + `fast`/`slow` aliases); the immediacy×specificity matrix over immutable layers; `settings.model` (`provider`/`slots`/`pin`) honored; `parseModelSpec` unified string + `--model slot=model`; `/model` free-text live switch (cross-provider w/ recall-disable + turn-boundary); `getResolvedSlots`/`applyResolved`; `--local` rename (alias kept) + guided setup + `/local`; **`standard`-only** defaults | none — ship now |
| **2** | Catalog accessor → `agency models` + `agency models refresh`; `/model` & `/models` **pickers with filters**; **`/price` + curated `economy`/`premium`** columns | smoltalk catalog-as-data |
| **3** | Provider/family **constraint** (`allowedProviders`, built on filters) | Phase 2 |
| **Roadmap** | Session persistence → **forking**; more slots (`subagent`, `summarize`) | larger, separate |

Phase 1 has **zero external deps**. The price knob ships in Phase 2 *with* its
curated table (no dead knob — review item 9). The catalog accessor gates Phase 2.

---

## 8. Testing

Read-side seam: **`getResolvedSlots()`** makes both pure and agent-turn tests
assert resolved `(model, provider, via)` directly — no statelog needed for the
happy path.

### 8.1 Resolution matrix — one test per boundary (pure, `lib/models.agency`)

Assert against the returned resolution (extends the `planModels` I/O pattern):

1. in-session per-slot ▷ in-session global-pin
2. in-session ▷ CLI per-slot
3. CLI per-slot ▷ CLI `--model` (global-pin)
4. CLI `--model` (global-pin) ▷ `settings.slots` *(immediacy-outer — the
   flipped item-1 case: `slots.reasoning=opus` + `--model gpt-5.5` →
   `reasoning = gpt-5.5`)*
5. `settings.slots` ▷ `settings.pin`
6. `settings.pin` ▷ `priceDefault`
7. `priceDefault(provider, slot, "standard")` = today's value, per provider
   (locks the back-compat promise)
8. `priceDefault` for a provider absent from the tiered table → failure (item 2)

### 8.2 `parseModelSpec` — five cases

1. `openrouter/deepseek/deepseek-r1` + `--provider openrouter` → model
   `deepseek/deepseek-r1`, provider unchanged.
2. `openrouter/deepseek/deepseek-r1`, no provider → `openrouter` +
   `deepseek/deepseek-r1`.
3. `deepseek/deepseek-r1` + `--provider openrouter` → **not split**; model is
   the whole string.
4. `gpt-5.5` → model `gpt-5.5`, provider unset.
5. `unknown-vendor/some-model` → **not split** (unknown prefix); whole string.

### 8.3 Back-compat regression set (highest value — existing tests stay green)

- `--model X` alone pins **both** slots to X (Open Q4, now **confirmed** —
  `planModels` sets `fastModel`@178 and `slowModel`@190).
- `--model X --slowmodel Y` → main=X, reasoning=Y.
- `--fastmodel X --slowmodel Y`, no `--model` → main=X, reasoning=Y, no defaults.
- `--provider openai`, no model → both slots `MODELS.openai.{fast,slow}`,
  `slowProvider = openai-responses` (preserve `openaiDetectedRoutesBothToResponses`).
- `--provider litellm`, no model → failure (`litellmWithoutModelIsError` stays).

### 8.4 Settings + slot-key validation

- Round-trip: `loadSettings` → mutate `settings.model.slots.main` →
  `saveSettings` → reload → structural equality (clone the `search` pattern in
  `settings.test.json`).
- `slots.resoning = "opus"` (typo) and `slots.unknown = "x"` → ignored + warned.

### 8.5 Cross-provider switch (agent-turn / unit)

- anthropic → openai mid-session: memory-recall-disabled notice emitted
  **once**; next call routes through openai; in-flight slow call finishes on the
  original provider (turn-boundary).

### 8.6 Catalog + CLI (Phase 2)

- `agency models refresh` invokes smoltalk refresh **exactly once**; refresh
  failure → non-zero exit, not swallowed.
- `agency models` format snapshot (mirror `lib/cli/local.test.ts`).
- **Filters: one test per axis** (provider, license, price, context, param-size)
  **+ one combined multi-axis** — otherwise a Phase-2 filter regression is
  invisible.

### 8.7 Local models (`--local`)

- `--model X --local Y` together → validation error at parse.
- `--local <model>` → CLI·global-pin, provider `llama-cpp`, `embedding` slot
  none, tier-2 recall disabled.
- `--local-model <model>` (deprecated alias) behaves identically to `--local`.
- Bare `--local`, non-interactive (no TTY) → prints catalog + install hint and
  exits; no prompt.
- Guided setup: `hasLocalModelSupport` false → install hint + exit (no picker);
  true → picker shown (assert via the catalog accessor, no real download).

No new LLM calls — selection is entirely pre-`llm()`.

---

## 9. Resolved questions

- **Q4 (closed, confirmed):** `--model X` pins both slots (CLI·global-pin),
  verified against `planModels` (lines 178, 190). No hedge.
- **Outer axis (decided):** immediacy-outer (§3.3).
- **Item 5 (decided):** cross-provider switch disables tier-2 recall for the
  session (§5).
- **Item 9 (decided):** price knob + curated columns land in Phase 2.

## 10. Open questions

1. **Catalog exposure (sizes Phase 2):** does smoltalk export the baked
   models.dev catalog as queryable data with license/price/context/param-size,
   or only consume it internally?
2. **Price-table curation:** concrete `economy`/`premium` picks per provider for
   `main` and `reasoning` (`standard` = today's values).
3. **`--price` CLI flag in v1**, or settings + `/price` only? (Leaning: add it
   in Phase 2 alongside the knob.)

## 11. Limitations

- Price defaults are only as good as the curated table (Open Q2).
- Cross-provider recall is **handled** (disabled-until-reindex), not solved;
  full fidelity needs reindex or forking.
- Parameter-size filtering is best-effort (unavailable for most closed models).
- This extends fast/slow into a slot registry; it does not introduce true
  per-message routing. Amp-style proliferation is *enabled* (additive slots),
  not built here.
```
