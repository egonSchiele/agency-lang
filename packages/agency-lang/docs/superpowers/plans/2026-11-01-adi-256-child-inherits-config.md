# A child process inherits the parent's config (ADI-256) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A program started by `run` from `std::agency` uses the model, provider, API keys, base URLs, and the other runtime settings of the parent's `agency.json`, instead of the built-in defaults its sandbox compile baked in.

**Architecture:** The parent already sends a `configOverrides` message to every child it forks (`lib/runtime/ipc.ts`), and the child applies it through one runtime merge, `applyRuntimeConfigOverridesToContextArgs` (`lib/runtime/configOverrides.ts`). Two things are missing. The parent does not hold its own config at runtime, so it has nothing to send beyond the statelog sink and the provider modules. And the merge ignores every `client.*` field except `providerModules`. This plan bakes the inheritable part of the resolved config into every generated program as one object on the `RuntimeContext`, has `run` send it under the caller's explicit overrides, and teaches the merge the `client` fields. The three pieces reuse what exists: `mergeConfig` for the merge of two configs, `mergeLlmConfig` for the per-provider merge of smoltalk settings, and the model-to-provider rule the code generator already has, moved to one function both sides call.

**Tech Stack:** TypeScript (runtime, code generator), Agency (one end-to-end test), vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`, decision 25, and the Linear ticket ADI-256. Read `docs/dev/runtime/subprocess-ipc.md` and `docs/dev/runtime/config.md` before starting; the ticket asks for that too.

## Background: how config reaches a program today

Read this once. The tasks assume it.

A compiled program carries its config in its generated header. `generateImports` in `lib/backends/typescriptBuilder.ts` (around line 4557) builds the arguments of `new RuntimeContext({...})` from the `AgencyConfig` the compiler was given: `statelogConfig` from `log` and `observability`, `smoltalkDefaults` from `client` (through `buildSmoltalkDefaults`, around line 4472), and one argument each for `maxRestores`, `maxCallDepth`, `failurePropagation`, `budget`, `maxToolResultChars`, `maxToolSchemaChars`, `providerModules`, `traceConfig`, `memory`, `verbose`, and `logLevel`. Nothing keeps the config object itself.

`buildSmoltalkDefaults` turns `client` into the smoltalk config: `model` is `client.defaultModel || DEFAULT_MODEL`; `provider` is `client.defaultProvider`, or `DEFAULT_PROVIDER` when no model was configured, or nothing when a model was configured without a provider (so smoltalk picks the provider from the model name); `apiKey` and `baseUrl` are per-provider maps where a configured value is baked and the rest read an environment variable at module load.

A program compiled by `compile` from `std::agency` goes through `compileToProgram` in `lib/stdlib/agency.ts` with an almost empty config (only the sandbox type-checker settings). So every child's header bakes `gpt-5-mini` through `openai-responses`, whatever the parent's `agency.json` says. That is the bug in the ticket.

At runtime, the `RuntimeContext` constructor (`lib/runtime/state/context.ts`, line 319) applies two layers of overrides over the baked arguments, each a `Partial<AgencyConfig>`: the `AGENCY_CONFIG_OVERRIDES` environment variable (`readConfigOverrides`), then the IPC overrides a parent sent (`getRuntimeConfigOverrides`, set by `subprocess-bootstrap.ts` line 189 before the compiled module is imported). Both go through `applyRuntimeConfigOverridesToContextArgs`, which honors `log.*`, `observability`, `traceFile`, `traceDir`, `client.providerModules`, `maxCallDepth`, `failurePropagation`, and `budget`, and ignores the rest.

The parent builds what it sends in `_runFor` (`lib/runtime/ipc.ts`, line 1327): the caller's explicit overrides (today only `log.logFile` from `run(logFile:)`), then `withParentProviderModules` adds the parent's provider module paths made absolute, then `withParentStatelog` adds the parent's effective statelog sink. The same object rides the `run` and the `resume` instruction, so a resumed child gets it again.

## Global Constraints

- The repo rules in `CLAUDE.md` and `packages/agency-lang/CLAUDE.md`: no interfaces (use `type`), no maps or sets, no dynamic imports, never force push or amend, commit messages and PR bodies written to a file first.
- `pnpm run typecheck` after every TypeScript edit. Prettier on the files you touched only (`pnpm exec prettier --write <files>`), never `pnpm run fmt:ts`.
- `make` after editing anything under `stdlib/` or `lib/stdlib/`; this plan edits neither, but `make fixtures` is needed after the code-generator change in Task 2.
- Secrets never widen: a value that is not in generated code today must not appear in it after this change. `client.apiKey` values from `agency.json` are already baked by `buildSmoltalkDefaults`, so baking them again in the config object adds nothing new. `mcpServers`, with its `env` and `headers` secrets, is not baked today and must stay out.
- A child never gets a file path it would resolve against the wrong directory: `log.logFile` and `client.providerModules` are already made absolute by the two existing helpers, and this plan keeps those helpers as the owners of those fields.

## Review Focus

Five things the spec implies and no task's test exercises on its own. Each line names its test, added in the task that owns the code.

1. A grandchild inherits the root's model through a child that was itself compiled in the sandbox. The child's `RuntimeContext` must hold the merged config, not its baked one, or the relay stops at one level. Test: `grandchildUsesParentModel` in Task 4.
2. A parent that names a model but no provider must not hand the child a model with the child's baked provider `openai-responses`. The merge must clear the provider the way the code generator would. Test: "clears the baked provider when the override names a model alone" in Task 2.
3. The caller's explicit `run(logFile:)` must still win over anything inherited, and the parent's own `log.logFile` must never reach the child through the new path. Test: "keeps log out of the inherited config" in Task 1 and "an explicit override wins over an inherited field" in Task 3.
4. A bundled agent reads the same merge through `AGENCY_CONFIG_OVERRIDES`. A `client.defaultModel` in that variable was ignored before and is honored after. Test: "the env override sets the model too" in Task 2. Report in the PR body that this is a behavior change for the env transport.
5. The config object must survive `createExecutionContext`, which builds a context with `Object.create` and copies fields by hand. A served agent that calls `run` would otherwise send an empty config. Test: "createExecutionContext keeps the config" in Task 2.

---

## File structure

- Modify `lib/config/config.ts`: `INHERITED_CONFIG_KEYS`, `InheritedConfig`, `inheritedConfig()`, `defaultRoute()`.
- Modify `lib/config/config.test.ts`: the path-table test covers the new table; tests for `inheritedConfig` and `defaultRoute`.
- Modify `lib/backends/typescriptBuilder.ts`: `buildSmoltalkDefaults` calls `defaultRoute`; `generateImports` bakes `config`.
- Modify `lib/runtime/llmConfig.ts`: `inheritClientDefaults()`.
- Modify `lib/runtime/configOverrides.ts`: the merge honors `client.*` and `checkpoints.maxRestores`; `RuntimeContextConstructorArgs` gains `config`.
- Modify `lib/runtime/configOverrides.test.ts`: tests for the new fields.
- Modify `lib/runtime/state/context.ts`: the `config` field, set in the constructor and copied in `createExecutionContext`.
- Modify `lib/runtime/ipc.ts`: `withParentConfig()`; `_runFor` uses it.
- Modify `lib/runtime/ipc.test.ts`: tests for `withParentConfig`.
- Create `tests/agency/subprocess-config/agency.json`, `inherits.agency`, `inherits.test.json`.
- Modify `docs/dev/runtime/subprocess-ipc.md`, `docs/dev/runtime/config.md`, `CLAUDE.md`, `.claude/skills/agency-runtime-docs/SKILL.md`.
- Regenerate `tests/typescriptGenerator/*` with `make fixtures` (Task 2).

---

### Task 1: The inheritable config and the one route rule

**Files:**
- Modify: `lib/config/config.ts` (near `DEFAULT_MODEL`, line 1000, and `SECRET_CONFIG_PATHS`, line 1070)
- Modify: `lib/backends/typescriptBuilder.ts:4530-4536` (the `provider` computation in `buildSmoltalkDefaults`)
- Test: `lib/config/config.test.ts`

**Interfaces:**
- Produces:
  - `export const INHERITED_CONFIG_KEYS = ["client", "maxCallDepth", "failurePropagation", "checkpoints"] as const;`
  - `export type InheritedConfig = Pick<AgencyConfig, (typeof INHERITED_CONFIG_KEYS)[number]>;`
  - `export function inheritedConfig(config: Partial<AgencyConfig>): InheritedConfig` — a new object with only the listed keys, and only those present in `config`.
  - `export function defaultRoute(client: AgencyConfig["client"] | undefined, fallback: { model: string; provider?: string }): { model: string; provider?: string }` — the model and provider a `client` block selects. `model` is `client.defaultModel` or the fallback model. `provider` is `client.defaultProvider` when set; otherwise, when `client.defaultModel` is set, no provider (the key is absent, so smoltalk picks the provider from the model name); otherwise the fallback provider. This is the rule `buildSmoltalkDefaults` applies today with `DEFAULT_MODEL` and `DEFAULT_PROVIDER` as the fallback; the runtime merge in Task 2 applies it with the baked values as the fallback.

- [ ] **Step 1: Write the failing tests in `lib/config/config.test.ts`**

Add `INHERITED_CONFIG_KEYS`, `inheritedConfig`, and `defaultRoute` to the import from `./config.js`, extend the path-table test, and add two describes:

```ts
describe("config path tables", () => {
  const paths = [
    ...CONFIG_MERGE_RULES.map((rule) => rule.path),
    ...SECRET_CONFIG_PATHS,
    ...INHERITED_CONFIG_KEYS,
  ];
  // the existing it.each stays as it is
});

describe("inheritedConfig", () => {
  it("keeps only the inherited keys that are present", () => {
    expect(
      inheritedConfig({
        client: { defaultModel: "m" },
        maxCallDepth: 7,
        outDir: "dist",
        log: { logFile: "a.jsonl" },
        observability: true,
        mcpServers: { fs: { command: "x", env: { TOKEN: "secret" } } },
      }),
    ).toEqual({ client: { defaultModel: "m" }, maxCallDepth: 7 });
  });

  it("keeps log out of the inherited config", () => {
    expect(inheritedConfig({ log: { logFile: "a.jsonl" }, observability: true })).toEqual({});
  });
});

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
});
```

If the `mcpServers` literal does not satisfy `McpServers`, use any valid server shape from `lib/config/mcpServers.ts`; the point of that line is that the key is dropped.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run lib/config/config.test.ts > /tmp/adi256-t1.txt 2>&1; tail -30 /tmp/adi256-t1.txt`
Expected: FAIL, the three names are not exported.

- [ ] **Step 3: Add the table, the type, and the two functions to `lib/config/config.ts`**

Put them after `DEFAULT_PROVIDER`. Doc comments, in this spirit:

```ts
/** The keys of the resolved config a program keeps at runtime and a child
 *  started by `run` inherits. Compile-time keys (`outDir`, `typechecker`,
 *  ...) are useless to a running program. `log`, `observability`, and
 *  `trace*` stay out: the parent's effective statelog sink is forwarded by
 *  `withParentStatelog`, and a trace file belongs to one process.
 *  `mcpServers` stays out: it holds secrets that are not in generated code
 *  today. `budget` stays out: the parent's cap already counts a child's
 *  spend, and `run(maxCost:)` caps one child. */
