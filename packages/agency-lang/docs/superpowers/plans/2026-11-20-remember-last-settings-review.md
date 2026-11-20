# Review: Remember the Last Settings

This reviews `2026-11-20-remember-last-settings.md` against the code at `ae51d1586`, the worktree's HEAD. The plan's decisions (one concept, `-p` reads the file, no interrupt, the seed from an old `default` mark) are settled, and this review doesn't reopen them. It checks whether the tasks deliver those decisions.

## Summary

The plan is sound. The write sits in the right place: the terminal's `/model` and `/preset` both reach the core as answers (`lib/repl.agency:163` and `:185`), so one call per arm covers both front-ends. The security argument also holds. No coordinator tool sets `_choices` except through `useLlmOptions`, and the plan strips `llmOptions` both on write and on read.

Two findings are important. Startup doesn't check a remembered model the way it checks a flag (finding 1). A session started with a model flag remembers only part of what it ran (finding 2). Finding 3 is a gap in the upgrade path that the plan sets out to protect. The rest are small.

## Findings

### 1. Startup's provider detection doesn't see the remembered models (important)

`resolveHostedModels` (`shared.agency:466`) picks the provider from `detectionInputs(request)`. That function reads only the flags and the preset (`modelRequest.agency:267`). It never reads `request.choices`, because at startup the choices have always been empty. Task 4 puts the remembered choices there, so detection now ignores the one layer that names the model.

Detection is also where a provider's API key is checked (`resolveDetected`, `models.agency:192` and `:211`). `trySwitchModel` checks no key. So a remembered model whose key is missing passes the start, and the first turn of every new chat fails with an auth error. The "could not be used" fallback never fires.

Here is a realistic way to get there:

1. In the terminal, with `OPENROUTER_API_KEY` exported, the person runs `/model openrouter/moonshotai/kimi-k3`.
2. The file now holds `pin: "openrouter/moonshotai/kimi-k3"`.
3. Perry starts a new chat in its own environment, which has no OpenRouter key. Detection picks a provider from the keys Perry does have, and the pin resolves to OpenRouter anyway.
4. Every message fails until the person changes the model by hand.

A `--model openrouter/...` flag in the same environment would fail at the start, with a message naming the missing key. The remembered model should behave the same way.

**Fix:** make `detectionInputs` read the choices first: `request.choices.pin`, then `choices.slots.main` and `choices.slots.reasoning`, ahead of the flags. This changes nothing that runs today. `startModels` passes `noModelChoices()`, and `switchPreset` builds its request with `noModelChoices()`. With the fix, a missing key makes `startModels` fail, and Task 4's fallback shows the warning. Add a Task 4 check, `lastModelWithoutKeyFallsBack`: delete the key, write a file whose pin names that provider, and expect a running session with `preset == ""` and a warning that starts with `Your last settings could not be used:`. Name `detectionInputs` in Task 4's Files list and in `agent-presets.md`'s "How a run picks its models".

### 2. A session started with a model or effort flag remembers only part of what it ran (important; the owner decides)

`rememberSettings(activePresetName(), modelChoices())` captures `--preset`, because the active preset's name includes it. It does not capture `--model`, `--fastmodel`, `--slowmodel` or `--effort`. Those live in `_startupFlags`, not in `_choices`.

Task 3's own check shows it. The `chat` session in `test.js` starts with the flag `pin: "claude-sonnet-4-6"` (`startData`, line 148). After `effort: "low"`, `lastSettingsAfterEffort` expects this file:

```json
{ "preset": "", "choices": { "pin": "", "slots": {}, "effort": "low" } }
```

The session ran Sonnet at low effort. The next plain chat starts on the provider's default model at low effort, which is a mix the person never chose. The same happens the other way round: `agency agent --effort low`, then `/model opus`, remembers Opus without the low effort.

**Recommendation:** a session started with a model or effort flag (`hasModelFlags(startupFlags) || startupFlags.effort != null`) writes nothing. `--preset` alone still writes, since the file holds it correctly. This mirrors the read rule. A flag marks the run as a one-off, so the run doesn't read the usual settings, and it doesn't change them either. Perry passes no flags, so Perry isn't affected.

The other way is to fold the flags into what is written: pin and slots through `flattenLayers([in-session, cli])`, and the effort as `choices.effort ?? flags.effort`. `--provider` and `--local` can't be held in `ModelChoices`, so those sessions would still need to write nothing. That makes two rules instead of one.

Either way, Task 3's checks move to a session started with `noModelFlags`, and a new check, `flagSessionNotRemembered`, pins the rule.

### 3. Deleting `keepDefaultFlag` breaks the upgrade seed (moderate)

