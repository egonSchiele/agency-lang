# A default router and `/preset save` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The section "How to test" below overrides any step in that skill that runs a build or a test.

**Goal:** `agency agent` routes with Jev through OpenRouter when nothing
sets the router, and `/preset save [name]` writes the session's current
model settings to a preset.

**Architecture:** The default router is one more layer at the bottom of
the list the model resolver already walks, so every existing way to set
the router still wins. `/preset save` builds a preset from the same
`ModelRequest` the session resolves its models from, then writes it with
the code the coordinator's `savePreset` tool already uses.

**Tech Stack:** Agency, all under `lib/agents/agency-agent/`. No
TypeScript changes and no changes to `lib/runtime/` or `stdlib/`.

**Spec:** There is no separate spec. The "Decisions" section below is
the spec. The owner made each decision in conversation on 2026-11-09.
A review of the first draft is beside this file
(`2026-11-09-router-default-and-preset-save-review.md`), and every
finding in it is folded in here.

All paths below are relative to
`packages/agency-lang/lib/agents/agency-agent/` unless they start with
`docs/`, `.claude/`, or `.github/`.

## How to test

Read this section before anything else. It is the owner's instruction,
and it overrides habit.

**Write all the code and all the tests first. Build once. Run the tests
once.** The last agent that worked on the agency agent ran `make` and
the tests after every change, and a plan this size took two hours. Do
not do that.

The rules:

1. **Tasks 1 to 4 run no build and no test.** Each task writes its code
   and its tests, and commits. Do not run a test to watch it fail. Do
   not run `make`, `pnpm run build`, or `agency test` in these tasks.
2. **Task 5 runs `make` once and then the test files this plan lists,
   once.** Nothing else. Do not run `pnpm test`, `pnpm run test:agents`,
   or any test file this plan does not name.
3. **After a failure, batch the fixes.** Read every failing case in the
   saved output, fix all of them, then run `make` once more and rerun
   only the files that failed. If a third round is needed, stop and
   report what is still failing.
4. **Save every run's output to a file** and read the file. Never rerun
   a test to see its output again.
5. **Do not run the agent by hand.** The owner runs the smoke test.
   Task 5 writes the checklist for it into the pull request.
6. **CI runs the full suite** once the pull request is open. A red CI
   job is fixed the same way: read the log, batch the fixes, push once.

Cheap checks that do not build are fine at any time: reading code,
`rg`, and `pnpm run ast <file>` on a new file to confirm it parses.

## Background

### How a session picks its models today

A slot is a named job a model fills. There are four: `main`,
`reasoning`, `embedding`, and `router` (`lib/slots.agency:6`). The
`router` slot holds the decision model that sends a plain-text turn to
the researcher or the coder (`docs/dev/agents/agent-router.md`).

Every model choice goes through one record, `ModelRequest`
(`lib/modelRequest.agency:36`):

```
{ flags: ModelFlags, preset: Preset | null, choices: ModelChoices }
```

- `flags` holds the startup flags, such as `--model`.
- `preset` is the active preset from `settings.json`.
- `choices` holds what the user typed into `/model` this session.

`requestLayers` (`lib/modelRequest.agency:289`) turns the request into
four layers, most immediate first: `in-session`, `cli`, `preset`,
`settings`. `resolveSlot` (`lib/resolution.agency:44`) walks the layers
and takes the first one that sets the slot. A layer can set a slot two
ways: by name (`slots.router`), or with a `pin`, which is a bare model
name that fills every chat slot. Within one layer, a slot set by name
beats the pin.

When no layer sets a slot, `priceDefault` (`lib/models.agency:306`)
supplies a built-in model. For the `embedding` and `router` slots it
returns an empty model, which the rest of the agent reads as "not set".
These two are called derived slots (`SLOT_KIND` in `lib/slots.agency:14`):
a `pin` never fills them, and their value must name a provider, as in
`openrouter/jev-1.14`.

`resolveRequestAgainst` (`shared.agency:421`) is the one caller of
`requestLayers`. Startup reaches it through `resolveHostedModels`
(`shared.agency:436`), and `/model` calls it directly
(`lib/session.agency:305`). A local session (`--local`, or a preset with
a `local` field) does not reach it: it goes through
`configureLocalModel` (`shared.agency:544`), which builds the slots by
hand.

### Startup runs outside the policy handler, and `/model` runs inside it

This decides where the key check may live. Startup resolves the models
before the policy handler exists, and the comment at
`agent.agency:184-187` says that is on purpose. The REPL, and so
`/model` and `/preset`, runs inside the handler (`lib/turn.agency:118-134`).

Reading an environment variable raises a `std::env` interrupt. The
`recommended` policy has no rule for it, so inside the handler the read
becomes a prompt to the user. Under a handler that rejects, `env()`
returns a failure, and `missingProviderEnvVar` (`lib/models.agency:82`)
reads that failure as a key that is set.

So nothing that `/model` or `/preset` calls may read the environment.
The session's startup flags and `settings.model` are already kept in
`let` globals for this reason (`lib/session.agency:91-98`). The default
router's key check follows the same pattern: it runs once at startup,
and its result is kept.

### Why the router is off unless set