export const INHERITED_CONFIG_KEYS = ["client", "maxCallDepth", "failurePropagation", "checkpoints"] as const;
```

`inheritedConfig` loops over `INHERITED_CONFIG_KEYS` and copies a key when `config[key] !== undefined`. `defaultRoute` is the rule in the Interfaces block; return an object without a `provider` key when there is none (`toEqual` in the tests is strict about an `undefined` value versus an absent key, and so is the JSON the code generator bakes).

- [ ] **Step 4: Make `buildSmoltalkDefaults` use `defaultRoute`**

In `lib/backends/typescriptBuilder.ts`, replace the `model` field at line 4524 and the `provider` block at lines 4530-4536 with one call: `const route = defaultRoute(cfg.client, { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER });`, then `model: ts.str(route.model)` in `smoltalkFields` and `if (route.provider) { smoltalkFields.provider = ts.str(route.provider); }`. Keep the comment that explains the rule, above the call. The generated output is byte-for-byte the same, so no fixture changes in this task.

- [ ] **Step 5: Run the tests, the typecheck, and the fixtures**

Run: `pnpm exec vitest run lib/config/config.test.ts > /tmp/adi256-t1.txt 2>&1; tail -5 /tmp/adi256-t1.txt`
Expected: PASS.

Run: `pnpm run typecheck`
Expected: clean.

Run: `pnpm exec vitest run tests/typescriptGenerator > /tmp/adi256-fix1.txt 2>&1; tail -5 /tmp/adi256-fix1.txt`
Expected: PASS with no fixture change; `git status --short tests/typescriptGenerator` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add lib/config/config.ts lib/config/config.test.ts lib/backends/typescriptBuilder.ts
git commit -F /tmp/adi256-c1.txt
```

