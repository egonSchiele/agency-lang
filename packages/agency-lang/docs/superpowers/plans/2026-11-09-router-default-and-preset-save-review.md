# Review: A default router and `/preset save`

Plan: `docs/superpowers/plans/2026-11-09-router-default-and-preset-save.md`

I checked each claim in the plan against the code in this worktree. Most
of them hold. Three problems would ship a visible bug or break a
decision, and they should be fixed in the plan before anyone starts
Task 1. The rest are smaller.

Paths are relative to `packages/agency-lang/lib/agents/agency-agent/`
unless they start with `lib/runtime/`, `stdlib/`, `docs/`, or `.github/`.

## Must fix before starting

### 1. The default layer reads an environment variable inside the policy handler, so `/model` would ask for approval

Task 1, Step 6 puts `defaultSlots()` inside `resolveRequestAgainst`.
`defaultSlots()` calls `missingProviderEnvVar`, which reads the key with
`env(varName) with approve` (`lib/models.agency:84`). That raises a
`std::env` interrupt each time it runs.

Startup is safe. It resolves models before the policy handler exists,
and `agent.agency:184-187` says that is on purpose: "the settings reads
behind them must run before the policy handler exists or they prompt."

`/model` and `/preset` are not safe. The REPL runs inside `runSession`,
which wraps the whole session in the CLI policy handler
(`lib/turn.agency:118-134`). The `recommended` policy has no `std::env`
rule (`lib/runtime/builtinPolicies.ts:119-200`). With no matching rule,
`checkPolicy` returns `propagate` (`lib/runtime/policy.ts:52`), and the
CLI handler asks the user (`stdlib/policy.agency:1167-1196`). The
`with approve` in `missingProviderEnvVar` does not stop this: a
propagate from any handler in the chain goes to the person.

Today `/model` reads no environment variable. `switchModel` calls
`resolveRequestAgainst` directly, with no provider detection
(`lib/session.agency:252-326`). After this plan, every `/model` command,
including `/model router=off`, would show a prompt asking to read
`OPENROUTER_API_KEY`.

A non-interactive handler is worse. It rejects the read, `env()` returns
a Failure, and the check `keyValue == null || keyValue == ""` treats
that Failure as a key that is set. The default router would then be
added with no key behind it.

**Fix.** Work out the default slots once, at startup, and keep them for
the session the same way `_startupModelSettings` is kept
(`lib/session.agency:91-98`). For example:

- `pickModelsForAgent` calls `defaultSlots()` before it resolves
  anything, and stores the result with the startup flags and settings.
- `resolveRequestAgainst` takes the default slots as a parameter (or
  reads the stored value) and appends the `default` layer from it.
  Nothing in it reads the environment.

This also helps the tests. A test sets the stored default slots
directly and never touches `OPENROUTER_API_KEY`. That removes the
environment dependence in Review Focus 2, and most of Step 9's sweep
goes away, because a node that never stores defaults gets none. Keep
one test that calls `defaultSlots()` with the key set and with it empty,
to cover the key rule itself.

Check one thing when building it. A resumed session restores the
Agency module globals from its checkpoint. Make sure the restore does
not replace the value computed at this startup with an empty one from
an older checkpoint, or say in the known limits that it does.

### 2. `/preset save` will ask for approval under the `recommended` policy, and the plan expects that it will not

Task 5, Step 2 expects "No approval prompt appears." The write goes to
`settings.json` through `writeSettingsFile`, which raises `std::write`.
The `recommended` policy approves the read of `settings.json`
(`settingsReadRule`, `lib/runtime/builtinPolicies.ts:103-105`) but has
no rule for writing it. So the CLI handler asks, for the same reason as
in finding 1.

The plan cites `saveSettings` as the model for `with approve`. Its own
comment says the same thing: "`recommended` leaves this write to the
prompt, because settings.json decides what the next agent start runs"
(`lib/settings.agency:215-218`).

The prompt is correct behavior, so nothing in the code needs to change.
The plan does:

- Task 5, Step 2.1: expect one `std::write` prompt for `settings.json`
  under `recommended`. Approve it and continue.
- Task 5, Step 4: the dev doc section on why the write uses
  `with approve` should say that under `recommended` the user still sees
  this prompt, and why.