A user who wants routing has to write
`"slots": { "router": "openrouter/jev-1.14" }` into a preset or
`settings.json`, or type `/model router=openrouter/jev-1.14` in each
session. The owner's `glm` preset has no router line, so that preset
does not route.

### Why `/model` choices are lost

`/model` writes only to `choices`, which lives in the session. Nothing
copies it to a preset. The only code that writes presets is
`editPresets` (`brains/coordinator/presetTools.agency:23`), reached by
asking the model to call its `savePreset` tool.

## Decisions

These are settled. Do not reopen them.

1. **The default router is `openrouter/jev-1.14`.** All Jev requests go
   through OpenRouter. Do not look for `TYPESAFE_API_KEY`. The catalog
   lists `jev-latest` only under `typesafe`, so the default names
   `jev-1.14`.
2. **The default applies only when `OPENROUTER_API_KEY` is set**, and it
   applies whatever the chat provider is.
3. **A one-shot run gets the default router too.** The owner decided
   this on 2026-11-09. `agency agent -p "..."` and a prompt piped on
   stdin route the same way an interactive session does. Do not add a
   check for one-shot anywhere in the default's code. A one-shot run
   prints no header, so nothing in its output shows the router. The
   pull request description must say that an eval or benchmark script
   with `OPENROUTER_API_KEY` set now routes, and that
   `--model router=off` turns it off.
4. **The default never applies in a local session**, one-shot or
   interactive.
5. **The startup header shows the router**, the same way it shows the
   main and reasoning models.
6. **`router=off` turns routing off.** It is accepted wherever a router
   value is: `--model router=off`, `/model router=off`, a preset, and
   `settings.model.slots.router`.
7. **`/preset save` writes to the active preset. `/preset save <name>`
   writes to that name**, creating it when it is new.
8. **A save copies the session.** The saved preset, loaded in a fresh
   session with no flags, must resolve the same models, effort,
   options, and tool limits this session has. So a preset's `effort`
   that the session dropped (because `/model` changed a chat model) is
   dropped from the saved preset too.
9. **A save prints every field it changed**, one line per field.
10. **A save does not copy values that came from `settings.model` or from
   the default layer.** A preset stays as small as the user wrote it.

## Global Constraints

- Follow "How to test" above.
- Do not run `agency fmt` on a file that already exists. Format only
  files this plan creates.
- Never hand-edit `docs/site/` or `CHANGELOG.md`.
- Write each commit message to a file and pass it with `git commit -F`.
  Never amend and never force push.
- One pull request. The owner merges it.
- Agency syntax: `def`, braces, parentheses around conditions, `let` or
  `const` before use. Check snippets against
  `docs/site/guide/basic-syntax.md`.

## Review Focus

Each line names an input no decision above spells out, and the behavior
to expect. Each has a test in the task named.

1. **A bare model typed into `/model` when no provider is fixed.** The
   session runs it on the provider detected from API keys. A saved
   preset holding only that bare name would be resolved on `openai` at
   the next start (`lib/models.agency:195`). (Task 3)
2. **A higher layer's pin over a lower layer's named slot.** The preset
   has `slots.main`, then the user types `/model x`. The session runs
   `x` in `main`. A save that merged the two layers field by field would
   write `pin: x` beside `slots.main`, and the saved preset would run
   the old `slots.main`. (Task 3)
3. **A session moved by `/local`.** `/local` (`lib/repl.agency:241`)
   calls `configureLocalModel` directly and does not change the
   `ModelRequest`. A save would then write the hosted models the session
   no longer runs. (Task 4)
4. **`settings.json` that does not parse.** The save must fail with a
   message and leave the file as it was. (Task 4)
5. **`off` in a slot that has no default.** `embedding=off` must still be
   refused with the provider-form message, since there is nothing to
   turn off. (Task 1)

Known limits, with no test. Each goes in a dev doc in Task 5.

- A preset named `save` can no longer be reached with `/preset save`. It
  still loads with `--preset save`.
- The change lines compare against the presets read at startup. If
  another agent session saved the same preset since this one started,
  the lines describe the wrong change, and "Nothing to save" can skip a
  write.
- A resumed session restores its Agency globals from the checkpoint,
  and that includes the kept default slots. Read
  `docs/dev/agents/agent-sessions.md` to find whether the restore runs
  after `pickModelsForAgent`, and write the true statement in the dev
  doc: either a resumed session uses the default slots it was saved
  with, or it uses this startup's. Do not add code for it.

---

### Task 1: `off`, and the default layer

**Files:**
- Modify: `lib/slots.agency`
- Modify: `lib/models.agency:117-122` (`lacksProviderForm`)
- Modify: `lib/resolution.agency:44-88` (`resolveSlot`)
- Modify: `shared.agency` (`resolveRequestAgainst`,
  `resolveHostedModels`, `localRouterSlot`, new `defaultSlots` and
  `explicitRouterSpec`)
- Modify: `lib/session.agency` (`setStartupModelFlags`,
  `applyModelRequest`, `switchModel`, `pickModelsForAgent`)
- Modify: `lib/repl.agency:267-271` (`localSlashCommand`)
- Test: `tests/slots.agency`, `tests/resolution.agency`,
  `tests/modelRequest.agency`, `tests/localRouter.agency`,
  `tests/presetSession.agency`, and their `.test.json` files