Message: `config: the inheritable keys and the one model-to-provider rule`.

---

### Task 2: The program keeps its config, and the runtime merge learns `client`

**Files:**
- Modify: `lib/runtime/llmConfig.ts`
- Modify: `lib/runtime/configOverrides.ts` (`RuntimeContextConstructorArgs`, `applyRuntimeConfigOverridesToContextArgs`)
- Modify: `lib/runtime/state/context.ts` (field, constructor at line 319, `createExecutionContext` at line 484)
- Modify: `lib/backends/typescriptBuilder.ts:4557-4660` (`generateImports`)
- Test: `lib/runtime/configOverrides.test.ts`
- Regenerate: `tests/typescriptGenerator/*` (`make fixtures`)

**Interfaces:**
- Consumes: `InheritedConfig`, `inheritedConfig`, `defaultRoute` from Task 1; `mergeLlmConfig` and `mergeConfig` as they exist.
- Produces:
  - `export function inheritClientDefaults(baked: Partial<SmolConfig>, client: NonNullable<AgencyConfig["client"]>): Partial<SmolConfig>` in `lib/runtime/llmConfig.ts`.
  - `RuntimeContextConstructorArgs.config?: InheritedConfig` (the baked object).
  - `RuntimeContext.config: InheritedConfig` — the baked config with the env overrides and then the IPC overrides merged in, projected to the inherited keys. Task 3 sends it to a child.

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
});