Task 5 deletes `keepDefaultFlag` (`presets.agency:340`). That function keeps `"default": true` when a save replaces the marked preset. Without it, both `/preset save` and the agent's `savePreset` tool drop the mark.

Neither of them writes `last-settings.json`, since a `savePreset` answer isn't a model, effort or preset answer. So a person who upgrades, opens a chat on their default `big`, and runs `/preset save` gets a next chat with no preset at all. Review Focus 5 exists to prevent exactly that.

The existing test `saveKeepsTheDefaultFlag` (`tests/presetSession.agency:283`) pins the current behavior and would fail. Task 5 doesn't say what to do with it.

**Fix:** keep `keepDefaultFlag` and `saveKeepsTheDefaultFlag` for as long as the mark seeds new chats. Delete the rest as planned: `setDefault`, `withDefaultFlag`, `wasDefault` and the reply texts. Then take `keepDefaultFlag` out of Step 3's grep.

### 4. The `isIncognito()` guard never fires in the session program (minor)

Only a test calls `startIncognito()` (`tests/incognito.agency:25`). The session program runs in its own run, and nothing there sets `_incognito`. The terminal starts an incognito session with `record: null` (`agent.agency:84` to `95`), so the `currentRecord() == null` check already stops it from writing.

**Fix:** drop `isIncognito()` from `rememberSettings` and from Task 2's Consumes list. Note in the doc comment that an incognito session has no record. Otherwise the plan claims a guard that doesn't exist, and someone will rely on it later.

### 5. Task 5 misses the tool's trace row (minor)

`lib/stdlib/agentToolTrace.ts:568` has a row for `setDefaultPreset`. The `toolPresentations` test fails on a missing row but not on a leftover one, so nothing would catch it. Task 5's grep searches only `lib/agents/agency-agent`.

**Fix:** add `agentToolTrace.ts` to Task 5's Files list, and run the Step 3 grep over `lib`, not `lib/agents/agency-agent`.

### 6. Task 4's fallback leaves three things unsaid (minor)

1. `startPresetQuiet` returns the table's warnings, such as a preset in `settings.json` that isn't valid. When the first attempt fails and the start runs again with `""`, the same warnings come back a second time. Return only the attempt that's kept, plus the fallback warning.
2. Say what happens when the fallback start fails too, for example when there are no API keys at all. It should be returned as a failure, so `main` throws, as it does today.
3. `startPresetAndModels` lives in `program.agency`, where only a full session start can test it. In `lib/lastSettings.agency`, beside the other start helpers, an `agency test` could call it the way `presetSession.agency` calls `switchPreset`. The js checks would stay as the end-to-end proof.

### 7. Two wording gaps in the plan (minor)

1. The Architecture section says "as if the person had typed `/preset`, `/model` and `/effort`". The terminal has no `/effort` command, so an effort answer only comes from Perry. Say "as if the person had chosen them again".
2. `/local` changes the models but not `ModelChoices`, so it isn't remembered. That's reasonable, since `/preset save` already refuses to copy it (`movedByLocalCommand`). Add a line to the Decisions section so an implementer doesn't add a fourth arm.

### 8. The `docs/site` edits may be against a standing rule (check with the owner)

Task 6 edits `docs/site/agent/models.md` and `docs/site/cli/agent.md`. The owner's standing rule is that a feature PR doesn't touch `docs/site/**` unless asked. The owner writes the user-facing narrative. If the 2026-11-20 conversation asked for these pages, keep them. Otherwise, drop them from Task 6 and name the stale pages in the PR description. The `agent-presets.md` changes are dev docs and stay either way.

### 9. Perry's onboarding pin needs the fixed-provider rule (minor, follow-up PR)

The Perry section has onboarding write `pin: "<provider>/<model>"`. When `settings.json` fixes a provider (`model.provider`), the core reads a spec whole, so `anthropic/claude-opus-4-8` becomes a model by that literal name. Perry already handles this when it writes a preset (`agentShape` in `src/engine/defaultPreset.ts`). Under a fixed provider, Perry writes the bare model. Say that the last-settings write follows the same rule, rather than "whichever the core resolves the same way".

## What the plan gets right

- **The write is at the cause.** One call in each of the core's three answer arms covers the terminal and Perry, with no front-end code.
- **The read is defensive in the right place.** The TS reader rebuilds the object from known fields only, so a hand-edited `llmOptions` or `budget` never reaches the run. Task 1's `extra keys dropped` check pins that.
- **The tests are independent of each other.** Task 3 Step 1 removes the file at every `startSession` unless the check asks to keep it. Without that, every later section of `test.js` would start from whatever the `chat` section chose.
- **The upgrade path writes nothing at start.** That keeps the mark working until the person's first real change, and `changeReplacesSeed` checks that the file wins afterwards.