**Interfaces:**
- Produces, in `lib/slots.agency`:
  - `export static const SLOT_DEFAULTS: Record<string, string> = { router: "openrouter/jev-1.14" }`
  - `export static const SLOT_OFF = "off"`
  - `export def slotCanBeOff(name: string): boolean`, true when the
    canonical slot has a row in `SLOT_DEFAULTS`.
- Produces, in `shared.agency`:
  - `export def defaultSlots(): Record<string, string>`, the rows of
    `SLOT_DEFAULTS` whose provider has its key. It reads the
    environment, so only startup may call it.
  - `export def explicitRouterSpec(): string`
  - `resolveRequestAgainst` and `resolveHostedModels` each gain a last
    parameter, `defaults: Record<string, string> = {}`.
- Produces, in `lib/session.agency`:
  - `setStartupModelFlags(flags, settings, defaults: Record<string, string> = {})`,
    which keeps `defaults` in a new `let _startupDefaultSlots`.
- A slot resolved from the default layer has
  `via == "default:per-slot"`. A slot turned off has an empty model, an
  empty provider, and `via == "<layer name>:off"`.

The new parameters default to `{}` so that every existing test that
calls these functions gets no default router and needs no change.

- [ ] **Step 1: Add the table and `slotCanBeOff` to `lib/slots.agency`**

Give `SLOT_DEFAULTS` a doc comment that says the default applies only in
a hosted session whose environment has the provider's key.

- [ ] **Step 2: Exempt `off` in `lacksProviderForm`**

Return `false` when `slotCanBeOff(slot) && value == SLOT_OFF`. This one
function is the check behind all four places a router value comes in:
the flag (`lib/modelRequest.agency:99`), `/model`
(`lib/session.agency:281`), `settings.json` (`lib/settings.agency:92`),
and a preset (`lib/presetRules.agency:136`).

- [ ] **Step 3: Resolve `off` to an empty slot in `resolveSlot`**

In the per-slot branch, before the existing return: when
`slotCanBeOff(slot)` and the value's provider is `""` and its model is
`SLOT_OFF`, return an empty model and provider with via
`"${layer.name}:off"`.

- [ ] **Step 4: Add `defaultSlots` and the default layer**

`defaultSlots()` keeps a row of `SLOT_DEFAULTS` when
`missingProviderEnvVar(provider) == ""`, where the provider comes from
`parseModelSpec(spec, false, providersFor(slot, knownProviders()))`.

In `resolveRequestAgainst`, append one raw layer after the four from
`requestLayers`:

```ts
const raw = [
  ...requestLayers(request, settings),
  { name: "default", pin: "", slots: defaults }
]
```

`resolveHostedModels` passes its own `defaults` parameter through.
Neither function reads the environment for this.

- [ ] **Step 5: Keep the default slots for the session**

- `pickModelsForAgent` (`lib/session.agency:475`) calls `defaultSlots()`
  and passes the result as the third argument of
  `setStartupModelFlags`. This is the only call of `defaultSlots()`
  outside tests.
- `applyModelRequest` passes `_startupDefaultSlots` to
  `resolveHostedModels`.
- `switchModel` passes `_startupDefaultSlots` to `resolveRequestAgainst`.

A local request never reaches these two functions, so decision 4 needs
no code.

`pickModelsForAgent` runs for a one-shot run and for an interactive
session alike, before `agent.agency` branches on `isOneShot`. That is
what gives a one-shot run the default (decision 3). Keep it that way.

- [ ] **Step 6: Make `localRouterSlot` read `off` as no router**

`localRouterSlot("off")` must return the same value as
`localRouterSlot("")`. Without this, `--local x --model router=off`
would set a router model named `off` with no provider.

- [ ] **Step 7: Keep the default out of `/local`**

`localSlashCommand` carries the hosted session's router into the local
session. Carry it only when the user set it. `explicitRouterSpec()`
goes beside `getRouterModel` in `shared.agency`: it returns `""` when
the router is unset or its `via` is `"default:per-slot"`, and otherwise
`"<provider>/<model>"`. Use it in `localSlashCommand` in place of the two
lines that build `routerSpec`.

- [ ] **Step 8: Write the tests**

Add these nodes, each with an `exact` case in the matching `.test.json`.
Follow the node and case shape already in each file. Do not run them.

`tests/slots.agency`:

| Node | Returns |
| --- | --- |
| `routerCanBeOff` | `slotCanBeOff("router")` is `true` |
| `embeddingCannotBeOff` | `slotCanBeOff("embedding")` is `false` |
| `mainCannotBeOff` | `slotCanBeOff("main")` is `false` |

`tests/resolution.agency`, using `buildLayers` and `resolveSlot` with the
file's existing `CTX`:

| Node | Layers, most immediate first | Expected `router` |
| --- | --- | --- |
| `defaultLayerSetsTheRouter` | `default` with `slots.router = "openrouter/jev-1.14"` | model `jev-1.14`, provider `openrouter`, via `default:per-slot` |
| `aPresetBeatsTheDefault` | `preset` with `router = "openrouter/jev-1.13"`, then `default` | model `jev-1.13`, via `preset:per-slot` |
| `offBeatsTheDefault` | `preset` with `router = "off"`, then `default` | model `""`, provider `""`, via `preset:off` |
| `offInTheMainSlotIsAModelName` | `preset` with `main = "off"` | model `off` |