it("keeps the merged config, env under IPC, projected to the inherited keys", () => {
  process.env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides({
    client: { defaultModel: "from-env" },
    maxCallDepth: 5,
    log: { logFile: "never.jsonl" },
  });
  setRuntimeConfigOverrides({ client: { defaultModel: "from-ipc" } });
  try {
    const ctx = new RuntimeContext({ ...bakedSandbox(), config: { failurePropagation: "warn" } });
    expect(ctx.config).toEqual({
      client: { defaultModel: "from-ipc" },
      maxCallDepth: 5,
      failurePropagation: "warn",
    });
  } finally {
    setRuntimeConfigOverrides(undefined);
  }
});

it("createExecutionContext keeps the config", async () => {
  const ctx = new RuntimeContext({ ...bakedSandbox(), config: { client: { defaultModel: "m" } } });
  const resolved = resolveInvocation({ node: "main" }); // use the real shape; see lib/runtime/invocationOptions.ts
  const execCtx = await ctx.createExecutionContext(resolved);
  expect(execCtx.config).toEqual({ client: { defaultModel: "m" } });
});
```

For the last test, build the `ResolvedInvocation` the way `lib/runtime/servedInvocationLifecycle.test.ts` or `lib/runtime/invocationOptions.test.ts` does; copy their smallest fixture rather than inventing one.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run lib/runtime/configOverrides.test.ts > /tmp/adi256-t2.txt 2>&1; tail -40 /tmp/adi256-t2.txt`
Expected: FAIL on every new test (`provider` still present, `config` undefined, and so on).

- [ ] **Step 3: Add `inheritClientDefaults` to `lib/runtime/llmConfig.ts`**

```ts
/** The smoltalk defaults a `client` config block gives over the baked ones:
 *  the keys and base URLs merged per provider, the log level and the
 *  OpenRouter preferences replaced whole, and the model with its provider
 *  by `defaultRoute`, with the baked model and provider as the fallback. */
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

Add `config?: InheritedConfig` to `RuntimeContextConstructorArgs` (import the type from `../config/config.js`). In `applyRuntimeConfigOverridesToContextArgs`, after the `budget` block:

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

`maxToolSchemaChars` is missing from `RuntimeContextConstructorArgs` today although the constructor accepts it; add it. Update the "Fields honored" list in the doc comment: add `client.defaultModel` and `defaultProvider` (by `defaultRoute`), `client.apiKey` and `baseUrl` (per provider), `client.logLevel`, `client.openRouter`, `client.maxToolResultChars`, `client.maxToolSchemaChars`, and `checkpoints.maxRestores`. Note there that `client.statelog`, `client.llamaCpp`, `client.modelAliases`, and `client.modelsDir` are not applied: the first two are baked only, and the last two are read from the file at runtime by the code that needs them.

- [ ] **Step 5: Keep the config on the `RuntimeContext`**

In `lib/runtime/state/context.ts`:

- Add the field, next to `providerModules`: `/** The inheritable part of the resolved config: baked, then the env overrides, then the IPC overrides. `run` sends it to a child. */ config: InheritedConfig;`
- Add `config?: InheritedConfig` to the constructor's argument type.
- In the constructor, read the two override sources once and use them for both the existing merge calls and the new field:

```ts
    const envOverrides = readConfigOverrides();
    const ipcOverrides = getRuntimeConfigOverrides();
    args = applyRuntimeConfigOverridesToContextArgs(args, envOverrides);
    args = applyRuntimeConfigOverridesToContextArgs(args, ipcOverrides);
    ...
    this.config = inheritedConfig(
      mergeConfig(mergeConfig(args.config ?? {}, envOverrides), ipcOverrides ?? {}),
    );
