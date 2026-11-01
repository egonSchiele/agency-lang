# A child process inherits the parent's config (ADI-256) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A program started by `run` from `std::agency` uses the model, provider, API keys, base URLs, and the other runtime settings of the parent's `agency.json`, instead of the built-in defaults its sandbox compile baked in.

**Architecture:** The parent already sends a `configOverrides` message to every child it forks (`lib/runtime/ipc.ts`), and the child applies it through one runtime merge, `applyRuntimeConfigOverridesToContextArgs` (`lib/runtime/configOverrides.ts`). Two things are missing. The merge ignores every `client.*` field except `providerModules`, and the parent sends nothing beyond the statelog sink and the provider modules. This plan teaches the merge the `client` fields, and has `run` build the child's overrides from the fields the parent's `RuntimeContext` already holds: its smoltalk defaults, its tool caps, and its limits. Those fields are the parent's baked config with the environment and IPC overrides merged in, so a grandchild inherits the root's settings with no extra code. The model-to-provider rule the code generator already has moves into one function both sides call. Nothing is added to generated code.

**Tech Stack:** TypeScript (runtime), Agency (one end-to-end test file), vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`, decision 25, and the Linear ticket ADI-256. Read `docs/dev/runtime/subprocess-ipc.md` and `docs/dev/runtime/config.md` before starting; the ticket asks for that too. The owner's review of the first draft of this plan is beside it, `2026-11-01-adi-256-child-inherits-config-REVIEW.md`; its section 3 is the design this draft follows.

## Background: how config reaches a program today

Read this once. The tasks assume it.

A compiled program carries its config in its generated header. `generateImports` in `lib/backends/typescriptBuilder.ts` (around line 4557) builds the arguments of `new RuntimeContext({...})` from the `AgencyConfig` the compiler was given: `statelogConfig` from `log` and `observability`, `smoltalkDefaults` from `client` (through `buildSmoltalkDefaults`, around line 4472), and one argument each for `maxRestores`, `maxCallDepth`, `failurePropagation`, `budget`, `maxToolResultChars`, `maxToolSchemaChars`, `providerModules`, `traceConfig`, `memory`, `verbose`, and `logLevel`. Nothing keeps the config object itself; the context's fields are the config.

`buildSmoltalkDefaults` turns `client` into the smoltalk config: `model` is `client.defaultModel || DEFAULT_MODEL`; `provider` is `client.defaultProvider`, or `DEFAULT_PROVIDER` when no model was configured, or nothing when a model was configured without a provider (so smoltalk picks the provider from the model name); `apiKey` and `baseUrl` are per-provider maps where a configured value is baked and the rest read an environment variable at module load.

A program compiled by `compile` from `std::agency` goes through `compileToProgram` in `lib/stdlib/agency.ts` with an almost empty config (only the sandbox type-checker settings). So every child's header bakes `gpt-5-mini` through `openai-responses`, whatever the parent's `agency.json` says. That is the bug in the ticket.

At runtime, the `RuntimeContext` constructor (`lib/runtime/state/context.ts`, line 319) applies two layers of overrides over the baked arguments, each a `Partial<AgencyConfig>`: the `AGENCY_CONFIG_OVERRIDES` environment variable (`readConfigOverrides`), then the IPC overrides a parent sent (`getRuntimeConfigOverrides`, set by `subprocess-bootstrap.ts` line 189 before the compiled module is imported). A third entry point, `withRuntimeConfigOverrides` in `configOverrides.ts`, lets a host that imports many modules set the same overrides per import; nothing in this repo calls it. All three go through `applyRuntimeConfigOverridesToContextArgs`, which honors `log.*`, `observability`, `traceFile`, `traceDir`, `client.providerModules`, `maxCallDepth`, `failurePropagation`, and `budget`, and ignores the rest.

A served agent gets one more layer. `createExecutionContext` (`context.ts`, line 484) builds a context per invocation with `Object.create` and copies fields by hand, and the invocation's own override can tighten `maxCallDepth` and `failurePropagation` (the allow-list in `docs/dev/hosting/per-invocation-config.md`). So on a served context, `execCtx.maxCallDepth` is the invocation's value, not the baked one.

The parent builds what it sends in `_runFor` (`lib/runtime/ipc.ts`, line 1327): the caller's explicit overrides (today only `log.logFile` from `run(logFile:)`), then `withParentProviderModules` adds the parent's provider module paths made absolute, then `withParentStatelog` adds the parent's effective statelog sink. The overrides are rebuilt for the `run` and for every `resume` instruction (`resolveInstruction`, around line 1120), and they are not stored in the saved subprocess payload, so nothing in them reaches a checkpoint. The child gets the parent's whole environment (`buildForkOptions`, line 444), so API keys the parent read from environment variables already reach it.

## Global Constraints

- The repo rules in `CLAUDE.md` and `packages/agency-lang/CLAUDE.md`: no interfaces (use `type`), no maps or sets, no dynamic imports, never force push or amend, commit messages and PR bodies written to a file first.
- `pnpm run typecheck` after every TypeScript edit. Prettier on the files you touched only (`pnpm exec prettier --write <files>`), never `pnpm run fmt:ts`.
- `make` before running an Agency test, because the runtime changed and the test runs compiled code.
- Nothing new in generated code. This plan does not touch the code generator's output; the one change in `typescriptBuilder.ts` (Task 1) emits byte-for-byte the same text.
- A child never gets a file path it would resolve against the wrong directory: `log.logFile` and `client.providerModules` are owned by the two existing helpers, which make them absolute, and the new helper never sets either.

## Review Focus

Five things the spec implies and no task's test exercises on its own. Each line names its test, added in the task that owns the code.

1. A grandchild inherits the root's model through a child that was itself compiled in the sandbox. The child's context fields hold the merged values, so the relay is automatic, but only a test proves it. Test: `grandchildUsesParentModel` in Task 3.
2. A parent that names a model but no provider must not hand the child a model with the child's baked provider `openai-responses`. The parent's `smoltalkDefaults` then has no `provider`, the helper sends `defaultModel` alone, and the merge must clear the provider the way the code generator would. Tests: "clears the baked provider when the override names a model alone" in Task 2, and "sends the model alone when the parent has no provider" in Task 4.
3. The caller's explicit `run(logFile:)` must still win, and the parent's own `log` must never reach the child through the new helper. Tests: "an explicit override wins over an inherited field" and "never sets log or providerModules" in Task 4.
4. A served invocation that tightens `maxCallDepth` must pass the tightened value to a child it starts, not the baked one. `maxCallDepth` is a safety ceiling. Test: "a served context passes its invocation's limits on" in Task 4.
5. The other two entry points of the merge, `AGENCY_CONFIG_OVERRIDES` and `withRuntimeConfigOverrides`, gain the same `client` support, since all three share the merge. No CLI path puts `client.*` into the variable today (`applyCliFlags` sets trace and log fields; `spawnRunner.ts` sets `observability` and `log`), so this changes behavior only for someone who sets it by hand. Test: "the env override sets the model too" in Task 2. The PR body names all three entry points.

---

## File structure

- Modify `lib/config/config.ts`: `defaultRoute()`.
- Modify `lib/config/config.test.ts`: tests for `defaultRoute`.
- Modify `lib/backends/typescriptBuilder.ts`: `buildSmoltalkDefaults` calls `defaultRoute`.
- Modify `lib/runtime/llmConfig.ts`: `inheritClientDefaults()`.
- Modify `lib/runtime/configOverrides.ts`: the merge honors `client.*` and `checkpoints.maxRestores`.
- Modify `lib/runtime/configOverrides.test.ts`: tests for the new fields.
- Modify `lib/runtime/ipc.ts`: `parentConfigOverrides()`, `withParentConfig()`; `_runFor` uses them.
- Modify `lib/runtime/ipc.test.ts`: tests for both helpers.
- Create `tests/agency/subprocess-config/agency.json`, `inherits.agency`, `inherits.test.json`.
- Modify `docs/dev/runtime/subprocess-ipc.md`, `docs/dev/runtime/config.md`, `docs/dev/hosting/per-invocation-config.md`, `CLAUDE.md`, `.claude/skills/agency-runtime-docs/SKILL.md`.

The tasks run in this order: the shared rule, the merge, the end-to-end test (written now so it can fail for the right reason), the forwarding that makes it pass, the docs.

---

### Task 1: The one model-to-provider rule

**Files:**
- Modify: `lib/config/config.ts` (after `DEFAULT_PROVIDER`, line 1001)
- Modify: `lib/backends/typescriptBuilder.ts:4524` and `4530-4536` (the `model` field and the `provider` block in `buildSmoltalkDefaults`)
- Test: `lib/config/config.test.ts`

**Interfaces:**
- Produces: `export function defaultRoute(client: AgencyConfig["client"] | undefined, fallback: { model: string; provider?: string }): { model: string; provider?: string }` — the model and provider a `client` block selects. `model` is `client.defaultModel` or the fallback model. `provider` is `client.defaultProvider` when set; otherwise, when `client.defaultModel` is set, no provider (the key is absent, so smoltalk picks the provider from the model name); otherwise the fallback provider. This is the compile-time rule `buildSmoltalkDefaults` applies today with `DEFAULT_MODEL` and `DEFAULT_PROVIDER` as the fallback. The runtime merge in Task 2 applies it with the baked values as the fallback, so a child behaves as if it had been compiled with the parent's `agency.json`. It is not the per-call rule `modelProviderOverride` in `lib/runtime/llmConfig.ts`, which keeps a default's provider for an `llm(model:)` call unless the call switches between a text model and a decision model. The doc comment must say which rule this is, so a later reader does not merge the two.

- [ ] **Step 1: Write the failing tests in `lib/config/config.test.ts`**

Add `defaultRoute` to the import from `./config.js` and a describe:

```ts
describe("defaultRoute", () => {
  const fallback = { model: "fallback-model", provider: "fallback-provider" };

  it("uses the fallback when the client names nothing", () => {
    expect(defaultRoute(undefined, fallback)).toEqual(fallback);
    expect(defaultRoute({}, fallback)).toEqual(fallback);
  });

  it("drops the provider when the client names a model alone", () => {
    expect(defaultRoute({ defaultModel: "m" }, fallback)).toEqual({ model: "m" });
  });

  it("keeps a configured provider", () => {
    expect(defaultRoute({ defaultModel: "m", defaultProvider: "p" }, fallback)).toEqual({
      model: "m",
      provider: "p",
    });
    expect(defaultRoute({ defaultProvider: "p" }, fallback)).toEqual({
      model: "fallback-model",
      provider: "p",
    });
  });

  it("keeps a fallback with no provider as it is", () => {
    expect(defaultRoute(undefined, { model: "m" })).toEqual({ model: "m" });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run lib/config/config.test.ts > /tmp/adi256-t1.txt 2>&1; tail -30 /tmp/adi256-t1.txt`
Expected: FAIL, `defaultRoute` is not exported.

- [ ] **Step 3: Add `defaultRoute` to `lib/config/config.ts`**

Return an object without a `provider` key when there is none; `toEqual` tells an `undefined` value from an absent key, and so does the JSON that rides the IPC message.

- [ ] **Step 4: Make `buildSmoltalkDefaults` use `defaultRoute`**

In `lib/backends/typescriptBuilder.ts`, replace the `model` field at line 4524 and the `provider` block at lines 4530-4536 with one call: `const route = defaultRoute(cfg.client, { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER });`, then `model: ts.str(route.model)` in `smoltalkFields` and `if (route.provider) { smoltalkFields.provider = ts.str(route.provider); }`. Keep the comment that explains the rule, above the call. The generated output is byte-for-byte the same.

- [ ] **Step 5: Run the tests, the typecheck, and the fixtures**

Run: `pnpm exec vitest run lib/config/config.test.ts > /tmp/adi256-t1.txt 2>&1; tail -5 /tmp/adi256-t1.txt`
Expected: PASS.

Run: `pnpm run typecheck`
Expected: clean.

Run: `pnpm exec vitest run tests/typescriptGenerator > /tmp/adi256-fix1.txt 2>&1; tail -5 /tmp/adi256-fix1.txt`
Expected: PASS, and `git status --short tests/typescriptGenerator` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add lib/config/config.ts lib/config/config.test.ts lib/backends/typescriptBuilder.ts
git commit -F /tmp/adi256-c1.txt
```

Message: `config: one model-to-provider rule for the code generator and the runtime`.

---

### Task 2: The runtime merge learns `client`

**Files:**
- Modify: `lib/runtime/llmConfig.ts`
- Modify: `lib/runtime/configOverrides.ts` (`RuntimeContextConstructorArgs`, `applyRuntimeConfigOverridesToContextArgs`)
- Test: `lib/runtime/configOverrides.test.ts`

**Interfaces:**
- Consumes: `defaultRoute` from Task 1; `mergeLlmConfig` as it exists.
- Produces: `export function inheritClientDefaults(baked: Partial<SmolConfig>, client: NonNullable<AgencyConfig["client"]>): Partial<SmolConfig>` in `lib/runtime/llmConfig.ts`, and the merge applying `client.defaultModel`, `defaultProvider`, `apiKey`, `baseUrl`, `logLevel`, `openRouter`, `maxToolResultChars`, `maxToolSchemaChars`, and `checkpoints.maxRestores`.

- [ ] **Step 1: Write the failing tests in `lib/runtime/configOverrides.test.ts`**

Add to the existing describe of `applyRuntimeConfigOverridesToContextArgs`:

```ts
const bakedSandbox = () => ({
  statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
  smoltalkDefaults: {
    model: "gpt-5-mini",
    provider: "openai-responses",
    apiKey: { openAi: "env-openai", anthropic: "" },
    baseUrl: { liteLlm: "", openAiCompat: "" },
    logLevel: "warn",
  },
  dirname: "/project",
});

it("clears the baked provider when the override names a model alone", () => {
  const result = applyRuntimeConfigOverridesToContextArgs(bakedSandbox(), {
    client: { defaultModel: "gemini-3.8-flash" },
  });
  expect(result.smoltalkDefaults.model).toBe("gemini-3.8-flash");
  expect("provider" in result.smoltalkDefaults).toBe(false);
});

it("sets the model and the provider together", () => {
  const result = applyRuntimeConfigOverridesToContextArgs(bakedSandbox(), {
    client: { defaultModel: "gemini-3.8-flash", defaultProvider: "google" },
  });
  expect(result.smoltalkDefaults).toMatchObject({ model: "gemini-3.8-flash", provider: "google" });
});

it("merges keys and base URLs per provider, keeping the baked rest", () => {
  const result = applyRuntimeConfigOverridesToContextArgs(bakedSandbox(), {
    client: { apiKey: { anthropic: "sk-a" }, baseUrl: { openAiCompat: "http://local/v1" } },
  });
  expect(result.smoltalkDefaults.apiKey).toEqual({ openAi: "env-openai", anthropic: "sk-a" });
  expect(result.smoltalkDefaults.baseUrl).toEqual({ liteLlm: "", openAiCompat: "http://local/v1" });
  expect(result.smoltalkDefaults).toMatchObject({ model: "gpt-5-mini", provider: "openai-responses" });
});

it("inherits logLevel, openRouter, the tool caps, and maxRestores", () => {
  const result = applyRuntimeConfigOverridesToContextArgs(bakedSandbox(), {
    client: {
      logLevel: "debug",
      openRouter: { provider: { order: ["anthropic"] } },
      maxToolResultChars: 500,
      maxToolSchemaChars: 0,
    },
    checkpoints: { maxRestores: 3 },
  });
  expect(result.smoltalkDefaults.logLevel).toBe("debug");
  expect(result.smoltalkDefaults.openRouter).toEqual({ provider: { order: ["anthropic"] } });
  expect(result.maxToolResultChars).toBe(500);
  expect(result.maxToolSchemaChars).toBe(0);
  expect(result.maxRestores).toBe(3);
});

it("leaves smoltalkDefaults alone when the override has no client", () => {
  const baked = bakedSandbox();
  const result = applyRuntimeConfigOverridesToContextArgs(baked, { maxCallDepth: 9 });
  expect(result.smoltalkDefaults).toEqual(baked.smoltalkDefaults);
});
```

Add to the describe that constructs a `RuntimeContext` under the env variable (the one around line 152, which already sets `CONFIG_OVERRIDES_ENV` and restores it in `afterEach`):

```ts
it("the env override sets the model too", () => {
  process.env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides({
    client: { defaultModel: "gemini-3.8-flash" },
  });
  const ctx = new RuntimeContext({ ...bakedSandbox() });
  expect(ctx.smoltalkDefaults.model).toBe("gemini-3.8-flash");
  expect("provider" in ctx.smoltalkDefaults).toBe(false);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run lib/runtime/configOverrides.test.ts > /tmp/adi256-t2.txt 2>&1; tail -40 /tmp/adi256-t2.txt`
Expected: FAIL on every new test (`provider` still present, caps not set, and so on).

- [ ] **Step 3: Add `inheritClientDefaults` to `lib/runtime/llmConfig.ts`**

```ts
/** The smoltalk defaults a `client` config block gives over the baked ones:
 *  the keys and base URLs merged per provider, the log level and the
 *  OpenRouter preferences replaced whole, and the model with its provider
 *  by `defaultRoute`, the compile-time rule, with the baked model and
 *  provider as the fallback. */
export function inheritClientDefaults(
  baked: Partial<SmolConfig>,
  client: NonNullable<AgencyConfig["client"]>,
): Partial<SmolConfig> {
  const override: Partial<SmolConfig> = {};
  if (client.apiKey !== undefined) {
    override.apiKey = { ...baked.apiKey, ...client.apiKey };
  }
  if (client.baseUrl !== undefined) {
    override.baseUrl = client.baseUrl;
  }
  if (client.logLevel !== undefined) {
    override.logLevel = client.logLevel;
  }
  if (client.openRouter !== undefined) {
    override.openRouter = client.openRouter;
  }
  const merged = mergeLlmConfig(baked, override);
  if (client.defaultModel === undefined && client.defaultProvider === undefined) {
    return merged;
  }
  const route = defaultRoute(client, { model: baked.model ?? DEFAULT_MODEL, provider: baked.provider });
  merged.model = route.model;
  if (route.provider === undefined) {
    delete merged.provider;
  } else {
    merged.provider = route.provider;
  }
  return merged;
}
```

`mergeLlmConfig` already merges `baseUrl` per provider (line 57), which is why `baseUrl` is passed through and `apiKey` is merged here. The `apiKey` and `baseUrl` types on `AgencyConfig["client"]` and `SmolConfig` may not line up exactly; cast at the assignment with a one-line comment if the typecheck objects, do not widen the function's types.

- [ ] **Step 4: Extend the merge in `lib/runtime/configOverrides.ts`**

In `applyRuntimeConfigOverridesToContextArgs`, after the `budget` block:

```ts
  const client = overrides.client;
  if (client !== undefined) {
    merged.smoltalkDefaults = inheritClientDefaults(args.smoltalkDefaults, client);
    if (client.maxToolResultChars !== undefined) {
      merged.maxToolResultChars = client.maxToolResultChars;
    }
    if (client.maxToolSchemaChars !== undefined) {
      merged.maxToolSchemaChars = client.maxToolSchemaChars;
    }
  }
  if (overrides.checkpoints?.maxRestores !== undefined) {
    merged.maxRestores = overrides.checkpoints.maxRestores;
  }
```

`maxToolSchemaChars` is missing from `RuntimeContextConstructorArgs` today although the constructor accepts it; add it. Update the "Fields honored" list in the doc comment with the nine new fields, and say there that `client.providerModules` keeps its own line above, and that `client.statelog`, `client.llamaCpp`, `client.modelAliases`, `client.modelsDir`, and the other `client` paths are not applied: the first two are baked only, and the rest are read from the config file at runtime by the code that needs them. Also say that the three entry points (env variable, IPC, `withRuntimeConfigOverrides`) all gain the `client` fields, since they share this function.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm exec vitest run lib/runtime/configOverrides.test.ts > /tmp/adi256-t2.txt 2>&1; tail -8 /tmp/adi256-t2.txt`
Expected: PASS.

Run: `pnpm run typecheck`
Expected: clean.

Run: `pnpm exec vitest run lib/runtime/ipc.test.ts lib/runtime/ipc.configOverrides.test.ts lib/cli/runBundledAgent.test.ts > /tmp/adi256-t2b.txt 2>&1; tail -8 /tmp/adi256-t2b.txt`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/llmConfig.ts lib/runtime/configOverrides.ts lib/runtime/configOverrides.test.ts
git commit -F /tmp/adi256-c2.txt
```

Message: `runtime: the config override merge applies the client settings`.

---

### Task 3: The end-to-end test, written to fail first

**Files:**
- Create: `tests/agency/subprocess-config/agency.json`
- Create: `tests/agency/subprocess-config/inherits.agency`
- Create: `tests/agency/subprocess-config/inherits.test.json`

**Why its own folder:** the test runner merges the `agency.json` beside a test file over the project config (`mergeFixtureConfig` in `lib/cli/commands.ts:139`, called from `lib/cli/test.ts:928`), one level deep, so the folder's `client` block replaces the package's `client` block whole, including the package's `defaultProvider`. An `agency.json` in `tests/agency/subprocess/` would change every subprocess test. `tests/agency/memory/agency.json` is the precedent for a folder with its own config.

**How the test observes the model:** the child's `llm()` is answered by the test provider (the `AGENCY_LLM_MOCKS` variable is inherited by the child, and each process builds its own mock client from the full list). Before the request is sent, `promptStart` in `lib/runtime/promptEvents.ts:67` logs the model the call resolved to, which comes from the merged smoltalk config, not from the mock's answer. So the child's statelog file, written through `run(logFile:)`, contains the model name the child used. The parent reads that file back.

**Why this task comes before the forwarding:** with Task 2 done and Task 4 not, the child still runs on its baked `gpt-5-mini`. Running the test now shows the bug the plan fixes, and shows that `gpt-5-mini` reaches the log only through `promptStart`: if some other event named the baked model, the third element could not be `false` after Task 4 either.

- [ ] **Step 1: Write the fixture config**

`tests/agency/subprocess-config/agency.json`:

```json
{
  "client": {
    "defaultModel": "gpt-4o-mini"
  }
}
```

No provider on purpose: that is the case where the child's baked `openai-responses` must be cleared (Review Focus 2). `gpt-4o-mini` is a name the unit tests already use.

- [ ] **Step 2: Write the test program**

`tests/agency/subprocess-config/inherits.agency`:

```
// A child compiled by `compile` bakes the built-in default model. The
// agency.json beside this file names gpt-4o-mini, and the child must use
// it. The child logs the model it resolved before each request, so the
// parent reads the child's log file to see it. The mock answers the one
// model call; no node here calls a model itself.
import { compile, run } from "std::agency"
import { mkdir, remove } from "std::fs"

const OUT = __dirname + "/test-output"

/** Runs `source`'s main in a child that logs to `logName`, approving every
  prompt, and returns [the child's result, the log text]. */
def runLogged(source: string, logName: string): Result<any[]> {
  const compiled = compile(source)
  if (compiled is failure(err)) {
    return failure("compile failed: ${err}")
  }
  const logFile = OUT + "/" + logName
  handle {
    mkdir(OUT)
    remove(logFile)
    const ran = run(compiled: compiled.value, node: "main", logFile: logFile)
    if (ran is failure(err)) {
      return failure("run failed: ${err}")
    }
    const log = read(logName, OUT)
    if (log is failure(err)) {
      return failure("read failed: ${err}")
    }
    return success([ran.value.data, log.value])
  } with (intr) {
    return approve()
  }
}

node childUsesParentModel() {
  const source = """
node main(): string {
  return llm("Say hi.")
}
"""
  const got = runLogged(source, "child.jsonl")
  if (got is failure(err)) {
    return "${err}"
  }
  const log = got.value[1]
  return [got.value[0], log =~ re/gpt-4o-mini/, log =~ re/gpt-5-mini/]
}

/** The child compiles and runs a grandchild. The child was itself compiled
  in the sandbox, so this passes only if the child's own context holds the
  values it was handed and passes them on. The grandchild's source is a
  plain string inside the child's triple-quoted source: a triple-quoted
  string keeps `\"` as two characters, which the child's compiler then
  reads as an escaped quote. */
node grandchildUsesParentModel() {
  const grandchildLog = OUT + "/grandchild.jsonl"
  const source = """
import { compile, run } from "std::agency"

node main(): string {
  const compiled = compile("node main(): string { return llm(\"Say hi.\") }")
  if (compiled is failure(err)) {
    return "grandchild compile failed: \${err}"
  }
  const ran = run(compiled: compiled.value, node: "main", logFile: "${grandchildLog}")
  if (ran is failure(err)) {
    return "grandchild run failed: \${err}"
  }
  return ran.value.data
}
"""
  remove(grandchildLog) with approve
  const got = runLogged(source, "child-of-grandchild.jsonl")
  if (got is failure(err)) {
    return "${err}"
  }
  const log = read("grandchild.jsonl", OUT) with approve
  if (log is failure(err)) {
    return "read failed: ${err}"
  }
  return [got.value[0], log.value =~ re/gpt-4o-mini/, log.value =~ re/gpt-5-mini/]
}
```

Notes for the implementer:

- The outer program interpolates `${grandchildLog}` into the child's source, which is wanted: the absolute path lands in the child's code. The two `\${err}` are escaped so the outer program leaves them for the child; that is the one escape a triple-quoted string honors (`docs/dev/language/triple-quoted-string-escapes.md`). Type them exactly as shown.
- `read` is the builtin from `std::index` (`read(filename, dir)`), not from `std::fs`. It raises `std::read`; the handler approves it, and the one outside the handler uses `with approve`. This program, exactly as shown, was parsed and typechecked on the built CLI while writing this plan; the only output is the AG3009 warning that `runLogged` may raise interrupts, which the handler inside it answers.
- The grandchild's `run` raises `std::run` inside the child. The child has no handler, so the interrupt goes up to the parent's handler in `runLogged`, which approves it. That is the distributed chain doing its job.
- If you change the program, run `pnpm run ast tests/agency/subprocess-config/inherits.agency > /dev/null` to check it still parses, and `node dist/scripts/agency.js typecheck tests/agency/subprocess-config/inherits.agency` after `make`.

- [ ] **Step 3: Write the test file**

`tests/agency/subprocess-config/inherits.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "childUsesParentModel",
      "description": "a child started by run uses the model the parent's agency.json names, not the sandbox default",
      "input": "",
      "expectedOutput": "[\"hi\",true,false]",
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "hi" }],
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "grandchildUsesParentModel",
      "description": "a grandchild inherits the root's model through a child compiled in the sandbox",
      "input": "",
      "expectedOutput": "[\"hi\",true,false]",
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "hi" }],
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 4: Run the test and see it fail for the right reason**