`tests/modelRequest.agency`, through `modelFlagsFromArgs`:

| Node | Args | Expected |
| --- | --- | --- |
| `routerOffFlagIsAccepted` | `--model router=off` | success, `slots.router == "off"` |
| `embeddingOffFlagIsRefused` | `--model embedding=off` | failure whose message contains `Embedding models need the provider/model form` |

`tests/localRouter.agency`. `DEFAULTS` is
`{ router: "openrouter/jev-1.14" }`. Only the first two nodes touch the
environment, with `setEnv("OPENROUTER_API_KEY", ...) with approve`:

| Node | Setup | Expected |
| --- | --- | --- |
| `keySetGivesADefaultRouter` | key `"test-key"`, call `defaultSlots()` | `router` is `openrouter/jev-1.14` |
| `emptyKeyGivesNoDefault` | key `""`, call `defaultSlots()` | `{}` |
| `localStartGetsNoDefaultRouter` | `setStartupModelFlags` with `local: "mlx:mlx-community/Qwen3-4B-4bit"` (the model this file already uses) and `DEFAULTS`, then `applyModelRequest` | `getRouterModel()` is `""` |
| `localRouterOffIsEmpty` | the file's local setup with router spec `"off"` | `getRouterModel()` is `""` |

`localStartGetsNoDefaultRouter` goes through `applyModelRequest`
because that is the path a real local start takes. A node that called
`configureLocalModel` directly could not fail.

`tests/presetSession.agency`, which already sets up a hosted session
with `setStartupModelFlags`:

| Node | Setup | Expected |
| --- | --- | --- |
| `storedDefaultSetsTheRouter` | `setStartupModelFlags(noModelFlags(), {}, DEFAULTS)`, then `switchModel(..., "reasoning=claude-opus-4-8", ...)` | resolved router is `jev-1.14` on `openrouter`, via `default:per-slot` |
| `noStoredDefaultNoRouter` | the same with no third argument | router model is `""` |
| `routerOffChoiceTurnsItOff` | `DEFAULTS` stored, then `switchModel(..., "router=off", ...)` | router model is `""` |
| `defaultRouterIsNotExplicit` | after `storedDefaultSetsTheRouter`'s setup | `explicitRouterSpec()` is `""` |
| `chosenRouterIsExplicit` | `switchModel(..., "router=openrouter/jev-1.13", ...)` | `explicitRouterSpec()` is `openrouter/jev-1.13` |

- [ ] **Step 9: Commit**

### Task 2: The router in the startup header

**Files:**
- Modify: `lib/header.agency:19-45` (`slotModelLabel`,
  `headerModelLines`)
- Test: `brains/coordinator/tests/agentTurn.agency` and its
  `.test.json`, which already reach `headerModelLines` with
  `import test`

- [ ] **Step 1: Make `slotModelLabel` return `""` for an empty model**

Today a slot with model `""` and provider `""` gives `" ()"`. That is
what `off` produces, so without this change a router turned off would
print a `Router      ()` line.

- [ ] **Step 2: Add the router line to `headerModelLines`**

Push `"Router     ${label}"` when the label is not empty. The label
column is eleven characters wide, as in the two existing lines.

- [ ] **Step 3: Write the tests**

| Node | Slots | Expected lines |
| --- | --- | --- |
| `headerShowsTheRouter` | main, reasoning, and router `jev-1.14` on `openrouter` | third line is `Router     jev-1.14 (openrouter)` |
| `headerOmitsAnUnsetRouter` | no `router` key | two lines |
| `headerOmitsARouterTurnedOff` | router with model `""` and provider `""` | two lines |

- [ ] **Step 4: Commit**

### Task 3: Build a preset from the session

**Files:**
- Modify: `lib/resolution.agency` (add `flattenLayers`; add `isChatSlot`
  to the import from `./slots.agency` on line 6)
- Modify: `lib/toolLimits.agency` (add `startupLimitFlags`)
- Create: `lib/presetSnapshot.agency`
- Create: `tests/presetSnapshot.agency`, `tests/presetSnapshot.test.json`
- Test: also `tests/resolution.agency`

**Interfaces:**
- Produces, in `lib/resolution.agency`:
  `export def flattenLayers(layers: RawLayer[]): RawLayer`
- Produces, in `lib/toolLimits.agency`:
  `export def startupLimitFlags(): LimitFlags`, which returns the
  module's `_startupFlags`.
- Produces, in `lib/presetSnapshot.agency`:
  - `export def sessionPreset(request: ModelRequest, limits: LimitFlags, resolved: Record<string, Resolved>): Preset`
  - `export def presetChangeLines(before: Preset | null, after: Preset): string[]`

Both functions in the new file are pure. Neither reads a global, the
environment, or a file. `resolved` is the session's resolved slots,
which the caller reads from `getResolvedSlots()`.

**`flattenLayers`.** It folds several layers into one that resolves the
same way. This is the algorithm, because the signature does not
determine it:

```ts
export def flattenLayers(layers: RawLayer[]): RawLayer {
  let pin = ""
  let slots: Record<string, string> = {}
  for (layer in layers) {
    for (key in Object.keys(layer.slots)) {
      const slot = canonicalSlot(key)
      // A pin in a more immediate layer hides every chat slot below it.
      const hidden = pin != "" && isChatSlot(slot)
      if (slots[slot] == null && !hidden) {
        slots[slot] = layer.slots[key]
      }
    }
    if (pin == "") {
      pin = layer.pin
    }
  }
  return {
    name: "flat",
    pin: pin,
    slots: slots
  }
}
```

A layer's own named slots are read before its pin is recorded, because
within one layer a named slot beats the pin.

**`sessionPreset`.** It returns the preset that, loaded with no flags
and no `/model` choices, gives this request's models, options, effort,
and limits. Call each helper with empty settings (`{}`) so that nothing
from `settings.model` is copied (decision 10). `requestLayers(request, {})`
does not include the default layer either, so a default router is not
copied.

Let `flat = flattenLayers(requestLayers(request, {}))` and
`provider = requestProvider(request, {})`. There are three cases for
the model fields.

*Local request* (`localModelOf(request) != null`): set `local` to the
local model, and `slots.embedding` and `slots.router` from
`localModelOf(request)`. No `provider` or `pin`.

*Hosted, provider fixed* (`provider != ""`): set `provider`, `pin` from
`flat.pin`, and `slots` from `flat.slots`. This is the owner's `glm`
case, and the preset comes back as the user wrote it plus the session's
changes.

*Hosted, no provider fixed* (`provider == ""`): the session's provider
came from API keys, and a bare model name in a saved preset would be
resolved on a different provider at the next start. So write no
`provider` and no `pin`. Copy the derived slots from `flat.slots`. Then,
if `flat` names any chat model (`flat.pin != ""`, or `flat.slots` has
`main` or `reasoning`), write both chat slots from `resolved`:

```
slots.main      = qualified(resolved["main"])
slots.reasoning = qualified(resolved["reasoning"])
```

where `qualified` is `"${demoteProvider(provider)}/${model}"`, or the
bare model when the resolved provider is `""`. `demoteProvider` turns
the internal `openai-responses` back into `openai`. Both chat slots are
written so that neither falls back to a built-in default that depends
on which keys are set. If `flat` names no chat model, write no chat
slot.

The other fields are the same in all three cases:

| Field | Value |
| --- | --- |
| `llmOptions` | `requestLlmOptions(request, {})` |
| `effort` | `requestEffort(request)` |
| `maxToolCallRounds` | `limits.maxToolCallRounds`, else the request's preset's |
| `maxToolResultChars` | `limits.maxToolResultChars`, else the request's preset's |

Leave out every field whose value is `""`, `null`, or an empty object.
Never set `default`: `applyPresetEdit` keeps that flag on a replace
(`keepDefaultFlag`, `lib/presets.agency:324`).

**`presetChangeLines`.** It compares these fields in this order:
`provider`, `pin`, `local`, `slots.main`, `slots.reasoning`,
`slots.embedding`, `slots.router`, `effort`, `maxToolCallRounds`,
`maxToolResultChars`, `llmOptions`. It ignores `default`. For each field
that differs it returns one line:

```
  slots.router: (none) → openrouter/jev-1.14
  effort: low → (none)
```

A missing value prints as `(none)`. `llmOptions` is compared and printed
as `JSON.stringify` of the block. `before == null` means a new preset,
so every set field prints with `(none)` on the left. No differences
returns `[]`.

- [ ] **Step 1: Implement `flattenLayers` and `startupLimitFlags`**

- [ ] **Step 2: Implement `lib/presetSnapshot.agency`**

Give the file a module doc comment. Drive `presetChangeLines` from one
list of field names, with a small helper that reads `slots.router` style
paths, so adding a preset field is one entry in that list.

- [ ] **Step 3: Write the tests**

`tests/resolution.agency`: for each row, resolve `main`, `reasoning`,
and `router` from the layers, then from `[flattenLayers(layers)]`, and
return whether the models and providers are equal. Each expects `true`.

| Node | Layers, most immediate first |
| --- | --- |
| `flatKeepsAPinOverALowerSlot` | `in-session` pin `x`; `preset` `slots.main = y` |
| `flatKeepsASlotOverALowerPin` | `in-session` `slots.reasoning = x`; `preset` pin `y` |
| `flatKeepsALowerRouterUnderAPin` | `in-session` pin `x`; `preset` `slots.router = openrouter/jev-1.14` |
| `flatKeepsTheFirstPin` | `cli` pin `x`; `preset` pin `y` |

`tests/presetSnapshot.agency` has two groups.

*Group 1, the property in decision 8.* One helper,
`sameSession(request): string`, does this:

1. Resolve the request with `resolveHostedModels(request, {})` and call
   the result `before`.
2. Build `saved = sessionPreset(request, NO_LIMITS, before)`.
3. Resolve
   `{ flags: noModelFlags(), preset: saved, choices: noModelChoices() }`
   the same way and call the result `after`.
