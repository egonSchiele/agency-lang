# Model Selection DX — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. (Per project preference, do NOT use subagent-driven development — implement directly in the main session.)

**Goal:** Ship the dependency-free slice of the model-selection design: a named-slot registry with a `SLOT_KIND` dispatch table, an immutable-layer × specificity resolution matrix, persisted model settings, the unified `provider/model` string with `--model slot=model`, the `--local` rename + guided setup, and an in-session `/model` switch — all back-compatible with today's flags.

**Architecture:** Model selection resolves, per *slot* (`main`/`reasoning`/`embedding`), by walking immutable **layers** most-immediate→least (in-session → CLI → settings → built-in); within a layer, per-slot beats global-pin; first non-empty cell wins; built-in falls to today's `planModels` defaults. Slot-specific behavior is keyed on a closed `SLOT_KIND` enum (`fast`/`slow`/`derived`), not on raw slot names, so adding a slot is a data edit. The matrix and dispatch are pure and unit-tested; the agent wires them via `getResolvedSlots()`/`applyResolved()`, and in-session state is a `Session` value passed in and out (no module-global leakage).

**Tech Stack:** Agency language (`.agency` → TS), the agency test runner (JSON-declared `node` tests, exact-string match on `JSON.stringify`), `std::cli`/`std::ui` (`chooseOption`/`pushMessage`), `std::agency/local` (`localModelsSupported`/`listModelNames`/`registerLocalModel`), `std::memory` (`disableMemory`), `stdlib/llm.agency` (`setLlmOptions`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-30-model-selection-dx-design.md`. Every task's requirements implicitly include it. (Local-model semantics are spec §4.7; `price` band is the spec's name — there is no `tier`.)
- **Resolution is immediacy-outer, specificity-inner** (spec §3.3). `--model X` (CLI global-pin) overrides a saved per-slot setting **this run**.
- **Slots shipped:** `main` (kind `fast`), `reasoning` (kind `slow`), `embedding` (kind `derived`). Aliases `fast→main`, `slow→reasoning` resolved at the CLI boundary, before the matrix.
- **Back-compat is mandatory:** existing tests in `lib/agents/agency-agent/tests/models.agency`/`.test.json` MUST stay unchanged and pass. `--model X` alone still pins both `main` and `reasoning`.
- **Phase 1 price band is `standard` only** — no `economy`/`premium` columns, no `/price` (Phase 2). `settings.model.price` is read but only `standard` is honored.
- **`--model` (hosted) and `--local` (local) are mutually exclusive** — error at parse.
- **Type field order is `{ model, provider, ... }` everywhere** (`ModelSpec`, `SlotValue`, `Resolved`) — JSON snapshot tests depend on it; a one-line comment locks it in each type.
- **Verified stdlib facts (do not re-guess):** `stdlib/agency/local.agency` exports `localModelsSupported(): bool`, `listModelNames(): ModelName[]`, `registerLocalModel(value, cacheDir="")`, `printLocalCatalog()`. `std::memory` exports only `enableMemory`/`disableMemory` (no tier-2-only toggle). `std::llm` exposes no provider list.
- Build with `make` after any change (copies `lib/agents` into `dist`). Run one group: `node ./dist/scripts/agency.js test lib/agents -p 12` (alias `pnpm test:agents`).
- Agency syntax only (`def`/`node`, braces, `Record`, `Result`, `match`). Objects not maps, arrays not sets, types not interfaces.
- Do NOT commit unless the user asks. If asked, branch first (currently `main`).

---

## File Structure

- `lib/agents/agency-agent/lib/slots.agency` — **new.** `SLOTS`, `SLOT_ALIASES`, `canonicalSlot`/`isKnownSlot`, `SlotKind`, `SLOT_KIND`, `slotKind`. Pure registry + dispatch table.
- `lib/agents/agency-agent/lib/resolution.agency` — **new.** `SlotValue`/`Layer`/`Ctx`, `resolveSlot`/`resolveAll`, `buildLayers`, `diffResolved`. Pure. (`buildLayers` lives here, with `Layer`, not in `models.agency` — keeps `models.agency` from becoming a hub.)
- `lib/agents/agency-agent/lib/models.agency` — **modify.** Add `ModelSpec`, `parseModelSpec`, `Resolved`, `priceDefault` (via `SLOT_KIND`), `slotFromPlan`, `parseModelFlag`, `knownProviders`. Keep `planModels`/`resolveDetected` intact.
- `lib/agents/agency-agent/lib/settings.agency` — **modify.** `ModelSettings`, extend `Settings`, `sanitizeModelSettings` (non-mutating), `getModelSettings`, sanitize on load.
- `lib/agents/agency-agent/shared.agency` — **modify.** `setSlowModel`, `applyResolved` (via `SLOT_KIND`), `getResolvedSlots`, route `configureModels` through the resolver.
- `lib/agents/agency-agent/agent.agency` — **modify.** Flags (`--model slot=`, `--local` rename + mutual exclusivity), `/model` (owns one `Session` cell, dispatches `changes`), `/local`, guided local setup, cross-provider recall reaction.
- Tests: new `slots`/`resolution` `.agency`+`.test.json`; extend `models`/`settings`/`agentTurn` `.agency`+`.test.json`.

---

## Task 1: Slot registry + `SLOT_KIND` dispatch table

**Files:** Create `lib/.../lib/slots.agency`; Test `tests/slots.agency` + `slots.test.json`.

**Interfaces — Produces:** `SLOTS: string[]`, `SLOT_ALIASES: Record<string,string>`, `def canonicalSlot(name): string`, `def isKnownSlot(name): boolean`, `type SlotKind = "fast" | "slow" | "derived"`, `SLOT_KIND: Record<string, SlotKind>`, `def slotKind(name): SlotKind`.

- [ ] **Step 1: Write failing tests** — `tests/slots.agency`:
```agency
import { canonicalSlot, isKnownSlot, slotKind } from "../lib/slots.agency"

node aliasFastToMain(): string { return canonicalSlot("fast") }
node unknownStaysUnknown(): boolean { return isKnownSlot("resoning") }
node knownAfterAlias(): boolean { return isKnownSlot("slow") }
node kindOfReasoning(): string { return slotKind("slow") }
node kindOfEmbedding(): string { return slotKind("embedding") }
```
`tests/slots.test.json`:
```json
{ "sourceFile": "slots.agency", "tests": [
  { "nodeName": "aliasFastToMain", "input": "", "expectedOutput": "\"main\"", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "unknownStaysUnknown", "input": "", "expectedOutput": "false", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "knownAfterAlias", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "kindOfReasoning", "input": "", "expectedOutput": "\"slow\"", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "kindOfEmbedding", "input": "", "expectedOutput": "\"derived\"", "evaluationCriteria": [{ "type": "exact" }] }
]}
```

- [ ] **Step 2: Run, verify fail** — `make && node ./dist/scripts/agency.js test lib/agents/agency-agent/tests/slots.agency` → FAIL (module missing).

- [ ] **Step 3: Implement** — `lib/agents/agency-agent/lib/slots.agency`:
```agency
/** @module Slot registry + dispatch table for model selection. A slot is a
  named purpose a model fills. `SLOT_KIND` keeps slot-specific behavior keyed on
  a CLOSED enum so consumers switch on the kind, not the raw name — adding a slot
  whose semantics match an existing kind is a one-line data edit. Pure. */

export static const SLOTS = ["main", "reasoning", "embedding"]
export static const SLOT_ALIASES: Record<string, string> = { fast: "main", slow: "reasoning" }

export type SlotKind = "fast" | "slow" | "derived"
export static const SLOT_KIND: Record<string, SlotKind> = {
  main: "fast",
  reasoning: "slow",
  embedding: "derived"
}

export def canonicalSlot(name: string): string {
  if (SLOT_ALIASES[name] != undefined) { return SLOT_ALIASES[name] }
  return name
}
export def isKnownSlot(name: string): boolean { return SLOTS.includes(canonicalSlot(name)) }
export def slotKind(name: string): SlotKind { return SLOT_KIND[canonicalSlot(name)] }
```

- [ ] **Step 4: Run, verify pass** — same command → PASS (5/5).
- [ ] **Step 5: Commit** *(only if asked)* — `git add lib/agents/agency-agent/lib/slots.agency lib/agents/agency-agent/tests/slots.agency lib/agents/agency-agent/tests/slots.test.json && git commit -m "feat(agent): slot registry + SLOT_KIND dispatch"`

---

## Task 2: `ModelSpec` + `parseModelSpec`

**Files:** Modify `lib/.../lib/models.agency`; Test extend `tests/models.agency` + `models.test.json`.

**Interfaces — Produces:** `type ModelSpec = { model: string; provider: string }` (model-first — locked by snapshots), `def parseModelSpec(spec, providerEstablished, knownProviders): ModelSpec`.

- [ ] **Step 1: Write failing tests** — append to `tests/models.agency`:
```agency
import { parseModelSpec } from "../lib/models.agency"
static const KNOWN = ["openai", "anthropic", "google", "openrouter", "litellm"]

node specSplitOnKnownProvider(): ModelSpec { return parseModelSpec("anthropic/claude-opus-4-8", false, KNOWN) }
node specOpenrouterMultiSegment(): ModelSpec { return parseModelSpec("openrouter/deepseek/deepseek-r1", false, KNOWN) }
node specProviderEstablishedNoSplit(): ModelSpec { return parseModelSpec("deepseek/deepseek-r1", true, KNOWN) }
node specBareModel(): ModelSpec { return parseModelSpec("gpt-5.5", false, KNOWN) }
node specUnknownPrefixNoSplit(): ModelSpec { return parseModelSpec("unknown-vendor/some-model", false, KNOWN) }
```
append to `models.test.json` (note **model-first** field order):
```json
{ "nodeName": "specSplitOnKnownProvider", "input": "", "expectedOutput": "{\"model\":\"claude-opus-4-8\",\"provider\":\"anthropic\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "specOpenrouterMultiSegment", "input": "", "expectedOutput": "{\"model\":\"deepseek/deepseek-r1\",\"provider\":\"openrouter\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "specProviderEstablishedNoSplit", "input": "", "expectedOutput": "{\"model\":\"deepseek/deepseek-r1\",\"provider\":\"\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "specBareModel", "input": "", "expectedOutput": "{\"model\":\"gpt-5.5\",\"provider\":\"\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "specUnknownPrefixNoSplit", "input": "", "expectedOutput": "{\"model\":\"unknown-vendor/some-model\",\"provider\":\"\"}", "evaluationCriteria": [{ "type": "exact" }] }
```

- [ ] **Step 2: Run, verify fail** — FAIL (`parseModelSpec` undefined).
- [ ] **Step 3: Implement** — add to `models.agency`:
```agency
// Field order { model, provider } is locked by JSON snapshot tests — do not reorder.
export type ModelSpec = {
  model: string;
  provider: string
}

/** Parse a possibly-unified model spec. When a provider is already established
  (explicit --provider/settings), never split: the whole string is the model id
  (OpenRouter ids contain "/"). Else split on the FIRST "/" only when the prefix
  is a recognized provider; otherwise the whole string is the model. */
export def parseModelSpec(spec: string, providerEstablished: boolean, knownProviders: string[]): ModelSpec {
  if (providerEstablished) { return { model: spec, provider: "" } }
  const idx = spec.indexOf("/")
  if (idx <= 0) { return { model: spec, provider: "" } }
  const prefix = spec.substring(0, idx)
  if (knownProviders.includes(prefix)) {
    return { model: spec.substring(idx + 1), provider: prefix }
  }
  return { model: spec, provider: "" }
}
```

- [ ] **Step 4: Run, verify pass** — PASS (existing 5 + new 5).
- [ ] **Step 5: Commit** *(only if asked)* — `git add lib/agents/agency-agent/lib/models.agency lib/agents/agency-agent/tests/models.agency lib/agents/agency-agent/tests/models.test.json && git commit -m "feat(agent): parseModelSpec (unified provider/model)"`

---

## Task 3: `Resolved` + `priceDefault` via `SLOT_KIND`

**Files:** Modify `models.agency`; Test extend `tests/models.agency` + `models.test.json`.

**Interfaces — Produces:** `type Resolved = { model: string; provider: string; via: string }`, `def slotFromPlan(slot, plan): SlotValue`-style mapping folded into `def priceDefault(provider, slot, price): Result<Resolved>`. **Consumes:** `slotKind` (Task 1), existing `MODELS`/`planModels`.

`main`/`reasoning` defaults come from `planModels(...)` (byte-identical to today). `embedding` (kind `derived`) returns empty model — memory derives the embed model from the active provider; the slot exists so the matrix can resolve it and so a provider change is observable. Providers absent from `MODELS` → failure (preserves the `resolveDetected` guard).

- [ ] **Step 1: Write failing tests** — append to `tests/models.agency`:
```agency
import { priceDefault, Resolved } from "../lib/models.agency"

node priceMainAnthropic(): Resolved { return priceDefault("anthropic", "main", "standard").value }
node priceReasoningAnthropic(): Resolved { return priceDefault("anthropic", "reasoning", "standard").value }
node priceMainOpenaiPromoted(): Resolved { return priceDefault("openai", "main", "standard").value }
node priceEmbeddingDerived(): Resolved { return priceDefault("anthropic", "embedding", "standard").value }
node priceUnknownProviderFails(): boolean { return isFailure(priceDefault("litellm", "main", "standard")) }
```
append to `models.test.json`:
```json
{ "nodeName": "priceMainAnthropic", "input": "", "expectedOutput": "{\"model\":\"claude-sonnet-4-6\",\"provider\":\"\",\"via\":\"built-in·price=standard\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "priceReasoningAnthropic", "input": "", "expectedOutput": "{\"model\":\"claude-opus-4-8\",\"provider\":\"anthropic\",\"via\":\"built-in·price=standard\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "priceMainOpenaiPromoted", "input": "", "expectedOutput": "{\"model\":\"gpt-4o-mini\",\"provider\":\"openai-responses\",\"via\":\"built-in·price=standard\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "priceEmbeddingDerived", "input": "", "expectedOutput": "{\"model\":\"\",\"provider\":\"\",\"via\":\"built-in·embedding(derived)\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "priceUnknownProviderFails", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] }
```

- [ ] **Step 2: Run, verify fail** — FAIL (`priceDefault` undefined).
- [ ] **Step 3: Implement** — add to `models.agency` (import `slotKind` from `./slots.agency`):
```agency
// Field order { model, provider, via } is locked by JSON snapshot tests.
export type Resolved = {
  model: string;
  provider: string;
  via: string
}

/** Built-in default for (provider, slot, price). Phase 1 honors only "standard",
  deriving fast/slow from `planModels` (byte-identical to today). `derived` slots
  (embedding) return empty — memory derives the embed model from the active
  provider. Providers without baked defaults → failure. Dispatch on SLOT_KIND so
  the mapping lives in one table, not a per-name switch. */
export def priceDefault(provider: string, slot: string, price: string): Result<Resolved> {
  if (MODELS[provider] == undefined) {
    return failure("Provider '${provider}' has no built-in defaults; pass an explicit model.")
  }
  const plan = planModels("", "", "", provider, provider)
  const kind = slotKind(slot)
  if (kind == "fast") {
    return success({ model: plan.fastModel, provider: plan.fastProvider, via: "built-in·price=${price}" })
  }
  if (kind == "slow") {
    return success({ model: plan.slowModel, provider: plan.slowProvider, via: "built-in·price=${price}" })
  }
  if (kind == "derived") {
    return success({ model: "", provider: "", via: "built-in·embedding(derived)" })
  }
  return failure("Unknown slot '${slot}'.")
}
```

- [ ] **Step 4: Run, verify pass** — PASS (existing 5 back-compat + Task 2's 5 + new 5).
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(agent): priceDefault via SLOT_KIND (standard band)"`

---

## Task 4: Resolution matrix + `buildLayers` + `diffResolved`

**Files:** Create `lib/.../lib/resolution.agency`; Test `tests/resolution.agency` + `.test.json`.

**Interfaces — Consumes:** `Resolved`/`priceDefault`/`parseModelSpec` (models), `canonicalSlot` (slots), `ModelSettings` (settings). **Produces:**
- `type SlotValue = { model: string; provider: string }`, `type Layer = { name: string; perSlot: Record<string, SlotValue>; pin: SlotValue | null }`, `type Ctx = { provider: string; price: string }`
- `def resolveSlot(slot, layers, ctx): Result<Resolved>`, `def resolveAll(layers, ctx): Result<Record<string, Resolved>>`
- `def buildLayers(sessionPin, cliModel, cliSlots, settings, knownProviders, providerEstablished): Layer[]`
- `def diffResolved(before, after): SlotChange[]` where `type SlotChange = { slot: string; before: Resolved; after: Resolved }`

- [ ] **Step 1: Write failing tests** — `tests/resolution.agency`:
```agency
import { resolveSlot, resolveAll, buildLayers, Layer, Ctx } from "../lib/resolution.agency"
import { Resolved } from "../lib/models.agency"

static const CTX: Ctx = { provider: "anthropic", price: "standard" }
def empty(name: string): Layer { return { name: name, perSlot: {}, pin: null } }

// immediacy-outer: CLI global-pin beats settings per-slot (the flipped item-1 case).
node cliPinBeatsSettingsSlot(): Resolved {
  let cli = empty("cli"); cli.pin = { model: "gpt-5.5", provider: "" }
  let set = empty("settings"); set.perSlot = { reasoning: { model: "opus", provider: "" } }
  return resolveSlot("reasoning", [empty("in-session"), cli, set], CTX).value
}
// in-session per-slot beats CLI per-slot (immediacy).
node inSessionPerSlotBeatsCli(): Resolved {
  let s = empty("in-session"); s.perSlot = { main: { model: "a", provider: "anthropic" } }
  let cli = empty("cli"); cli.perSlot = { main: { model: "b", provider: "anthropic" } }
  return resolveSlot("main", [s, cli], CTX).value
}
// in-session pin beats CLI pin.
node inSessionPinBeatsCliPin(): Resolved {
  let s = empty("in-session"); s.pin = { model: "a", provider: "anthropic" }
  let cli = empty("cli"); cli.pin = { model: "b", provider: "anthropic" }
  return resolveSlot("main", [s, cli], CTX).value
}
// within settings: per-slot beats pin.
node settingsPerSlotBeatsSettingsPin(): Resolved {
  let set = empty("settings"); set.pin = { model: "pin", provider: "anthropic" }
  set.perSlot = { main: { model: "slot", provider: "anthropic" } }
  return resolveSlot("main", [empty("in-session"), empty("cli"), set], CTX).value
}
// no layer → built-in default; empty provider inherits ctx.
node fallsToBuiltinDefault(): Resolved {
  return resolveSlot("main", [empty("in-session"), empty("cli"), empty("settings")], CTX).value
}
// resolveAll propagates failure for a default-less provider with no override.
node resolveAllPropagatesFailure(): boolean {
  const ctx: Ctx = { provider: "litellm", price: "standard" }
  return isFailure(resolveAll([empty("in-session"), empty("cli"), empty("settings")], ctx))
}
// back-compat parity: built-in defaults equal planModels for anthropic.
node parityMainAnthropic(): Resolved {
  return resolveSlot("main", [empty("in-session"), empty("cli"), empty("settings")], CTX).value
}
// buildLayers: CLI --model gpt-5.5 over settings slots.reasoning=opus → gpt-5.5.
node buildLayersImmediacyOuter(): Resolved {
  const layers = buildLayers("", "gpt-5.5", {}, { slots: { reasoning: "opus" } }, ["anthropic","openai"], false)
  return resolveAll(layers, CTX).value["reasoning"]
}
```
`tests/resolution.test.json`:
```json
{ "sourceFile": "resolution.agency", "tests": [
  { "nodeName": "cliPinBeatsSettingsSlot", "input": "", "expectedOutput": "{\"model\":\"gpt-5.5\",\"provider\":\"anthropic\",\"via\":\"cli·global-pin\"}", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "inSessionPerSlotBeatsCli", "input": "", "expectedOutput": "{\"model\":\"a\",\"provider\":\"anthropic\",\"via\":\"in-session·per-slot\"}", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "inSessionPinBeatsCliPin", "input": "", "expectedOutput": "{\"model\":\"a\",\"provider\":\"anthropic\",\"via\":\"in-session·global-pin\"}", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "settingsPerSlotBeatsSettingsPin", "input": "", "expectedOutput": "{\"model\":\"slot\",\"provider\":\"anthropic\",\"via\":\"settings·per-slot\"}", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "fallsToBuiltinDefault", "input": "", "expectedOutput": "{\"model\":\"claude-sonnet-4-6\",\"provider\":\"anthropic\",\"via\":\"built-in·price=standard\"}", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "resolveAllPropagatesFailure", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "parityMainAnthropic", "input": "", "expectedOutput": "{\"model\":\"claude-sonnet-4-6\",\"provider\":\"anthropic\",\"via\":\"built-in·price=standard\"}", "evaluationCriteria": [{ "type": "exact" }] },
  { "nodeName": "buildLayersImmediacyOuter", "input": "", "expectedOutput": "{\"model\":\"gpt-5.5\",\"provider\":\"anthropic\",\"via\":\"cli·global-pin\"}", "evaluationCriteria": [{ "type": "exact" }] }
]}
```
> `parityMainAnthropic` locks back-compat: built-in `main` = `claude-sonnet-4-6` = `planModels`'s anthropic fast (with provider filled to ctx). Add a `parityMainOpenai` expecting `gpt-4o-mini`/`openai-responses` if you want the promotion path covered too.

- [ ] **Step 2: Run, verify fail** — FAIL (module missing).
- [ ] **Step 3: Implement** — `lib/agents/agency-agent/lib/resolution.agency`:
```agency
/** @module Resolution matrix. Immutable layers (most-immediate first) ×
  specificity (per-slot › global-pin), first non-empty cell wins; built-in falls
  to `priceDefault`. Pure — layers are read-only inputs. See spec §3.2/§3.3. */
import { Resolved, priceDefault, parseModelSpec } from "./models.agency"
import { canonicalSlot } from "./slots.agency"
import { ModelSettings } from "./settings.agency"

export type SlotValue = { model: string; provider: string }
export type Layer = { name: string; perSlot: Record<string, SlotValue>; pin: SlotValue | null }
export type Ctx = { provider: string; price: string }
export type SlotChange = { slot: string; before: Resolved; after: Resolved }

def finalProvider(v: SlotValue, ctx: Ctx): string {
  if (v.provider == "") { return ctx.provider }
  return v.provider
}

export def resolveSlot(slot: string, layers: Layer[], ctx: Ctx): Result<Resolved> {
  for (layer in layers) {
    const ps = layer.perSlot[slot]
    if (ps != undefined) {
      return success({ model: ps.model, provider: finalProvider(ps, ctx), via: "${layer.name}·per-slot" })
    }
    if (layer.pin != null) {
      return success({ model: layer.pin.model, provider: finalProvider(layer.pin, ctx), via: "${layer.name}·global-pin" })
    }
  }
  const def = priceDefault(ctx.provider, slot, ctx.price)
  if (def is failure(f)) { return failure(f.error) }
  let r = def.value
  if (r.provider == "") { r.provider = ctx.provider }
  return success(r)
}

export def resolveAll(layers: Layer[], ctx: Ctx): Result<Record<string, Resolved>> {
  let out: Record<string, Resolved> = {}
  for (slot in ["main", "reasoning", "embedding"]) {
    const r = resolveSlot(slot, layers, ctx)
    if (r is failure(f)) { return failure(f.error) }
    out[slot] = r.value
  }
  return success(out)
}

def toValue(raw: string, kp: string[], est: boolean): SlotValue {
  const spec = parseModelSpec(raw, est, kp)
  return { model: spec.model, provider: spec.provider }
}
def slotsToValues(slots: Record<string, string>, kp: string[], est: boolean): Record<string, SlotValue> {
  let out: Record<string, SlotValue> = {}
  for (key in slots) { out[canonicalSlot(key)] = toValue(slots[key], kp, est) }
  return out
}

/** Build the ordered [in-session, cli, settings] layer list (built-in fallback
  is implicit via priceDefault). Each raw value is parsed so a unified
  provider/model carries its own provider. */
export def buildLayers(
  sessionPin: string, cliModel: string, cliSlots: Record<string, string>,
  settings: ModelSettings, knownProviders: string[], providerEstablished: boolean,
): Layer[] {
  let inSession: Layer = { name: "in-session", perSlot: {}, pin: null }
  if (sessionPin != "") { inSession.pin = toValue(sessionPin, knownProviders, providerEstablished) }
  let cli: Layer = { name: "cli", perSlot: slotsToValues(cliSlots, knownProviders, providerEstablished), pin: null }
  if (cliModel != "") { cli.pin = toValue(cliModel, knownProviders, providerEstablished) }
  let set: Layer = { name: "settings", perSlot: {}, pin: null }
  if (settings.slots != undefined) { set.perSlot = slotsToValues(settings.slots, knownProviders, providerEstablished) }
  if (settings.pin != undefined && settings.pin != "") { set.pin = toValue(settings.pin, knownProviders, providerEstablished) }
  return [inSession, cli, set]
}

/** Slots whose (model, provider) changed between two assignments. */
export def diffResolved(before: Record<string, Resolved>, after: Record<string, Resolved>): SlotChange[] {
  let out: SlotChange[] = []
  for (slot in Object.keys(after)) {
    const b = before[slot]
    if (b == undefined) { continue }
    if (b.model != after[slot].model || b.provider != after[slot].provider) {
      out.push({ slot: slot, before: b, after: after[slot] })
    }
  }
  return out
}
```

- [ ] **Step 4: Run, verify pass** — PASS (8/8).
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(agent): resolution matrix, buildLayers, diffResolved"`

---

## Task 5: `ModelSettings` + non-mutating validation + round-trip

**Files:** Modify `settings.agency`; Test extend `tests/settings.agency` + `settings.test.json`.

**Interfaces — Consumes:** `isKnownSlot`/`canonicalSlot` (slots). **Produces:** `type ModelSettings`, extended `Settings`, `def sanitizeModelSettings(m): ModelSettings` (non-mutating), `def getModelSettings(s): ModelSettings`; `loadSettings` sanitizes the model block.

- [ ] **Step 1: Write failing tests** — append to `tests/settings.agency`:
```agency
import { sanitizeModelSettings, getModelSettings, ModelSettings } from "../lib/settings.agency"

node dropsUnknownSlotKey(): ModelSettings {
  return sanitizeModelSettings({ slots: { reasoning: "opus", resoning: "typo" } })
}
node doesNotMutateInput(): string {
  const input: ModelSettings = { slots: { reasoning: "opus", resoning: "typo" } }
  sanitizeModelSettings(input)
  // input must still have the bad key (sanitize returns a NEW object).
  if (input.slots["resoning"] == "typo") { return "unmutated" }
  return "MUTATED"
}
node roundTripsModelSlots(): string {
  saveSettings({ model: { slots: { reasoning: "claude-opus-4-8" } } }) with approve
  const loaded = loadSettings() with approve
  return getModelSettings(loaded).slots["reasoning"]
}
```
append to `settings.test.json`:
```json
{ "nodeName": "dropsUnknownSlotKey", "input": "", "expectedOutput": "{\"slots\":{\"reasoning\":\"opus\"}}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "doesNotMutateInput", "input": "", "expectedOutput": "\"unmutated\"", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "roundTripsModelSlots", "input": "", "expectedOutput": "\"claude-opus-4-8\"", "evaluationCriteria": [{ "type": "exact" }] }
```

- [ ] **Step 2: Run, verify fail** — FAIL (symbols undefined).
- [ ] **Step 3: Implement** — in `settings.agency`, import `{ isKnownSlot, canonicalSlot } from "./slots.agency"`, add types + sanitizer, extend `Settings`, sanitize in `loadSettings`:
```agency
export type ModelSettings = {
  price?: string;
  provider?: string;
  allowedProviders?: string[];
  slots?: Record<string, string>;
  pin?: string
}
// (extend the existing Settings)
export type Settings = { search?: SearchSettings; model?: ModelSettings }

/** Return a NEW ModelSettings with unknown slot keys dropped (warned). Does NOT
  mutate the input. Pure except the warning print. */
export def sanitizeModelSettings(m: ModelSettings): ModelSettings {
  if (m.slots == undefined) { return m }
  let kept: Record<string, string> = {}
  for (key in m.slots) {
    if (isKnownSlot(key)) { kept[canonicalSlot(key)] = m.slots[key] }
    else { print("Warning: settings.json model.slots has unknown slot '${key}'; ignoring it.") }
  }
  return { ...m, slots: kept }
}

export def getModelSettings(s: Settings): ModelSettings {
  if (s.model == undefined) { return {} }
  return s.model
}
```
In `loadSettings`, before `return value`:
```agency
  if (value.model != undefined) { value.model = sanitizeModelSettings(value.model) }
```

- [ ] **Step 4: Run, verify pass** — PASS (existing settings tests + 3 new).
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(agent): ModelSettings + non-mutating slot validation + round-trip"`

---

## Task 6: Wire the resolver — `configureModels`, `applyResolved`, `getResolvedSlots`

**Files:** Modify `shared.agency`, `models.agency` (`knownProviders`); Test: a back-compat node test (pure parity already in Task 4; here verify `configureModels` end-to-end via `getResolvedSlots`).

**Interfaces — Consumes:** `buildLayers`/`resolveAll` (Task 4), `getModelSettings`/`loadSettings` (Task 5), `slotKind` (Task 1), `setLlmOptions` (`std::llm`), existing `slowModel`/`slowProvider`/`resolveDetected`. **Produces:** `def knownProviders(): string[]` (models), `def setSlowModel(name, provider)`, `def applyResolved(slots)`, `def getResolvedSlots(): Record<string, Resolved>`, `def currentProvider(): string` (shared).

- [ ] **Step 1: Implement `knownProviders` (drift-free, no hardcoded literal)** — in `models.agency`:
```agency
/** Providers Agency can actually configure: those with baked defaults plus the
  base-URL proxy providers. Source-of-truth derived, not a hand-maintained list. */
export def knownProviders(): string[] {
  return Object.keys(MODELS).concat(Object.keys(BASE_URL_PROVIDERS))
}
```

- [ ] **Step 2: Implement `shared.agency` wiring** — add imports (`resolveAll`/`buildLayers`/`Ctx` from `./lib/resolution.agency`, `knownProviders` from `./lib/models.agency`, `slotKind` from `./lib/slots.agency`, `getModelSettings`/`loadSettings` from `./lib/settings.agency`), the cache + accessors:
```agency
let _resolved: Record<string, Resolved> = {}

export def setSlowModel(name: string, provider: string) { slowModel = name; slowProvider = provider }

/** Apply a resolved assignment. Dispatch on SLOT_KIND so adding a slot is a
  data edit, not another branch here. `derived` (embedding) is a deliberate
  no-op — memory derives its own embed model from the active provider. */
export def applyResolved(slots: Record<string, Resolved>) {
  _resolved = slots
  for (slot in Object.keys(slots)) {
    const r = slots[slot]
    const kind = slotKind(slot)
    if (kind == "fast") { setLlmOptions({ model: r.model, provider: r.provider }) }
    else if (kind == "slow") { setSlowModel(r.model, r.provider) }
  }
}

export def getResolvedSlots(): Record<string, Resolved> { return _resolved }
export def currentProvider(): string {
  if (_resolved["main"] != undefined) { return _resolved["main"].provider }
  return slowProvider
}
```
Rewrite `configureModels` to resolve + apply:
```agency
export def configureModels(model: string, fast: string, slow: string, provider: string) {
  const detected = resolveDetected(model, fast, slow, provider)
  if (isFailure(detected)) { print(detected.error); process.exit(1) }
  const ctx: Ctx = { provider: detected.value, price: "standard" }
  let cliSlots: Record<string, string> = {}
  if (fast != "") { cliSlots["main"] = fast }
  if (slow != "") { cliSlots["reasoning"] = slow }
  const layers = buildLayers("", model, cliSlots, getModelSettings(loadSettings()), knownProviders(), provider != "")
  const all = resolveAll(layers, ctx)
  if (isFailure(all)) { print(all.error); process.exit(1) }
  applyResolved(all.value)
}
```

- [ ] **Step 3: Write the back-compat end-to-end test** — append to `tests/agentTurn.agency` (drives the real `configureModels`, then reads `getResolvedSlots`):
```agency
import { configureModels, getResolvedSlots } from "../shared.agency"

node configureAnthropicMatchesPlanModels(): string {
  configureModels("", "", "", "anthropic")
  const s = getResolvedSlots()
  return "${s["main"].model}|${s["reasoning"].model}|${s["reasoning"].provider}"
}
```
append to `agentTurn.test.json`:
```json
{ "nodeName": "configureAnthropicMatchesPlanModels", "input": "", "expectedOutput": "\"claude-sonnet-4-6|claude-opus-4-8|anthropic\"", "evaluationCriteria": [{ "type": "exact" }] }
```
> This is the back-compat guard the spec review (#4) asked for: it goes through the rewritten `configureModels`, not just `planModels`.

- [ ] **Step 4: Build + run the agent group** — `make && node ./dist/scripts/agency.js test lib/agents -p 12 2>&1 | tee /private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/f7ec59b5-8a84-439b-a601-250cf63a0c4f/scratchpad/agents-t6.log` → all green; existing `models` back-compat tests unchanged.
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(agent): wire resolver into configureModels + getResolvedSlots/applyResolved"`

---

## Task 7: CLI flags — `--model slot=model`, `--local` rename, mutual exclusivity

**Files:** Modify `agent.agency`, `models.agency` (`parseModelFlag`); Test extend `tests/models.agency` + `models.test.json`.

**Interfaces — Produces:** `def parseModelFlag(value): { slot: string; model: string }` (`reasoning=opus` → per-slot, alias-resolved; bare → global pin). (Name kept distinct from `parseModelSpec`; its `{slot, model}` shape is documented in the docstring.)

- [ ] **Step 1: Write failing tests** — append to `tests/models.agency`:
```agency
import { parseModelFlag } from "../lib/models.agency"
node modelFlagPerSlot(): { slot: string; model: string } { return parseModelFlag("reasoning=claude-opus-4-8") }
node modelFlagGlobal(): { slot: string; model: string } { return parseModelFlag("gpt-5.5") }
node modelFlagAliasFast(): { slot: string; model: string } { return parseModelFlag("fast=gpt-4o") }
node modelFlagUnifiedNoMissplit(): { slot: string; model: string } { return parseModelFlag("anthropic/claude-opus-4-8") }
```
append to `models.test.json`:
```json
{ "nodeName": "modelFlagPerSlot", "input": "", "expectedOutput": "{\"slot\":\"reasoning\",\"model\":\"claude-opus-4-8\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "modelFlagGlobal", "input": "", "expectedOutput": "{\"slot\":\"\",\"model\":\"gpt-5.5\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "modelFlagAliasFast", "input": "", "expectedOutput": "{\"slot\":\"main\",\"model\":\"gpt-4o\"}", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "modelFlagUnifiedNoMissplit", "input": "", "expectedOutput": "{\"slot\":\"\",\"model\":\"anthropic/claude-opus-4-8\"}", "evaluationCriteria": [{ "type": "exact" }] }
```

- [ ] **Step 2: Run, verify fail** — FAIL.
- [ ] **Step 3: Implement `parseModelFlag`** — in `models.agency` (import `canonicalSlot`):
```agency
/** Split a --model value: `slot=model` → per-slot (alias-resolved); a bare
  `model` → global pin ({slot:""}). The "=" must precede any "/" so a unified
  provider/model value (anthropic/claude) is NOT misread as a slot assignment.
  Returns {slot, model} (distinct shape from parseModelSpec's {model, provider}). */
export def parseModelFlag(value: string): { slot: string; model: string } {
  const eq = value.indexOf("=")
  const slash = value.indexOf("/")
  if (eq > 0 && (slash == -1 || eq < slash)) {
    return { slot: canonicalSlot(value.substring(0, eq)), model: value.substring(eq + 1) }
  }
  return { slot: "", model: value }
}
```

- [ ] **Step 4: Run, verify pass** — PASS.
- [ ] **Step 5: Update `agent.agency` flags + mutual exclusivity + per-slot routing** — rename the flag key `"local-model"` → `"local"`, keep a second optional `"local-model"` flag as a deprecated alias; resolve `localVal = args.flags["local"] ?? args.flags["local-model"]`. After parsing:
```agency
  const hasLocal = localVal != undefined
  const modelArg = args.flags.model ?? ""
  const hasModel = modelArg != "" || (args.flags.fastmodel ?? "") != "" || (args.flags.slowmodel ?? "") != ""
  if (hasLocal && hasModel) {
    print(color.red("Pass either --model (hosted) or --local (local), not both."))
    process.exit(1)
  }
```
Extend `configureModels` (Task 6) to accept the model arg as either a per-slot or global value: in `main()`, split `modelArg` via `parseModelFlag` and pass it as `cliSlots[slot]` (if slot non-empty) or as the global `model` param. Concretely, before calling `configureModels`, build the per-slot map and the global model and call a small wrapper, or pass `modelArg` through and let `configureModels` call `parseModelFlag` on it. Keep `--fastmodel`/`--slowmodel` feeding `cliSlots["main"]`/`["reasoning"]`.

- [ ] **Step 6: Build + smoke (mutual exclusivity + alias)** — `make`, then:
```bash
node ./dist/scripts/agency.js agent --model gpt-5.5 --local smollm2-135m -p "hi"; echo "exit=$?"   # → error, exit=1
node ./dist/scripts/agency.js agent --local-model smollm2-135m -p "hi"; echo "exit=$?"             # alias still accepted (may error only if model unavailable)
```
Expected: first prints the either/or error and `exit=1`; second exercises the deprecated alias path (no flag-parse error).

- [ ] **Step 7: Commit** *(only if asked)* — `git commit -m "feat(agent): --model slot=model, --local rename + mutual exclusivity"`

---

## Task 8: `/model` in-session switch — `Session` value + `changes` dispatch

**Files:** Modify `agent.agency`; Test extend `tests/agentTurn.agency` + `agentTurn.test.json`.

**Interfaces — Consumes:** `buildLayers`/`resolveAll`/`diffResolved`/`Ctx`/`SlotChange` (Task 4), `applyResolved`/`getResolvedSlots`/`currentProvider` (Task 6), `parseModelFlag`/`knownProviders` (Task 7), `getModelSettings`/`loadSettings`. **Produces:** `type Session = { pin: string; slots: Record<string, string> }`, `def switchModel(prior, spec, ctx, before): { session: Session; resolved: Record<string, Resolved>; changes: SlotChange[] }` (no module-global state — session is passed in/out).

- [ ] **Step 1: Write failing tests** — append to `tests/agentTurn.agency`:
```agency
import { switchModel, Session } from "../agent.agency"
import { Ctx } from "../lib/resolution.agency"

static const CTX: Ctx = { provider: "anthropic", price: "standard" }
static const BEFORE = {
  main: { model: "claude-sonnet-4-6", provider: "anthropic", via: "x" },
  reasoning: { model: "claude-opus-4-8", provider: "anthropic", via: "x" },
  embedding: { model: "", provider: "anthropic", via: "x" }
}
def fresh(): Session { return { pin: "", slots: {} } }

node switchPinsAllSlots(): string {
  const out = switchModel(fresh(), "gpt-5.5", CTX, BEFORE)
  return "${out.resolved["main"].model}|${out.resolved["reasoning"].model}"
}
node switchPerSlotOnly(): string {
  const out = switchModel(fresh(), "reasoning=claude-opus-4-8", CTX, BEFORE)
  return "${out.resolved["reasoning"].model}|${out.resolved["main"].model}"
}
node switchReportsChanges(): number {
  const out = switchModel(fresh(), "main=gpt-4o", CTX, BEFORE)
  return out.changes.length
}
node switchDoesNotMutatePrior(): string {
  const prior = fresh()
  switchModel(prior, "gpt-5.5", CTX, BEFORE)
  return prior.pin   // must stay "" — switchModel copies, never mutates prior
}
```
append to `agentTurn.test.json`:
```json
{ "nodeName": "switchPinsAllSlots", "input": "", "expectedOutput": "\"gpt-5.5|gpt-5.5\"", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "switchPerSlotOnly", "input": "", "expectedOutput": "\"claude-opus-4-8|claude-sonnet-4-6\"", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "switchReportsChanges", "input": "", "expectedOutput": "1", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "switchDoesNotMutatePrior", "input": "", "expectedOutput": "\"\"", "evaluationCriteria": [{ "type": "exact" }] }
```
> `switchPerSlotOnly`: `main` stays `claude-sonnet-4-6` (built-in default at ctx anthropic) — proving a per-slot switch doesn't collapse routing. `switchReportsChanges`: only `main` changed (gpt-4o), so `changes.length == 1`.

- [ ] **Step 2: Run, verify fail** — FAIL (`switchModel` undefined).
- [ ] **Step 3: Implement `switchModel` (pure-ish: copies prior, side-effect only `applyResolved`)** — in `agent.agency`:
```agency
export type Session = { pin: string; slots: Record<string, string> }

/** Apply an in-session model selection. Copies `prior` (never mutates it), folds
  in the new spec (bare → pin; slot=model → per-slot), resolves, applies, and
  returns the new session + assignment + the slots that changed (so the caller
  can react, e.g. the cross-provider recall notice). Turn-boundary semantics: the
  applied change affects the NEXT turn; no in-flight call is mutated. */
export def switchModel(
  prior: Session, spec: string, ctx: Ctx, before: Record<string, Resolved>,
): { session: Session; resolved: Record<string, Resolved>; changes: SlotChange[] } {
  let nextSlots: Record<string, string> = {}
  for (k in prior.slots) { nextSlots[k] = prior.slots[k] }
  let next: Session = { pin: prior.pin, slots: nextSlots }
  const parsed = parseModelFlag(spec)
  if (parsed.slot == "") { next.pin = parsed.model } else { next.slots[parsed.slot] = parsed.model }

  const layers = buildLayers(next.pin, "", next.slots, getModelSettings(loadSettings()), knownProviders(), false)
  const all = resolveAll(layers, ctx)
  if (all is failure(f)) {
    // Invalid selection: keep prior, report nothing changed.
    pushMessage(color.red("Could not switch model: ${f.error}"))
    return { session: prior, resolved: before, changes: [] }
  }
  applyResolved(all.value)
  return { session: next, resolved: all.value, changes: diffResolved(before, all.value) }
}
```
Add the module's single `Session` cell and the `/model` handler in `_runTurn` (beside `/search`): show the current assignment with its `via` (from `getResolvedSlots()`), open a free-text `chooseOption` (Phase 1 has no hosted catalog — that's Phase 2), then:
```agency
let _session: Session = { pin: "", slots: {} }
// inside the /model branch, after obtaining `choice`:
  const ctx: Ctx = { provider: currentProvider(), price: "standard" }
  const out = switchModel(_session, choice, ctx, getResolvedSlots())
  _session = out.session
  for (change in out.changes) { reactToSlotChange(change) }
  for (slot in Object.keys(out.resolved)) {
    pushMessage(color.dim("${slot}: ${out.resolved[slot].model} (${out.resolved[slot].via})"))
  }
```
`reactToSlotChange` is implemented in Task 9. Register `/model` in `builtinPalette()`.

- [ ] **Step 4: Run, verify pass** — PASS (existing agentTurn + new 4; the Task 6 `configureAnthropicMatchesPlanModels` still passes).
- [ ] **Step 5: Commit** *(only if asked)* — `git commit -m "feat(agent): /model in-session switch via Session value + changes"`

---

## Task 9: `--local` guided setup, `/local`, cross-provider recall reaction

**Files:** Modify `agent.agency`, `shared.agency` (reuse `configureLocalModel`); Test extend `tests/agentTurn.agency` + `agentTurn.test.json` (the recall reaction is unit-tested; the interactive picker is manual smoke).

**Interfaces — Consumes:** `localModelsSupported`/`listModelNames`/`registerLocalModel`/`printLocalCatalog` (`std::agency/local`), `configureLocalModel` (`shared.agency`), `disableMemory` (`std::memory`), `chooseOption`/`isTTY`, `slotKind` (Task 1), `SlotChange` (Task 4). **Produces:** `def reactToSlotChange(change): boolean` (returns true if it emitted the recall notice — testable).

> **Spec deviation (flagged):** spec §5 wants tier-2 recall disabled while structured recall stays on. `std::memory` only exposes `disableMemory()` (all-or-nothing). Phase 1 uses `disableMemory()` (full pause) and notes a follow-up to add a selective tier-2 toggle. **Recall-change signal in Phase 1 = the `main` slot's provider change** (memory derives embeddings from the active LLM provider, which is the `main` slot); when an independently-settable `embedding` provider exists, move the signal to the `embedding` slot.

- [ ] **Step 1: Write the failing recall-reaction test** — append to `tests/agentTurn.agency`:
```agency
import { reactToSlotChange } from "../agent.agency"

node reactNotifiesOnMainProviderChange(): boolean {
  const change: SlotChange = {
    slot: "main",
    before: { model: "claude-sonnet-4-6", provider: "anthropic", via: "x" },
    after: { model: "gpt-5.5", provider: "openai-responses", via: "y" }
  }
  return reactToSlotChange(change)   // true: provider changed → notice emitted
}
node reactSilentOnSameProvider(): boolean {
  const change: SlotChange = {
    slot: "main",
    before: { model: "claude-sonnet-4-6", provider: "anthropic", via: "x" },
    after: { model: "claude-opus-4-8", provider: "anthropic", via: "y" }
  }
  return reactToSlotChange(change)   // false: same provider, no recall impact
}
```
append to `agentTurn.test.json`:
```json
{ "nodeName": "reactNotifiesOnMainProviderChange", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }] },
{ "nodeName": "reactSilentOnSameProvider", "input": "", "expectedOutput": "false", "evaluationCriteria": [{ "type": "exact" }] }
```

- [ ] **Step 2: Run, verify fail** — FAIL (`reactToSlotChange` undefined).
- [ ] **Step 3: Implement `reactToSlotChange`** — in `agent.agency` (import `disableMemory` from `std::memory`):
```agency
/** React to one resolved-slot change. Phase 1: a `main`-slot provider change
  means the embedding space behind memory changed, so pause memory and warn
  (see Task 9 spec-deviation note). Returns true iff it emitted the notice. */
export def reactToSlotChange(change: SlotChange): boolean {
  if (change.slot == "main" && change.before.provider != change.after.provider) {
    pushMessage(color.dim("⚠ Provider changed — memory is paused until restart (recall would be unreliable)."))
    disableMemory()
    return true
  }
  return false
}
```

- [ ] **Step 4: Implement bare-`--local` guided setup** — replace the current bare-`--local-model` branch in `main()`:
```agency
  if (localVal == "") {
    if (!isTTY()) { printLocalCatalog(); process.exit(0) }            // non-interactive: today's print+exit
    if (!localModelsSupported()) {
      print("Local models need the smoltalk-llama-cpp package.")
      print("Install it, then re-run:  ! npm i -g smoltalk-llama-cpp")
      process.exit(1)
    }
    const names = listModelNames()
    let items: ChoiceItem[] = []
    for (n in names) { items.push({ key: n.name, label: n.name }) }
    const choice = chooseOption("Local model", "Pick a model to download/run", items, allowFreeText: true)
    if (choice == "" || choice == null) { process.exit(0) }
    configureLocalModel(choice)
    configureSearch(true)
    // fall through into the session on the chosen local model
  } else if (localVal != undefined) {
    configureLocalModel(localVal)
    configureSearch(true)
  }
```
(`ChoiceItem` is already imported in `agent.agency`. `ModelName` has a `.name` field — confirmed in `stdlib/agency/local.agency`.)

- [ ] **Step 5: Wire `/local` (in-session)** — add a `/local` branch to `_runTurn` that runs the same `localModelsSupported` → `listModelNames` → `chooseOption` → `configureLocalModel` flow, then emits the recall notice (a local switch is a provider change): after `configureLocalModel`, call `reactToSlotChange({ slot: "main", before: getResolvedSlots()["main"], after: { model: choice, provider: "llama-cpp", via: "local" } })`. Register `/local` in `builtinPalette()`.

- [ ] **Step 6: Build + run the full agent group + smoke** — `make && node ./dist/scripts/agency.js test lib/agents -p 12 2>&1 | tee /private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/f7ec59b5-8a84-439b-a601-250cf63a0c4f/scratchpad/agents-final.log`; then:
```bash
node ./dist/scripts/agency.js agent --local -p "" ; echo "exit=$?"   # non-interactive bare → catalog + exit 0
```
Expected: all agent tests green (slots, resolution, models incl. back-compat, settings, agentTurn incl. recall + back-compat configure test); bare `--local` non-interactive prints the catalog and exits 0.

- [ ] **Step 7: Commit** *(only if asked)* — `git commit -m "feat(agent): --local guided setup, /local, cross-provider recall reaction"`

---

## Self-Review

**Spec coverage (Phase 1 rows of §7):**
- Slot registry + aliases + `SLOT_KIND` → Task 1. ✓
- Matrix over immutable layers, immediacy-outer (§3.2/§3.3) → Task 4. ✓
- `settings.model` honored + non-mutating slot validation + round-trip (§3.4) → Tasks 5, 6. ✓
- `parseModelSpec` unified string + `--model slot=model` (§4.5/§4.6) → Tasks 2, 7. ✓
- `--local` rename + guided setup + `/local` (§4.7) → Tasks 7, 9. ✓
- `/model` live switch + cross-provider reaction + turn-boundary (§4.1/§5) → Tasks 8, 9. ✓
- `getResolvedSlots`/`applyResolved` via `SLOT_KIND` (§6) → Task 6. ✓
- `standard`-only defaults; price knob deferred → Task 3. ✓
- **Back-compat verified through `configureModels`** (spec-review #4) → Task 6 Step 3. ✓

**Resolved from plan review:**
- Bug #1 `localModelsSupported`/`listModelNames` (verified names) → Task 9. ✓
- Bug #2 spec path `-dx-design.md` → header. ✓
- Bug #3 non-mutating `sanitizeModelSettings` (`{...m, slots}`) + `switchDoesNotMutatePrior` test → Tasks 5, 8. ✓
- #5 module-state → `Session` value in/out (Task 8). ✓
- #6 recall notice → deterministic `reactToSlotChange` tests (Task 9). ✓
- #7 `disableRecall` → real `disableMemory()` + flagged spec deviation (Task 9). ✓
- #8 settings round-trip test (Task 5). ✓
- #9 matrix cells → 8 tests incl. all immediacy/specificity boundaries + failure propagation (Task 4). ✓
- #13 `knownProviders` derived from `MODELS`+`BASE_URL_PROVIDERS`, no literal (Task 6 Step 1). ✓
- Anti-pattern: slot dispatch via `SLOT_KIND` (Tasks 1/3/6/9), not per-name if/elif. ✓
- Field order `{model, provider, via}` locked + commented (Tasks 2/3). ✓
- `via` surfaced in `/model` output (Task 8 Step 3). ✓
- `buildLayers`/`diffResolved` live in `resolution.agency` (not `models.agency` hub). ✓
- #10/#11 were stale-spec reads — spec already uses `price` and already has §4.7; no change needed.

**Deferred to Phase 2 (NOT here, by design):** catalog accessor, `agency models`/`refresh`, pickers *with filters*, `/price` + `economy`/`premium`, provider constraint, and the **selective tier-2 recall toggle** (Phase 1 uses full `disableMemory()`).

**Type consistency:** `{model, provider}` order across `ModelSpec`/`SlotValue`/`Resolved`. `Resolved` (Task 3) used in 4/6/8/9. `SlotChange` (Task 4) used in 8/9. `Session` (Task 8) passed in/out, never module-global mutable. `slotKind`/`SLOT_KIND` (Task 1) consumed in 3/6.