```

`mergeConfig` is in `lib/config/merge.ts`; it takes and returns `Record<string, any>`, so the result goes through `inheritedConfig`, which both narrows the type and drops anything outside the inherited keys.

- In `createExecutionContext`, add `execCtx.config = this.config;` beside `execCtx.providerModules = this.providerModules;`.
- In `toJSON`, add `config: "redacted"` beside `smoltalkDefaults: "redacted"`, since `client.apiKey` can be in it.

- [ ] **Step 6: Bake the config in `generateImports`**

In `lib/backends/typescriptBuilder.ts`, after `runtimeCtxArgs.providerModules` is set (around line 4645):

```ts
    // The inheritable config rides along whole, so `run` can hand it to a
    // child compiled without it. Only when it says something: a program
    // compiled with no agency.json keeps its header as it was.
    const inherited = inheritedConfig(cfg);
    if (Object.keys(inherited).length > 0) {
      runtimeCtxArgs.config = ts.raw(JSON.stringify(inherited));
    }
```

Use whatever `ts` helper the file already uses for a JSON literal; `ts.raw(JSON.stringify(...))` is what the `openRouter` field at line 4551 does.

- [ ] **Step 7: Run the tests, the typecheck, and the fixtures**

Run: `pnpm exec vitest run lib/runtime/configOverrides.test.ts lib/runtime/llmConfig.test.ts > /tmp/adi256-t2.txt 2>&1; tail -8 /tmp/adi256-t2.txt`
Expected: PASS. If `lib/runtime/llmConfig.test.ts` does not exist, drop it from the command; the behavior is covered through the merge tests.

Run: `pnpm run typecheck`
Expected: clean.

Run: `make fixtures > /tmp/adi256-fixtures.txt 2>&1; git status --short tests/typescriptGenerator | head`
Expected: either no change, or changes only in fixtures whose config sets one of the four inherited keys. If a fixture changed that sets none of them, something else leaked into `inheritedConfig`; stop and look. Commit the regenerated fixtures with the code.

Run: `pnpm exec vitest run lib/backends lib/runtime/ipc.test.ts lib/runtime/ipc.configOverrides.test.ts lib/cli/runBundledAgent.test.ts > /tmp/adi256-t2b.txt 2>&1; tail -8 /tmp/adi256-t2b.txt`
Expected: PASS. (`runBundledAgent.test.ts` may have another name; run the test that covers `resolveAgentLaunchArgs`.)

- [ ] **Step 8: Commit**

```bash
git add lib/runtime/llmConfig.ts lib/runtime/configOverrides.ts lib/runtime/configOverrides.test.ts lib/runtime/state/context.ts lib/backends/typescriptBuilder.ts tests/typescriptGenerator
git commit -F /tmp/adi256-c2.txt
```

Message: `runtime: a program keeps its inheritable config, and the override merge applies client settings`.

---

### Task 3: `run` sends the parent's config under the caller's overrides

**Files:**
- Modify: `lib/runtime/ipc.ts` (`_runFor` at line 1327; new helper beside `withParentProviderModules`, line 1443)
- Test: `lib/runtime/ipc.test.ts` (beside the `withParentStatelog` describe at line 33)

**Interfaces:**
- Consumes: `RuntimeContext.config` from Task 2; `mergeConfig`.
- Produces: `export function withParentConfig(overrides: Partial<AgencyConfig> | undefined, parentConfig: InheritedConfig): Partial<AgencyConfig> | undefined` — the parent's inheritable config with the caller's overrides merged over it, field by field. Returns `overrides` unchanged when the parent config is empty, so a program with nothing to pass on keeps sending exactly what it sends today.

- [ ] **Step 1: Write the failing tests in `lib/runtime/ipc.test.ts`**

```ts
describe("withParentConfig", () => {
  it("returns the overrides unchanged when the parent has nothing to pass on", () => {
    const overrides = { observability: true };
    expect(withParentConfig(overrides, {})).toBe(overrides);
    expect(withParentConfig(undefined, {})).toBeUndefined();
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

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run lib/runtime/ipc.test.ts > /tmp/adi256-t3.txt 2>&1; tail -20 /tmp/adi256-t3.txt`
Expected: FAIL, `withParentConfig` is not exported.

- [ ] **Step 3: Add `withParentConfig` and use it in `_runFor`**

The helper, beside `withParentProviderModules`:

```ts
/**
 * The parent's inheritable config, under the caller's explicit overrides.
 * This is how a child compiled in the sandbox (no agency.json) runs with
 * the parent's model, keys, and base URLs. Field by field, an explicit
 * override wins. `log` and `client.providerModules` are not in the
 * inheritable config: `withParentStatelog` and `withParentProviderModules`
 * forward those, with paths made absolute.
 */
export function withParentConfig(
  overrides: Partial<AgencyConfig> | undefined,
  parentConfig: InheritedConfig,
): Partial<AgencyConfig> | undefined {
  if (Object.keys(parentConfig).length === 0) return overrides;
  return mergeConfig(parentConfig, overrides ?? {}) as Partial<AgencyConfig>;
}
```

In `_runFor`, the chain becomes:

```ts
  const mergedConfigOverrides = withParentStatelog(
    withParentProviderModules(withParentConfig(configOverrides, ctx.config), ctx.providerModules),
    ctx.getStatelogSink(),
  );
```

Rewrite the comment above it: it currently explains only the provider modules. Say in a few sentences that the child's own compile baked the sandbox config, so the parent sends its inheritable config, its provider modules with absolute paths, and its effective statelog sink, and that an explicit `run(logFile:)` wins.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm exec vitest run lib/runtime/ipc.test.ts lib/runtime/ipc.configOverrides.test.ts > /tmp/adi256-t3.txt 2>&1; tail -8 /tmp/adi256-t3.txt`
Expected: PASS.

Run: `pnpm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/ipc.test.ts
git commit -F /tmp/adi256-c3.txt
```

Message: `std::agency run: the child inherits the parent's config`.

---

### Task 4: The end-to-end test

**Files:**
- Create: `tests/agency/subprocess-config/agency.json`
- Create: `tests/agency/subprocess-config/inherits.agency`
- Create: `tests/agency/subprocess-config/inherits.test.json`

**Why its own folder:** the test runner merges the `agency.json` beside a test file over the project config (`mergeFixtureConfig` in `lib/cli/test.ts:928`), so an `agency.json` in `tests/agency/subprocess/` would change every subprocess test. `tests/agency/memory/agency.json` is the precedent for a folder with its own config.

**How the test observes the model:** the child's `llm()` is answered by the test provider (the `AGENCY_LLM_MOCKS` variable is inherited by the child, and each process builds its own mock client from the full list). Before the request is sent, `promptStart` in `lib/runtime/promptEvents.ts:67` logs the model the call resolved to, which comes from the merged smoltalk config, not from the mock's answer. So the child's statelog file, written through `run(logFile:)`, contains the model name the child used. The parent reads that file back.

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
  in the sandbox, so this passes only if the child keeps the config it was
  handed and passes it on. The grandchild's source is a plain string inside
  the child's triple-quoted source: a triple-quoted string keeps `\"` as two
  characters, which the child's compiler then reads as an escaped quote. */
node grandchildUsesParentModel() {
  const grandchildLog = OUT + "/grandchild.jsonl"
  const source = """
import { compile, run } from "std::agency"

node main(): string {
  const compiled = compile("node main(): string { return llm(\"Say hi.\") }")
  if (compiled is failure(err)) {
    return "grandchild compile failed: ${err}"
  }
  const ran = run(compiled: compiled.value, node: "main", logFile: "${grandchildLog}")
  if (ran is failure(err)) {
    return "grandchild run failed: ${err}"
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

- `${grandchildLog}` and `${err}` inside the triple-quoted string: the outer program interpolates `${grandchildLog}` (wanted: the absolute path lands in the child's source). `${err}` must NOT be interpolated by the outer program; write it as `\${err}` in the outer source, which is the one escape a triple-quoted string honors (`docs/dev/language/triple-quoted-string-escapes.md`). The code block above shows the intent; apply the escape when you type it.
- `read` is the builtin from `std::index` (`read(filename, dir)`), not from `std::fs`. It raises `std::read`; the handler approves it, and the one outside the handler uses `with approve`. If `const x = ... with approve` does not parse, wrap that read in a `handle` block like `runLogged` does.
- The grandchild's `run` raises `std::run` inside the child. The child has no handler, so the interrupt goes up to the parent's handler in `runLogged`, which approves it. That is the distributed chain doing its job, not a problem.
- Before relying on the exact expected output, run `pnpm run ast tests/agency/subprocess-config/inherits.agency > /dev/null` to check the file parses, and `node dist/scripts/agency.js typecheck tests/agency/subprocess-config/inherits.agency` after `make`.

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

- [ ] **Step 4: Run the test, with the build fresh**

Run: `make > /tmp/adi256-make.txt 2>&1; tail -3 /tmp/adi256-make.txt`
Expected: a clean build. The stdlib did not change, but the runtime and the code generator did, and the test runs compiled code.

Run: `pnpm run agency test tests/agency/subprocess-config/inherits.test.json > /tmp/adi256-t4.txt 2>&1; tail -20 /tmp/adi256-t4.txt`
Expected: 2 passed.

To see the failure this test guards against, stash nothing; instead temporarily change the fixture's model to a name that is not in the log and watch the second element go `false`. Put it back.

Also run the subprocess tests that touch config forwarding, since `_runFor` changed:
`pnpm run agency test tests/agency/subprocess/run-log-file.test.json tests/agency/subprocess/run-cwd.test.json tests/agency/subprocess/nested-basic.test.json > /tmp/adi256-t4b.txt 2>&1; tail -8 /tmp/adi256-t4b.txt`
Expected: all pass. And the one js test with a provider module: `pnpm run agency test js tests/agency-js/provider-module > /tmp/adi256-t4c.txt 2>&1; tail -5 /tmp/adi256-t4c.txt`.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/subprocess-config
git commit -F /tmp/adi256-c4.txt
```

Message: `tests: a child and a grandchild use the parent's configured model`.

---

### Task 5: Docs and the PR

**Files:**
- Modify: `docs/dev/runtime/subprocess-ipc.md`
- Modify: `docs/dev/runtime/config.md`
- Modify: `CLAUDE.md:270` and `.claude/skills/agency-runtime-docs/SKILL.md:33` (the `subprocess-ipc.md` index line)

- [ ] **Step 1: `docs/dev/runtime/subprocess-ipc.md`**

Add a section `## What a child inherits` after "How compiled code gets executed in the subprocess". It says, in prose with the file names:

- A child's program is compiled in the sandbox with no `agency.json`, so its header bakes the built-in model and provider. The parent sends the inheritable part of its own resolved config in the `run` and `resume` instructions' `configOverrides`, under the caller's explicit overrides (`withParentConfig` in `lib/runtime/ipc.ts`), and the child applies it through the one runtime merge in the `RuntimeContext` constructor.
- What is inheritable is one table, `INHERITED_CONFIG_KEYS` in `lib/config/config.ts`: `client`, `maxCallDepth`, `failurePropagation`, `checkpoints`. Say why `log`, `trace*`, `mcpServers`, and `budget` are not in it (copy the reasons from the table's doc comment). Say that `client.statelog`, `client.llamaCpp`, `client.modelAliases`, and `client.modelsDir` ride along but the merge does not apply them, and why.
- `maxToolCallRounds` is not inherited: the code generator bakes it into each `llm()` call site, so a child uses `10` or whatever `setLlmOptions({ maxToolCallRounds })` sets in its own source.
- The model-to-provider rule is `defaultRoute`, shared by the code generator and the merge: a model named without a provider drops the provider so smoltalk picks it from the model name. A parent naming `gemini-3.8-flash` without a provider does not leave the child on `openai-responses`.
- Nesting is automatic: a child's `RuntimeContext.config` is the merged config, so a grandchild gets the root's settings through a child compiled in the sandbox (`grandchildUsesParentModel`).
- Not inherited by design: a client set from TypeScript with `setLLMClient` is an object in the parent's process and cannot be sent. (The ticket's wording.)
- Interrupts and checkpoints: nothing new is raised. The config is not part of a checkpoint; a resumed child gets it again from the `resume` instruction, like the other overrides.

Add the two new tests to the test table: `subprocess-config/inherits` with the two cases.

- [ ] **Step 2: `docs/dev/runtime/config.md`**

- In "Config resolution", after the sentence about source 3, add that a child started by `run` receives the parent's inheritable config as IPC overrides, and point at the new section of `subprocess-ipc.md`.
- In the `--refuse-splices` section, the sentence "and a subprocess re-derives its own config, so a flag has to be forwarded to it explicitly" is now half true: a subprocess inherits the keys in `INHERITED_CONFIG_KEYS` and nothing else, and `refuseSplices` is not one of them. Reword it to say that.
- In the per-invocation note, nothing changes: `resolveInvocation` still projects to its own allow-list, which never copies `client.*`, so served agents are unaffected. Add one sentence saying so in `docs/dev/hosting/per-invocation-config.md` under "The v1 config allow-list", since that doc states that `client.defaultModel` is inert in the merge, and it is now inert only because the projection drops it.

- [ ] **Step 3: The index lines**

In both `CLAUDE.md` and `.claude/skills/agency-stdlib-docs`'s sibling `.claude/skills/agency-runtime-docs/SKILL.md`, the `subprocess-ipc.md` line ends with "and how the parent's handler chain extends across that boundary." Append: ", and what config a child inherits from its parent". `.claude/skills/*/SKILL.md` is gitignored but tracked; stage it with `git add -f`.

- [ ] **Step 4: Prettier, typecheck, lint**

Run: `pnpm exec prettier --write lib/config/config.ts lib/config/config.test.ts lib/backends/typescriptBuilder.ts lib/runtime/llmConfig.ts lib/runtime/configOverrides.ts lib/runtime/configOverrides.test.ts lib/runtime/state/context.ts lib/runtime/ipc.ts lib/runtime/ipc.test.ts`
Run: `pnpm run typecheck && pnpm run lint:structure`
Expected: clean. Commit any prettier changes with the docs.

- [ ] **Step 5: Commit, push, PR**

```bash
git add docs/dev/runtime/subprocess-ipc.md docs/dev/runtime/config.md docs/dev/hosting/per-invocation-config.md CLAUDE.md
git add -f .claude/skills/agency-runtime-docs/SKILL.md
git commit -F /tmp/adi256-c5.txt
git push -u origin adit/workflows-part-6
```

Message: `docs: what a child process inherits from its parent`.

PR title: `std::agency: a child process inherits the parent's config (ADI-256)`. Body in a file, with: the problem in two sentences (the ticket's BMO example), the mechanism in one paragraph (baked inheritable config, sent under explicit overrides, applied by the one merge), the table of inherited keys and what is deliberately left out, the two behavior changes a reader should know (a model named without a provider now clears the provider in the child; `AGENCY_CONFIG_OVERRIDES` with `client.*` is now honored by bundled agents), the "Calls I made" list below, and the tests run. End with the attribution line from the repo's reminder.

---

## Calls I made

These are the places the ticket or the spec left open. Object to any of them.

1. **The parent sends an inheritable projection, not every key.** The ticket says "its whole resolved config". Baking the whole config would put `mcpServers` secrets into every generated program, and would hand a child the parent's `log.logFile`, `traceFile`, and `budget`, which belong to one process each. The projection is one table, `INHERITED_CONFIG_KEYS`, and the dev doc lists what is out and why. Everything in the ticket's examples (`client.defaultModel`, `client.baseUrl`, the rest of `client`) is in.
2. **`logLevel` and `verbose` are not inherited.** Both are debugging knobs, and `logLevel` always has a value, so including it would change every generated program's header and every fixture. If the owner wants them, add the two keys to the table and the two lines to the merge; nothing else changes.
3. **`maxToolCallRounds` is not inherited.** It is baked into each `llm()` call site, not the context. Honoring it would mean a context-level default that the call sites fall back to, a separate change.
4. **The merge applies `client` field by field, and shares only the model-to-provider rule with the code generator.** The generator emits environment-variable fallbacks as code, so one function cannot produce both the baked object and the runtime merge. `defaultRoute` is the one rule worth sharing, because getting it wrong leaves a child on the wrong provider.
5. **Explicit overrides win over inherited fields key by key** (`mergeConfig` semantics), so `run(logFile:)` keeps winning and a future explicit `run(model:)` would too.
6. **The nested case is covered by keeping the merged config on the context**, not by re-sending the root's message. A grandchild gets the root's config because the child's `config` is already merged.
7. **The `AGENCY_CONFIG_OVERRIDES` transport gains the same `client` support.** Both transports go through the one merge, and splitting them would mean two merges. The PR body names it as a behavior change.
8. **A `setLLMClient` client is not sent.** The ticket rules it out; the dev doc says so.

## Self-review

Spec coverage: decision 25 and the ticket's "What to do" are Tasks 1 to 3; the ticket's test is Task 4's first case, and its "read the two docs first" is the Background section. Step scan: each code step has a signature or a body where the signature does not determine it (`inheritClientDefaults`, the constructor lines); each test step has the assertions. Type consistency: `InheritedConfig` is used by the same name in Tasks 1, 2, and 3; `defaultRoute`'s fallback argument has the same shape in the generator and the merge. Review Focus: five lines, each pinned to a test. Proportion: the plan is longer than the code because the Background and the reasons for what is left out are the part a reader cannot derive.