4. Return `"same"` when the model and provider of `main`, `reasoning`,
   `embedding`, and `router` match, and `requestEffort` and
   `requestLlmOptions` of the two requests match. Otherwise return the
   name of the first thing that differs.

Each node sets the keys it needs with `setEnv(...) with approve` and
expects `"same"`. `GLM` is the preset
`{ provider: "openrouter", pin: "z-ai/glm-5.3-flash", effort: "low", llmOptions: { openRouter: { provider: { only: ["baseten/fp8"] } } } }`.

| Node | Keys set | Request |
| --- | --- | --- |
| `sameAfterNoChange` | OpenRouter | preset `GLM` |
| `sameAfterARouterChoice` | OpenRouter | preset `GLM`, choices `slots.router = "openrouter/jev-1.14"` |
| `sameAfterAChatModelChoice` | OpenRouter | preset `GLM`, choices pin `z-ai/glm-5.3` |
| `sameAfterAPinOverAPresetSlot` | OpenRouter | preset `{ provider: "openrouter", slots: { main: "z-ai/glm-5.3-flash" } }`, choices pin `z-ai/glm-5.3` |
| `sameAfterABarePinWithADetectedProvider` | Anthropic only | no preset, choices pin `claude-opus-4-8` |
| `sameAfterAOneSlotChoiceWithADetectedProvider` | Anthropic only | no preset, choices `slots.reasoning = "claude-opus-4-8"` |
| `sameAfterAModelFlag` | Anthropic only | preset `GLM`, flags pin `claude-opus-4-8` |

A test that sets one provider's key must set the others to `""`, so the
detected provider does not depend on the shell.

*Group 2, the exact shape.* `NO_LIMITS` is both limit flags `null`, and
`NONE` is `{}` for the resolved slots, which these cases do not read.

| Node | Call | Expected |
| --- | --- | --- |
| `unchangedSessionGivesThePresetBack` | preset `GLM` | `JSON.stringify` equal to `GLM`'s |
| `routerOffIsSaved` | preset `GLM`, choices `slots.router = "off"` | `slots.router` is `"off"` |
| `chatModelChoiceDropsTheEffort` | preset `GLM`, choices pin `z-ai/glm-5.3` | no `effort` field |
| `modelFlagDropsThePresetsModelFields` | preset `GLM`, flags pin `claude-opus-4-8`, resolved main and reasoning `claude-opus-4-8` on `anthropic` | `slots.main` is `anthropic/claude-opus-4-8`, and no `provider`, `pin`, `effort`, or `llmOptions` |
| `effortFlagIsSaved` | preset `GLM`, flags `effort: "high"` | `effort` is `high` |
| `limitFlagIsSaved` | preset `GLM`, limits `maxToolCallRounds: 40` | `maxToolCallRounds` is `40` |
| `sessionOptionsReplaceThePresets` | preset `GLM`, choices `llmOptions: { temperature: 0 }` | `llmOptions` is `{ temperature: 0 }` |
| `settingsAreNotCopied` | no preset, no flags, no choices | `{}` |
| `localRequestSavesLocal` | flags `local: "qwen"`, `slots.router = "openrouter/jev-1.14"` | `local: "qwen"`, `slots.router` set, no `pin` or `provider` |
| `changeLinesForARouter` | `presetChangeLines(GLM, GLM plus the router)` | exactly `["  slots.router: (none) → openrouter/jev-1.14"]` |
| `changeLinesForADroppedEffort` | `presetChangeLines(GLM, GLM without effort)` | exactly `["  effort: low → (none)"]` |
| `noChangeLines` | `presetChangeLines(GLM, GLM)` | `[]` |
| `changeLinesIgnoreDefault` | `before` is `GLM` with `default: true`, `after` is `GLM` | `[]` |

- [ ] **Step 4: Format the two new files and commit**

```bash
pnpm run fmt lib/agents/agency-agent/lib/presetSnapshot.agency
pnpm run fmt lib/agents/agency-agent/tests/presetSnapshot.agency
```

If `pnpm run fmt` needs a build that does not exist yet, leave this for
Task 5, after the one `make`.

### Task 4: `/preset save`

**Files:**
- Modify: `lib/presets.agency` (receives `editPresets`)
- Modify: `brains/coordinator/presetTools.agency:23-38` (loses it)
- Modify: `lib/session.agency` (add `parsePresetCommand`,
  `saveSessionPreset`; remove `parsePresetName`)
- Modify: `lib/repl.agency:205-223` (`presetSlashCommand`)
- Modify: `lib/commandPalette.agency:68`
- Test: `tests/presetSession.agency` and its `.test.json`

**Interfaces:**
- Consumes: `sessionPreset`, `presetChangeLines`, `startupLimitFlags`
  from Task 3.
- Produces, in `lib/presets.agency`:
  `export def editPresets(edit: PresetEdit): Result<PresetEditOutcome>`,
  moved as it is.
- Produces, in `lib/session.agency`:
  - `export type PresetCommand = { kind: "list" | "switch" | "save"; name: string }`
  - `export def parsePresetCommand(cmd: string): PresetCommand`
  - `export def saveSessionPreset(name: string, choices: ModelChoices): string[]`,
    the lines to print.