### 3. A saved preset can load a different provider than the session runs

Decision 7 says the saved preset, loaded in a fresh session with no
flags, must resolve the same models. One common case breaks this.

Suppose the session has no `--provider` and no preset provider, so the
provider was detected from API keys, say `anthropic`. The user types
`/model claude-opus-4-8`. `switchModel` resolves that pin against the
session's current provider (`lib/repl.agency:186`, and the comment at
the top of `switchModel`), so the session runs `claude-opus-4-8` on
`anthropic`.

`sessionPreset` writes `provider` from `requestProvider(request, {})`,
which is `""` here (`lib/modelRequest.agency:255-260`). The saved preset
is `{ pin: "claude-opus-4-8" }`.

A fresh session loading it goes through `resolveHostedModels`.
`detectionInputs` reports the pin, so `resolveDetected` decides that
everything came from a model name and returns `"openai"`
(`lib/models.agency:191-193`). The pin has no provider prefix, so
`finalProvider` gives it the context provider (`lib/resolution.agency:28-40`).
By my reading, the fresh session runs `claude-opus-4-8` on `openai`.

The `/model` picker hands over keys like `openai/gpt-5.5`
(`switchWithAPickerKeyChangesProvider` in
`brains/coordinator/tests/agentTurn.agency`), so a picked model keeps
its provider. A typed bare name does not.

**Fix.** When `requestProvider(request, {})` is `""` and the flattened
layer names a chat model (a pin or a chat slot), save `provider` as the
session's resolved `main` provider, demoted with `demoteProvider`. That
provider came from key detection, not from `settings.model`, so
decision 9 does not exclude it. `sessionPreset` is pure, so pass the
provider in as a parameter. `saveSessionPreset` reads it from
`getResolvedSlots()`.

The test in finding 4 would catch this case.

## Should fix

### 4. Decision 7 is tested through the JSON shape only

Every `presetSnapshot` test compares the saved preset's JSON with an
expected value. None checks the property decision 7 states: the saved
preset resolves to the same session. Finding 3 passes every test in the
table.

Add a test that checks the property directly. For each request, resolve
two things with `resolveHostedModels` and the same settings:

- the session's request;
- `{ flags: noModelFlags(), preset: sessionPreset(...), choices: noModelChoices() }`.

Compare the `main`, `reasoning`, `embedding`, and `router` models and
providers, `requestEffort`, `requestLlmOptions`, and `effectiveLimits`.
Include a row with a detected provider and a typed bare pin, which is
the case in finding 3. This test can fail, and when it does it names
the field that differs.

### 5. One-shot runs get the default router too, and they print no header

Decision 2 applies the default whenever `OPENROUTER_API_KEY` is set.
Decision 4 says the header is how the user learns where their messages
go. A one-shot run (`agency agent -p ...`) resolves models the same way
and then skips the header (`agent.agency:199-207`).

Eval and benchmark scripts that run the agent one-shot with an
OpenRouter key in the environment (I did not check each script) would
start routing their turns through Jev. Results from before and after
the change would no longer be comparable, and nothing in the run's
output would say so.

The decisions do not cover this case. Ask the owner which they want:

- one-shot runs route by default too, and the PR description says so,
  so benchmark scripts can add `--model router=off`; or
- one-shot runs get no default, which is one check in the place that
  stores the default slots from finding 1.

### 6. The test commands do not match CI

The plan says to run agent tests "with `--check-capabilities`, as CI
does (`.github/workflows/test.yml:326`)". Line 326 runs `tests/agency`,
not the agent tests. CI runs the agent tests in the `agent-tests` job as
`pnpm run test:agents` with `AGENCY_USE_TEST_LLM_PROVIDER=1`
(`.github/workflows/test.yml:238-260`, `package.json:15`).

The missing variable matters here. Without it, a node in
`brains/coordinator/tests/agentTurn.agency` that runs a turn can call a
real model when a key is set in the shell. With the default router,
that turn also makes a real Jev call first.

Use this for every agent test run in the plan:

```bash
AGENCY_USE_TEST_LLM_PROVIDER=1 HOME="$(mktemp -d)" \
  pnpm run agency test lib/agents/agency-agent/tests/$t.agency \
  > /tmp/test-$t.out 2>&1
```