Run: `make > /tmp/adi256-make.txt 2>&1; tail -3 /tmp/adi256-make.txt`
Expected: a clean build.

Run: `pnpm run agency test tests/agency/subprocess-config/inherits.test.json > /tmp/adi256-t3.txt 2>&1; tail -30 /tmp/adi256-t3.txt`
Expected: both cases FAIL with the actual output `["hi",false,true]`: the child answered, its log does not name `gpt-4o-mini`, and it does name `gpt-5-mini`. If the actual output is anything else, stop and find out why before going on; in particular a `true` third element after Task 4 would mean some event other than `promptStart` names the baked model, and the test needs a narrower pattern.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/subprocess-config
git commit -F /tmp/adi256-c3.txt
```

Message: `tests: a child and a grandchild should use the parent's configured model`.

---

### Task 4: `run` sends the parent's settings under the caller's overrides

**Files:**
- Modify: `lib/runtime/ipc.ts` (`_runFor` at line 1327; two new helpers beside `withParentProviderModules`, line 1443)
- Test: `lib/runtime/ipc.test.ts` (beside the `withParentStatelog` describe at line 33)

**Interfaces:**
- Consumes: the context fields `smoltalkDefaults`, `maxToolResultChars`, `maxToolSchemaChars`, `maxCallDepth`, `failurePropagation`, `maxRestores`, all of which the constructor sets and `createExecutionContext` copies (with the invocation's override applied to the two limits); `mergeConfig` from `lib/config/merge.ts`.
- Produces:
  - `export type ParentSettings = Pick<RuntimeContext, "smoltalkDefaults" | "maxToolResultChars" | "maxToolSchemaChars" | "maxCallDepth" | "failurePropagation" | "maxRestores">` — what the helper reads. If importing the `RuntimeContext` type into `ipc.ts` makes a cycle the structural linter refuses, spell the six fields out as a `type` instead.
  - `export function parentConfigOverrides(parent: ParentSettings): Partial<AgencyConfig>` — the parent's settings as the config a child should be started with. `client.defaultModel` from `smoltalkDefaults.model`; `client.defaultProvider` from `smoltalkDefaults.provider` only when it is defined, so a parent that named a model with no provider sends the model alone; `client.apiKey`, `baseUrl`, `logLevel`, `openRouter` from the fields of the same name when defined; `client.maxToolResultChars` and `maxToolSchemaChars` when defined; `maxCallDepth` and `failurePropagation` always; `checkpoints.maxRestores` always. Never `log`, `observability`, `trace*`, `budget`, `memory`, or `client.providerModules`.
  - `export function withParentConfig(overrides: Partial<AgencyConfig> | undefined, parentConfig: Partial<AgencyConfig>): Partial<AgencyConfig>` — `mergeConfig(parentConfig, overrides ?? {})`, so an explicit override wins key by key.

- [ ] **Step 1: Write the failing tests in `lib/runtime/ipc.test.ts`**

```ts
const parentSettings = (): ParentSettings => ({
  smoltalkDefaults: {
    model: "gemini-3.8-flash",
    provider: "google",
    apiKey: { google: "k" },
    baseUrl: { openAiCompat: "http://local/v1" },
    logLevel: "error",
  },
  maxToolResultChars: 500,
  maxToolSchemaChars: 0,
  maxCallDepth: 64,
  failurePropagation: "warn",
  maxRestores: 7,
});

describe("parentConfigOverrides", () => {
  it("turns the parent's settings into the config a child starts with", () => {
    expect(parentConfigOverrides(parentSettings())).toEqual({
      client: {
        defaultModel: "gemini-3.8-flash",
        defaultProvider: "google",
        apiKey: { google: "k" },
        baseUrl: { openAiCompat: "http://local/v1" },
        logLevel: "error",
        maxToolResultChars: 500,
        maxToolSchemaChars: 0,
      },
      maxCallDepth: 64,
      failurePropagation: "warn",
      checkpoints: { maxRestores: 7 },
    });
  });

  it("sends the model alone when the parent has no provider", () => {
    const parent = parentSettings();
    delete parent.smoltalkDefaults.provider;
    const client = parentConfigOverrides(parent).client ?? {};
    expect(client.defaultModel).toBe("gemini-3.8-flash");
    expect("defaultProvider" in client).toBe(false);
  });

  it("never sets log or providerModules", () => {
    const sent = parentConfigOverrides(parentSettings());
    expect(sent.log).toBeUndefined();
    expect(sent.observability).toBeUndefined();
    expect(sent.client?.providerModules).toBeUndefined();
  });

  it("a served context passes its invocation's limits on", async () => {
    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: { model: "gpt-5-mini" },
      dirname: "/project",
      maxCallDepth: 2048,
    });
    const execCtx = await ctx.createExecutionContext(resolvedInvocationWith({ maxCallDepth: 5 }));
    expect(parentConfigOverrides(execCtx).maxCallDepth).toBe(5);
  });
});

describe("withParentConfig", () => {
  it("is the overrides alone when the parent sends nothing", () => {
    expect(withParentConfig({ observability: true }, {})).toEqual({ observability: true });
    expect(withParentConfig(undefined, {})).toEqual({});
  });

  it("fills in the parent's config under the overrides", () => {
    expect(
      withParentConfig(
        { observability: true, log: { logFile: "/tmp/child.jsonl" } },
        { client: { defaultModel: "m", defaultProvider: "p" }, maxCallDepth: 7 },
      ),
    ).toEqual({
      observability: true,
      log: { logFile: "/tmp/child.jsonl" },
      client: { defaultModel: "m", defaultProvider: "p" },
      maxCallDepth: 7,
    });
  });

  it("an explicit override wins over an inherited field, key by key", () => {
    expect(
      withParentConfig(
        { client: { defaultModel: "mine" } },
        { client: { defaultModel: "theirs", apiKey: { anthropic: "k" } } },
      ),
    ).toEqual({ client: { defaultModel: "mine", apiKey: { anthropic: "k" } } });
  });
});
```

For `resolvedInvocationWith`, build the `ResolvedInvocation` the way the existing tests of `createExecutionContext` do (look in `lib/runtime/servedInvocationLifecycle.test.ts`, `lib/runtime/invocationOptions.test.ts`, or `lib/runtime/state/context.test.ts` for the smallest fixture with a `contextOverride`); copy that rather than inventing one.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run lib/runtime/ipc.test.ts > /tmp/adi256-t4.txt 2>&1; tail -20 /tmp/adi256-t4.txt`
Expected: FAIL, the two helpers are not exported.

- [ ] **Step 3: Add the helpers and use them in `_runFor`**

Beside `withParentProviderModules`:

```ts
/**
 * The parent's settings as the config a child should start with. A child
 * compiled in the sandbox baked the built-in model and provider, so it is
 * handed the parent's smoltalk defaults, tool caps, and limits. These are
 * the parent context's own fields, which already hold the baked config with
 * the environment, IPC, and per-invocation overrides merged in, so a
 * grandchild gets the root's values through a child compiled the same way.
 * A parent that named a model with no provider has no `provider` here, and
 * the child's merge then clears its own. `log`, `trace*`, `budget`,
 * `memory`, and `client.providerModules` are not sent: the parent's
 * effective statelog sink and its provider modules are forwarded by
 * `withParentStatelog` and `withParentProviderModules`, a trace file
 * belongs to one process, the parent's budget already counts a child's
 * spend, and a memory store is one process's.
 */
export function parentConfigOverrides(parent: ParentSettings): Partial<AgencyConfig> {
  const defaults = parent.smoltalkDefaults;
  const client: NonNullable<AgencyConfig["client"]> = {};
  if (defaults.model !== undefined) {
    client.defaultModel = defaults.model;
  }
  if (defaults.provider !== undefined) {
    client.defaultProvider = defaults.provider;
  }
  if (defaults.apiKey !== undefined) {
    client.apiKey = defaults.apiKey;
  }
  if (defaults.baseUrl !== undefined) {
    client.baseUrl = defaults.baseUrl;
  }
  if (defaults.logLevel !== undefined) {
    client.logLevel = defaults.logLevel;
  }
  if (defaults.openRouter !== undefined) {
    client.openRouter = defaults.openRouter;
  }
  if (parent.maxToolResultChars !== undefined) {
    client.maxToolResultChars = parent.maxToolResultChars;
  }
  if (parent.maxToolSchemaChars !== undefined) {
    client.maxToolSchemaChars = parent.maxToolSchemaChars;
  }
  return {
    client,
    maxCallDepth: parent.maxCallDepth,
    failurePropagation: parent.failurePropagation,
    checkpoints: { maxRestores: parent.maxRestores },
  };
}

/** The parent's config under the caller's explicit overrides, key by key. */
export function withParentConfig(
  overrides: Partial<AgencyConfig> | undefined,
  parentConfig: Partial<AgencyConfig>,
): Partial<AgencyConfig> {
  return mergeConfig(parentConfig, overrides ?? {}) as Partial<AgencyConfig>;
}
```

The `apiKey`, `baseUrl`, and `logLevel` types on `SmolConfig` and on `AgencyConfig["client"]` may not line up exactly; cast at the assignment with a one-line comment if the typecheck objects. Do not loosen `ParentSettings`.

In `_runFor`, the chain becomes:

```ts
  const inherited = withParentConfig(configOverrides, parentConfigOverrides(ctx));
  const withModules = withParentProviderModules(inherited, ctx.providerModules);
  const mergedConfigOverrides = withParentStatelog(withModules, ctx.getStatelogSink());
```

Rewrite the comment above it: it currently explains only the provider modules. Say that the child's own compile baked the sandbox config, so the parent sends its settings, its provider modules with absolute paths, and its effective statelog sink, and that an explicit `run(logFile:)` wins.

- [ ] **Step 4: Run the unit tests and the typecheck**

Run: `pnpm exec vitest run lib/runtime/ipc.test.ts lib/runtime/ipc.configOverrides.test.ts > /tmp/adi256-t4.txt 2>&1; tail -8 /tmp/adi256-t4.txt`
Expected: PASS. If an existing test asserts the exact overrides `_runFor` sends, it now sees a `client` block too; update its expectation.

Run: `pnpm run typecheck`
Expected: clean.

- [ ] **Step 5: Run the end-to-end test and see it pass**

Run: `make > /tmp/adi256-make.txt 2>&1; tail -3 /tmp/adi256-make.txt`
Expected: a clean build.

Run: `pnpm run agency test tests/agency/subprocess-config/inherits.test.json > /tmp/adi256-t4e.txt 2>&1; tail -20 /tmp/adi256-t4e.txt`
Expected: 2 passed, output `["hi",true,false]` for both.

Also run the subprocess tests that touch config forwarding, since `_runFor` changed:
`pnpm run agency test tests/agency/subprocess/run-log-file.test.json tests/agency/subprocess/run-cwd.test.json tests/agency/subprocess/nested-basic.test.json > /tmp/adi256-t4b.txt 2>&1; tail -8 /tmp/adi256-t4b.txt`
Expected: all pass. And the one js test with a provider module: `pnpm run agency test js tests/agency-js/provider-module > /tmp/adi256-t4c.txt 2>&1; tail -5 /tmp/adi256-t4c.txt`.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/ipc.test.ts
git commit -F /tmp/adi256-c4.txt
```

Message: `std::agency run: the child inherits the parent's settings`.

---

### Task 5: Docs and the PR

**Files:**
- Modify: `docs/dev/runtime/subprocess-ipc.md`
- Modify: `docs/dev/runtime/config.md`
- Modify: `docs/dev/hosting/per-invocation-config.md`
- Modify: `CLAUDE.md:270` and `.claude/skills/agency-runtime-docs/SKILL.md:33` (the `subprocess-ipc.md` index line)

- [ ] **Step 1: `docs/dev/runtime/subprocess-ipc.md`**

Add a section `## What a child inherits` after "How compiled code gets executed in the subprocess". It says, in prose with the file names:

- A child's program is compiled in the sandbox with no `agency.json`, so its header bakes the built-in model and provider. The parent sends its own settings in the `run` and `resume` instructions' `configOverrides`, under the caller's explicit overrides (`parentConfigOverrides` and `withParentConfig` in `lib/runtime/ipc.ts`), and the child applies them through the one runtime merge in the `RuntimeContext` constructor.
- Where the settings come from: the parent context's own fields, not a copy of its `agency.json`. Those fields are the baked config with the environment, IPC, and per-invocation overrides merged in. So a grandchild gets the root's values through a child compiled in the sandbox (`grandchildUsesParentModel`), and a served invocation that tightened `maxCallDepth` passes the tightened value on.
- What is sent: the smoltalk defaults (model, provider, keys, base URLs, log level, OpenRouter preferences), the two tool caps, `maxCallDepth`, `failurePropagation`, and `checkpoints.maxRestores`. What is not, and why: `log` and `client.providerModules` have their own helpers; a trace file belongs to one process; the parent's `budget` already counts a child's spend, and `run(maxCost:)` caps one child; a memory store is one process's; `maxToolCallRounds` is baked into each `llm()` call site by the code generator, so a child uses `10` or whatever `setLlmOptions({ maxToolCallRounds })` sets in its own source; the top-level `logLevel` and `verbose` are debugging knobs for one process. Say plainly that `client.logLevel`, the smoltalk one, is sent, and the top-level `logLevel`, the one for the runtime's own loggers, is not.
- The IPC message carries the keys the parent read from its environment as well as the configured ones. The child already has that environment, so it learns nothing new; the message is not logged and is not part of any checkpoint.
- The model-to-provider rule is `defaultRoute` in `lib/config/config.ts`, the compile-time rule, shared by the code generator and the merge: a model named without a provider drops the provider so smoltalk picks it from the model name. A parent naming `gemini-3.8-flash` without a provider does not leave the child on `openai-responses`. It is not the per-call rule `modelProviderOverride`.
- Not inherited by design: a client set from TypeScript with `setLLMClient` is an object in the parent's process and cannot be sent.
- Interrupts and checkpoints: nothing new is raised. The overrides are rebuilt for every `run` and `resume` instruction and never stored, so a resumed child gets them again from the instruction.

Add the two new tests to the test table: `subprocess-config/inherits` with the two cases.

- [ ] **Step 2: `docs/dev/runtime/config.md`**

- In "Config resolution", after the sentence about source 3, add that a child started by `run` receives the parent's settings as IPC overrides, and point at the new section of `subprocess-ipc.md`. Name the three entry points of the runtime merge: the env variable, the IPC message, and `withRuntimeConfigOverrides` for a host that imports modules itself.
- In the `--refuse-splices` section, the sentence "and a subprocess re-derives its own config, so a flag has to be forwarded to it explicitly" is now half true: a subprocess inherits the settings listed in the new section and nothing else, and `refuseSplices` is not one of them. Reword it to say that.

- [ ] **Step 3: `docs/dev/hosting/per-invocation-config.md`**

Under "The v1 config allow-list", the doc says every `client.*` field is inert in the per-invocation channel because the projection never copies it. That is still true, and it is now the only reason: the merge itself applies `client.*`. Add one sentence saying so, and one saying that a served invocation's `maxCallDepth` and `failurePropagation` are passed on to any child the invocation starts with `run`.

- [ ] **Step 4: The index lines**

In both `CLAUDE.md` and `.claude/skills/agency-runtime-docs/SKILL.md`, the `subprocess-ipc.md` line ends with "and how the parent's handler chain extends across that boundary." Append: ", and what settings a child inherits from its parent". `.claude/skills/*/SKILL.md` is gitignored but tracked; stage it with `git add -f`.

- [ ] **Step 5: Prettier, typecheck, lint**

Run: `pnpm exec prettier --write lib/config/config.ts lib/config/config.test.ts lib/backends/typescriptBuilder.ts lib/runtime/llmConfig.ts lib/runtime/configOverrides.ts lib/runtime/configOverrides.test.ts lib/runtime/ipc.ts lib/runtime/ipc.test.ts`
Run: `pnpm run typecheck && pnpm run lint:structure`
Expected: clean. Commit any prettier changes with the docs.

- [ ] **Step 6: Commit, push, PR**

```bash
git add docs/dev/runtime/subprocess-ipc.md docs/dev/runtime/config.md docs/dev/hosting/per-invocation-config.md CLAUDE.md
git add -f .claude/skills/agency-runtime-docs/SKILL.md
git commit -F /tmp/adi256-c5.txt
git push -u origin adit/workflows-part-6
```

Message: `docs: what a child process inherits from its parent`.

PR title: `std::agency: a child process inherits the parent's config (ADI-256)`. Body in a file, with: the problem in two sentences (the ticket's BMO example), the mechanism in one paragraph (the parent's own context fields, sent under explicit overrides, applied by the one merge; nothing new in generated code), the list of what is sent and what is deliberately left out, the two behavior changes a reader should know (a model named without a provider now clears the provider in the child; the three entry points of the merge, the env variable, the IPC message, and `withRuntimeConfigOverrides`, now honor `client.*`), the "Calls I made" list below, and the tests run. End with the attribution line from the repo's reminder.

---

## Calls I made

These are the places the ticket or the spec left open. Object to any of them.

1. **The parent sends its settings from its own context fields, not a copy of its `agency.json`.** The ticket says "its whole resolved config". The context's fields are that config after every override, and they are the only values the parent itself runs on, so sending them cannot disagree with what the parent does. Baking a second copy into generated code would have put `client.statelog.apiKey` into every compiled file, changed every module's code fingerprint, and let a served invocation's tightened limits diverge from what its child got. The owner's review of the first draft recommended this; the first draft's baked copy is gone.
2. **What is sent is what the merge applies, and no more.** The smoltalk defaults, the two tool caps, `maxCallDepth`, `failurePropagation`, and `checkpoints.maxRestores`. The dev doc lists each thing left out with its reason. Everything in the ticket's examples (`client.defaultModel`, `client.baseUrl`, the rest of the `client` block the merge can act on) is in.
3. **Two log levels, two answers.** `client.logLevel`, smoltalk's, is sent, because it is part of the smoltalk defaults. The top-level `logLevel`, for the runtime's own loggers, is not, and neither is `verbose`; both are debugging knobs for one process.
4. **`maxToolCallRounds` is not inherited.** It is baked into each `llm()` call site, not the context. Honoring it would mean a context-level default that the call sites fall back to, a separate change.
5. **The merge applies `client` field by field, and shares only the model-to-provider rule with the code generator.** The generator emits environment-variable fallbacks as code, so one function cannot produce both the baked object and the runtime merge. `defaultRoute` is the one rule worth sharing, because getting it wrong leaves a child on the wrong provider. The doc comment says it is the compile-time rule, distinct from the per-call `modelProviderOverride`.
6. **Explicit overrides win over inherited fields key by key** (`mergeConfig` semantics), so `run(logFile:)` keeps winning and a future explicit `run(model:)` would too.
7. **Every `run` now sends a `client` block**, because the parent always has smoltalk defaults. A child compiled in the sandbox has the same built-in defaults when the parent has nothing configured, so nothing observable changes in that case.
8. **All three entry points of the merge gain the `client` support.** They share one function, and splitting them would mean two merges. The PR body names the three.
9. **A `setLLMClient` client is not sent.** The ticket rules it out; the dev doc says so.

## Self-review

Spec coverage: decision 25 and the ticket's "What to do" are Tasks 2 and 4; the ticket's test is Task 3's first case, and "read the two docs first" is the Background section. The owner's review: findings 1 and 2 are removed by the design in its section 3, which this draft follows; notes 4 to 8 are applied (three entry points named; `defaultRoute` named as the compile-time rule; the end-to-end test is written before the forwarding so it fails for the right reason; both log levels named; the test file that does not exist is gone). Step scan: each code step has a signature or a body where the signature does not determine it; each test step has the assertions. Type consistency: `ParentSettings` and `parentConfigOverrides` are used by the same names in Tasks 4 and 5; `defaultRoute`'s fallback argument has the same shape in the generator and the merge. Review Focus: five lines, each pinned to a test. Proportion: the plan is longer than the code because the Background and the reasons for what is left out are the part a reader cannot derive.