**Moving `editPresets`.** `lib/presets.agency` already imports the
`Settings` type from `lib/settings.agency`, and `settings.agency` does
not import `presets.agency`, so adding `readSettingsFile` and
`writeSettingsFile` to that import makes no cycle. Update the
`@summary` of `presetTools.agency`, which says `editPresets` lives
there.

**`parsePresetCommand`.**

| Input | Result |
| --- | --- |
| `/preset` | `{ kind: "list", name: "" }` |
| `/preset glm` | `{ kind: "switch", name: "glm" }` |
| `/preset save` | `{ kind: "save", name: "" }` |
| `/preset save fast` | `{ kind: "save", name: "fast" }` |
| `/preset saved` | `{ kind: "switch", name: "saved" }` |

**`saveSessionPreset(name, choices)`.** In order:

1. The target is `name`, or `activePresetName()` when `name` is `""`.
   With neither, return
   `["No preset is active. Name one: /preset save <name>"]`.
2. Build the request with `currentModelRequest(choices)`.
3. If the session's `main` slot has `via == "local"` and
   `requestIsLocal(request)` is false, or the reverse, return
   `["Not saved: this session moved to or from a local model with /local, which a save cannot copy. Start with --local or a local preset, then save."]`.
   `configureLocalModel` marks every slot it sets with `via: "local"`
   (`shared.agency:549`).
4. Build the preset with
   `sessionPreset(request, startupLimitFlags(), getResolvedSlots())`,
   then pass it through `checkPreset(target, preset, false)`. On failure
   return `["Not saved: ${reason}"]`.
5. Find the saved preset of that name with `findPreset(target)`. It
   fails for a new name and also for a saved preset that is not valid.
   In both cases `before` is `null`, so every field prints.
6. Compute `presetChangeLines(before, checked.value)`. If it is empty
   and `findPreset` succeeded, return
   `["Nothing to save: this session matches the '${target}' preset."]`
   and write nothing.
7. Call `editPresets({ kind: "save", name: target, preset: checked.value }) with approve`.
   On failure return `["Not saved: ${reason}"]`.
8. Return the heading and the change lines. The heading is
   `Saved the '${target}' preset:` when the outcome's `existed` is true
   and `Created the '${target}' preset:` when it is false. `existed`
   comes from `editPresets`, which reads the file, so a save over a
   preset that was not valid still says "Saved".

A save does not switch the session to the saved preset, and it does not
clear the `/model` choices. The session resolves the same models either
way.

**The approval the user sees.** `with approve` means the handler here
does not object, which is what `saveSettings` does for a preference the
user just changed (`lib/settings.agency:209-222`). A policy in the chain
still decides. The `recommended` policy approves reading `settings.json`
and has no rule for writing it, so under `recommended` the user gets one
`std::write` prompt for `settings.json`. That is correct: the file
decides what the next agent start runs. Do not add code to avoid it.

The coordinator's `savePreset` tool also asks about an
`llmOptions.baseUrl.mlx` address before it writes. This command does
not: an address in the session's block was already approved when
`useLlmOptions` set it, and an address in the preset's own block is
already in the file.

- [ ] **Step 1: Move `editPresets` to `lib/presets.agency`**

- [ ] **Step 2: Implement `parsePresetCommand` and `saveSessionPreset`**

Replace `parsePresetName` and change its existing tests to call the new
function.

- [ ] **Step 3: Wire `presetSlashCommand`**

Match on the command's `kind`. `list` and `switch` keep today's code.
`save` calls `saveSessionPreset(command.name, _session)` and pushes each
line with `pushMessage`.

- [ ] **Step 4: Update the palette text**

`"/preset": "Switch to a saved preset, or save this session to one: /preset [name], /preset save [name]"`.
The palette test file has no `/preset` text, so no test changes.

- [ ] **Step 5: Write the tests**

In `tests/presetSession.agency`. The save nodes write `settings.json`
the way `tests/settings.agency:282` does, with
`write(SETTINGS_FILE, ..., POLICY_DIR) with approve`, then load the
table with `setPresetTable(readPresetTable(...))` as `usePresets` does.

| Node | Setup | Expected |
| --- | --- | --- |
| one node per row of the `parsePresetCommand` table | | the `kind` and `name` shown |
| `saveWithNoPresetAndNoNameIsRefused` | no active preset, `saveSessionPreset("", noModelChoices())` | first line is `No preset is active. Name one: /preset save <name>` |
| `saveAddsTheRouterToTheActivePreset` | active preset `small`, then `switchModel(..., "router=openrouter/jev-1.14", ...)`, then save with the returned session | lines are `Saved the 'small' preset:` and `  slots.router: (none) → openrouter/jev-1.14`; the file read back has `presets.small.slots.router`; `presets.big` is unchanged |
| `saveKeepsTheDefaultFlag` | the file's `small` has `default: true` | the file read back still has it |
| `saveUnderANewNameCreatesIt` | active `small`, `saveSessionPreset("fast", ...)` | first line is `Created the 'fast' preset:`; `activePresetName()` is still `small` |
| `saveWithNothingChangedWritesNothing` | active `small`, no choices | the one line is `Nothing to save: this session matches the 'small' preset.` |
| `savedPresetIsUsableAtOnce` | save as `fast`, then `switchPreset("fast")` | success |
| `saveAfterLocalSwitchIsRefused` | active `small`, then `applyResolved` with a `main` slot whose `via` is `"local"` | first line starts with `Not saved: this session moved` |
| `saveLeavesABrokenFileAlone` | write `not json{{{` to `settings.json`, then save with a router choice | first line starts with `Not saved:`; the file text is still `not json{{{` |
| `saveRefusesABadName` | `saveSessionPreset("Bad Name", ...)` | first line starts with `Not saved:` |