`--check-capabilities` is harmless to add, but CI does not run it on
these files.

## Smaller items

### 7. `localSessionGetsNoDefaultRouter` cannot fail

The node calls `configureLocalModel` directly. That function never
reaches `resolveRequestAgainst`, so the node passes whether or not the
default layer is wired correctly.

Test the path a real local start takes: `applyModelRequest` with
`flags.local` set to the MLX model the file already uses
(`mlx:mlx-community/Qwen3-4B-4bit`), and the default slots stored (or
the key set, if finding 1 is not taken). Then check that
`getRouterModel()` is `""`. That test fails if someone later sends the
local path through the default layer.

### 8. The header change in Task 2 is required

Task 2, Step 3 says to "check" whether `slotModelLabel` returns `""` for
an empty model. It does not. For model `""` and provider `""` it returns
`" ()"` (`lib/header.agency:19-28`). Without the change, a router turned
off with `off` would print a `Router      ()` line. State the change as
a step, and add a node for a router with an empty model and an empty
provider, which is what `off` produces.

### 9. The change lines compare against the presets read at startup

`saveSessionPreset` gets `before` from `findPreset`, which reads the
in-memory table loaded at startup (`lib/presets.agency:147-162`).
`editPresets` reads the file. If another agent session saved this
preset since this one started, the printed lines describe the wrong
change, and "Nothing to save" can skip a write that was needed.

`editOutcome` already reads the previous entry from the file
(`lib/presets.agency:307-314`). Have it return that entry, and compute
the change lines and the "Nothing to save" check from it. If that is
more than this PR should carry, add it to the known limits in the dev
doc.

### 10. The skill index file

The `rg` command in Task 5 finds nothing in the skills. The file is
`packages/agency-lang/.claude/skills/agency-agent-docs/SKILL.md`, lines
16 and 17. Its `agent-presets.md` line is also already behind the one
in `CLAUDE.md`: it is missing the clause about reasoning effort. Bring
both lines into step when you edit them.

### 11. Imports in `lib/resolution.agency`

`flattenLayers` calls `isChatSlot`. `lib/resolution.agency` imports
`canonicalSlot`, `providersFor`, `slotKind`, and `SLOTS` from
`slots.agency` (line 6). Add `isChatSlot` there.

## What I checked and found correct

- `flattenLayers` gives the same result as walking the layers. I traced
  it against `resolveSlot` (`lib/resolution.agency:44-88`) for all four
  rows in Task 3 and for derived slots under a pin. The rule that a
  layer's named slots are read before its pin matches the order in
  `resolveSlot`.
- `lacksProviderForm` is the one check behind the flag, `/model`,
  `settings.json`, and a preset (`lib/modelRequest.agency:99`,
  `lib/session.agency:281`, `lib/settings.agency:92`,
  `lib/presetRules.agency:136`). Exempting `off` there covers all four.
- `parseModelSpec("off", ...)` returns model `off` and provider `""`, so
  the check in Task 1, Step 5 matches what the layer holds.
- `via` for a named slot is `"${layer.name}:per-slot"`, so
  `default:per-slot` is the string `explicitRouterSpec` should compare
  against.
- `localModelOf` reads the router from the flags or the local preset
  and passes it to `configureLocalModel`, so Task 1, Step 7 covers both
  `--local x --model router=off` and a local preset with `router: "off"`.
- Moving `editPresets` makes no import cycle. `lib/settings.agency` and
  everything it imports leave `presets.agency` alone.
- `keepDefaultFlag` keeps `default: true` on a save
  (`lib/presets.agency:324-332`), and `checkPreset(..., false)` refuses
  a `default` field, so `sessionPreset` must not set one, as the plan
  says.
- `existed` comes from the file in `editOutcome`, as the plan says.
- The header label column is eleven characters in both existing lines,
  and `"Router     "` is eleven characters.
- `presetModelSettings` and `presetLlmOptions` drop the preset's model
  fields and options when a model flag was given, and `presetEffort`
  also drops the effort on a `/model` chat choice. The expected values
  in the `presetSnapshot` table follow these rules.
- The palette test file has no `/preset` text, so Task 4, Step 6 changes
  only `lib/commandPalette.agency:68`.