- [ ] **Step 6: Commit**

### Task 5: Docs, one test run, and the pull request

**Files:**
- Modify: `docs/dev/agents/agent-router.md`
- Modify: `docs/dev/agents/agent-presets.md`
- Modify: `packages/agency-lang/CLAUDE.md`, the `agent-presets.md` and
  `agent-router.md` index lines
- Modify: `packages/agency-lang/.claude/skills/agency-agent-docs/SKILL.md`,
  lines 16 and 17, the same two lines. Its `agent-presets.md` line is
  already behind the one in `CLAUDE.md` (it lacks the clause about
  reasoning effort), so bring both lines into step.

- [ ] **Step 1: Update `docs/dev/agents/agent-router.md`**

State the rule and the mechanism only, with no history:

- the default and where it is defined (`SLOT_DEFAULTS`);
- the key rule;
- that a one-shot run gets the default too, that it prints no header,
  and that `--model router=off` is how a script opts out;
- why the key is read once at startup and kept (the policy handler);
- the `default` layer and why it is a layer and not `priceDefault`
  (`priceDefault` is pure, and its tests assert exact values);
- why a local session gets none, and why `/local` does not carry it;
- `off`, and the header line;
- the resumed-session limit from "Known limits".

- [ ] **Step 2: Update `docs/dev/agents/agent-presets.md`**

- In "How a run picks its models", the layer list gains `default`.
- A new section, "Saving the session to a preset": the command, the
  rule that a saved preset must load to the same session, the three
  cases for the model fields and why the no-provider case writes
  `provider/model` slots, `flattenLayers` and the pin case it exists
  for, what is not copied, the `/local` refusal, why the write uses
  `with approve` and that the user still sees one `std::write` prompt
  under `recommended`, and the two limits from "Known limits".
- In "Where things live", `editPresets` moves to `lib/presets.agency`
  and `lib/presetSnapshot.agency` gets a row.

- [ ] **Step 3: Update the two index lines in both files, and commit the docs**

- [ ] **Step 4: Check the whole diff against `docs/dev/contributing/anti-patterns.md`**

Fix what you find now, before the build, so the fixes are in the one
test run.

- [ ] **Step 5: Build once and run the listed tests once**

```bash
cd packages/agency-lang
make > /tmp/router-make.out 2>&1
for t in slots resolution modelRequest localRouter presetSnapshot presetSession presets; do
  AGENCY_USE_TEST_LLM_PROVIDER=1 HOME="$(mktemp -d)" \
    pnpm run agency test lib/agents/agency-agent/tests/$t.agency \
    > /tmp/router-test-$t.out 2>&1
done
AGENCY_USE_TEST_LLM_PROVIDER=1 HOME="$(mktemp -d)" \
  pnpm run agency test lib/agents/agency-agent/brains/coordinator/tests/agentTurn.agency \
  > /tmp/router-test-agentTurn.out 2>&1
```

`AGENCY_USE_TEST_LLM_PROVIDER=1` is what CI sets for the agent tests
(`.github/workflows/test.yml:238-260`). Without it, a node in
`agentTurn.agency` that runs a turn can call a real model.

These eight files are the whole list. If `make` fails, read
`/tmp/router-make.out`, fix every error it names, and run `make` again
before any test.

- [ ] **Step 6: Fix failures in one batch**

Read all eight output files. Fix every failing case. Then run `make`
once and rerun only the files that had a failure. If anything still
fails after that second run, stop and report it with the output.

- [ ] **Step 7: Commit, push, and open the pull request**

Write the description to a file. It must include:

- that a one-shot run with `OPENROUTER_API_KEY` set now routes by
  default, and that `--model router=off` turns it off;
- which test files were run locally, and that CI runs the rest;
- this smoke test for the owner, as a checklist. The agent does not run
  it.

  Default router, with `OPENROUTER_API_KEY` set and no router in any
  preset:

  1. Start `agency agent`. The header has a
     `Router     jev-1.14 (openrouter)` line.
  2. `/model` lists `router: jev-1.14 (default:per-slot)`, and no
     prompt to read an environment variable appears.
  3. A research question goes to the researcher with no coordinator
     call.
  4. `/model router=off`, then ask again. The coordinator answers.
  5. Start with `--local <model>`. The header has no router line.

  `/preset save`, with a preset that has no router:

  1. `agency agent --preset glm`, `/model router=off`, `/preset save`.
     One prompt asks to write `settings.json`. After approving, two
     lines print, and the second is `  slots.router: (none) → off`.
  2. Start again with `--preset glm`. The header has no router line.
  3. `/preset save` prints the "Nothing to save" line.
  4. `/preset save copy` prints `Created the 'copy' preset:`, and
     `/preset` lists `copy`.

Then stop. The owner merges.
