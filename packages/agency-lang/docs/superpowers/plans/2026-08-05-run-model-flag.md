# `agency run --model` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--model` flag to `agency run` and the bare `agency <file>` shorthand that sets the default model for that run, accepting either a bare model name or `provider/model`.

**Architecture:** A pure resolver turns the flag's text into `{ model, explicitProvider? }`, validating a bare name against the hosted **text** model catalog. Commander runs the resolver as its option parser, so the CLI action receives an already-resolved value, and `applyCliFlags` — the one place that defines what a flag means in configuration terms — maps it onto `client.defaultModel` and `client.defaultProvider`. Everything downstream is existing machinery.

**Tech Stack:** TypeScript, Commander 14, vitest, smoltalk.

**Spec:** `docs/superpowers/specs/2026-08-05-run-model-flag-design.md` (revision 3). Read it before starting — especially "Model and provider are two separate settings", which is the reason this design is shaped the way it is.

## Global Constraints

- **Do not edit `CHANGELOG.md`.** The owner maintains it.
- **Do not edit anything under `docs/site/**`.** User-facing documentation is out of scope for this change. `docs/dev/**` is in scope and Task 7 updates it.
- Never commit to `main`. Work happens on the branch this worktree is on (`adit/run-model-flag`).
- Never force-push or amend commits.
- Write commit messages to a file and pass it with `git commit -F <file>` — apostrophes and backticks break inline `-m`.
- Stage named paths, never `git add -A`. This worktree may hold other work.
- Save every test run's output to a file so a failure does not need a re-run to diagnose. This repo's tests are slow.
- Do not run the whole test suite. Run only the tests named in each task; CI runs the rest.
- Run `make` only where a task says to. It is slow, and only the two tasks that need a rebuilt CLI ask for it.
- Types, not interfaces. Objects, not Maps. Arrays, not Sets. No dynamic imports.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/levenshtein.ts` | **Create.** Edit distance between two strings. Moved out of `builtinGraders.ts` so both callers share one copy. |
| `lib/levenshtein.test.ts` | **Create.** Tests for the above. |
| `lib/eval/grading/graders/builtinGraders.ts` | **Modify.** Delete its private `levenshtein` and import the shared one. |
| `lib/config.ts` | **Modify.** Declare `ResolvedModelFlag`, add `model?: ResolvedModelFlag` to `CliFlags`, and map it in `applyCliFlags`. |
| `lib/config.modelFlag.test.ts` | **Create.** Tests for the `applyCliFlags` mapping. |
| `lib/cli/modelFlag.ts` | **Create.** `resolveModelFlag` — parse `provider/model`, validate structure, validate a bare name against the text catalog, build the error message. |
| `lib/cli/modelFlag.test.ts` | **Create.** Tests for the resolver. |
| `scripts/agency.ts` | **Modify.** Add the option to `addRunOptions`, behind a one-line adapter. |
| `scripts/agency.modelFlag.test.ts` | **Create.** Commander wiring test — proves a repeated `--model` takes the last value. |
| `lib/backends/smoltalkDefaults.codegen.test.ts` | **Modify.** Add cases proving the configuration reaches the generated client block. |
| `lib/runtime/modelPrecedence.test.ts` | **Create.** Proves a stated provider survives a later model-only override. |
| `tests/integration/cli/test.mjs` | **Modify.** End-to-end through the real binary, both commands, and the failure-before-compilation case. |
| `docs/dev/config.md` | **Modify.** Document what `--model` means in configuration terms, beside the other flags. |

Why the resolver and the configuration mapping are separate files: the resolver knows about catalogs, slashes and Commander errors; `applyCliFlags` knows about configuration shape. `lib/config.ts` imports nothing from `lib/cli/`, and this change must not be the first thing to do so — which is why `ResolvedModelFlag` is declared in `config.ts` and the CLI imports it with `import type`.

---

## Task 1: Share the edit-distance function

**Files:**
- Create: `packages/agency-lang/lib/levenshtein.ts`
- Create: `packages/agency-lang/lib/levenshtein.test.ts`
- Modify: `packages/agency-lang/lib/eval/grading/graders/builtinGraders.ts:104-118`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function levenshtein(a: string, b: string): number`

- [ ] **Step 1: Write the failing test**

Create `packages/agency-lang/lib/levenshtein.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { levenshtein } from "./levenshtein.js";

describe("levenshtein", () => {
  it("is zero for identical strings", () => {
    expect(levenshtein("gpt-4o-mini", "gpt-4o-mini")).toBe(0);
  });

  it("counts a single inserted character", () => {
    expect(levenshtein("gpt-4o-mini", "gpt-4o-minii")).toBe(1);
  });

  it("counts a substitution", () => {
    expect(levenshtein("cat", "cot")).toBe(1);
  });

  it("handles an empty string on either side", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });

  it("is symmetric", () => {
    expect(levenshtein("kitten", "sitting")).toBe(
      levenshtein("sitting", "kitten"),
    );
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/agency-lang
npx vitest run lib/levenshtein.test.ts > /tmp/agency-t1.log 2>&1; tail -20 /tmp/agency-t1.log
```

Expected: FAIL — cannot resolve `./levenshtein.js`.

- [ ] **Step 3: Create the shared module**

Create `packages/agency-lang/lib/levenshtein.ts` with the body moved verbatim from `builtinGraders.ts`:

```ts
/** Classic Levenshtein edit distance (deterministic, dependency-free). */
export function levenshtein(a: string, b: string): number {
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_unused, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[cols - 1];
}
```

- [ ] **Step 4: Delete the private copy and import the shared one**

In `packages/agency-lang/lib/eval/grading/graders/builtinGraders.ts`, delete the whole `function levenshtein(...) { ... }` block (including its doc comment, currently lines 104–118) and add to the imports at the top of the file:

```ts
import { levenshtein } from "@/levenshtein.js";
```

Leave every call site unchanged — the name and signature are identical.

- [ ] **Step 5: Run both test files**

```bash
cd packages/agency-lang
npx vitest run lib/levenshtein.test.ts lib/eval/grading/graders/ \
  > /tmp/agency-t1b.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t1b.log
```

Expected: all PASS. The grader tests exercise the moved function through the `levenshtein` grader, so they are the proof the move did not change behaviour.

- [ ] **Step 6: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
refactor: share the levenshtein helper

The --model flag needs edit distance for its "did you mean" suggestion.
Rather than a second copy, the existing implementation moves out of
builtinGraders.ts into lib/levenshtein.ts and both callers import it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/lib/levenshtein.ts \
  packages/agency-lang/lib/levenshtein.test.ts \
  packages/agency-lang/lib/eval/grading/graders/builtinGraders.ts
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 2: The configuration contract and mapping

**Files:**
- Modify: `packages/agency-lang/lib/config.ts` (type near `CliFlags` at line 681; mapping inside `applyCliFlags`, which ends with `return next;` at line 755)
- Create: `packages/agency-lang/lib/config.modelFlag.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type ResolvedModelFlag = { model: string; explicitProvider?: string }`
  - `CliFlags` gains `model?: ResolvedModelFlag`
  - `applyCliFlags(config, flags, input?)` honours `flags.model`

**Background the implementer needs.** `applyCliFlags` folds per-invocation flags onto a **copy** of the configuration and never mutates its input. The established shape for a nested client field is one line, e.g.:

```ts
if (flags.maxToolResultChars !== undefined) {
  next.client = { ...next.client, maxToolResultChars: flags.maxToolResultChars };
}
```

The model mapping is unusual in one way: a bare model must **remove** `client.defaultProvider` rather than set it. That is deliberate — see the spec's "Provider semantics". With no provider configured, the code generator emits none, and smoltalk infers the provider from the model name.

- [ ] **Step 1: Write the failing tests**

Create `packages/agency-lang/lib/config.modelFlag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyCliFlags, type AgencyConfig } from "./config.js";

/** A config with a provider already set, as agency.json might. */
function configWithProvider(): AgencyConfig {
  return {
    client: {
      defaultModel: "gpt-4o-mini",
      defaultProvider: "openrouter",
      providerModules: ["./my-provider.mjs"],
    },
  } as unknown as AgencyConfig;
}

describe("applyCliFlags: --model", () => {
  it("does nothing when the flag is absent", () => {
    const before = configWithProvider();
    const after = applyCliFlags(before, {});
    expect(after.client?.defaultModel).toBe("gpt-4o-mini");
    expect(after.client?.defaultProvider).toBe("openrouter");
  });

  it("a bare model sets the model and clears an inherited provider", () => {
    const after = applyCliFlags(configWithProvider(), {
      model: { model: "claude-opus-4-8" },
    });
    expect(after.client?.defaultModel).toBe("claude-opus-4-8");
    expect(after.client?.defaultProvider).toBeUndefined();
  });

  it("a prefixed model sets both fields", () => {
    const after = applyCliFlags(configWithProvider(), {
      model: { model: "my-tune", explicitProvider: "my-company" },
    });
    expect(after.client?.defaultModel).toBe("my-tune");
    expect(after.client?.defaultProvider).toBe("my-company");
  });

  it("leaves neighbouring client fields alone", () => {
    const after = applyCliFlags(configWithProvider(), {
      model: { model: "claude-opus-4-8" },
    });
    expect(after.client?.providerModules).toEqual(["./my-provider.mjs"]);
  });

  it("does not mutate the config it was given", () => {
    const before = configWithProvider();
    applyCliFlags(before, { model: { model: "claude-opus-4-8" } });
    expect(before.client?.defaultModel).toBe("gpt-4o-mini");
    expect(before.client?.defaultProvider).toBe("openrouter");
  });

  it("works when the config has no client block at all", () => {
    const after = applyCliFlags({} as AgencyConfig, {
      model: { model: "claude-opus-4-8" },
    });
    expect(after.client?.defaultModel).toBe("claude-opus-4-8");
    expect(after.client?.defaultProvider).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/agency-lang
npx vitest run lib/config.modelFlag.test.ts > /tmp/agency-t2.log 2>&1; tail -25 /tmp/agency-t2.log
```

Expected: FAIL — TypeScript rejects `model` as a `CliFlags` property, and the assertions do not hold.

- [ ] **Step 3: Declare the type and extend `CliFlags`**

In `packages/agency-lang/lib/config.ts`, immediately **above** `export type CliFlags` (line 681):

```ts
/**
 * A `--model` value after parsing. `explicitProvider` is set only when the
 * user wrote `provider/model`; a bare model leaves it undefined so smoltalk
 * infers the provider from the model name.
 *
 * Declared here rather than in the CLI so `CliFlags` stays self-contained:
 * `lib/config.ts` must not depend on `lib/cli/`, which would pull the CLI and
 * the runtime graph behind it into every consumer of the config module.
 */
export type ResolvedModelFlag = {
  model: string;
  explicitProvider?: string;
};
```

Then add the field to `CliFlags`:

```ts
export type CliFlags = {
  trace?: string | true;
  logFile?: string;
  logStdout?: boolean;
  observability?: boolean;
  strict?: boolean;
  maxToolCallRounds?: number;
  maxToolResultChars?: number;
  model?: ResolvedModelFlag;
};
```

- [ ] **Step 4: Map it in `applyCliFlags`**

In `packages/agency-lang/lib/config.ts`, immediately before the closing `return next;` of `applyCliFlags` (line 755):

```ts
  if (flags.model !== undefined) {
    // A bare model DELETES an inherited provider so smoltalk can infer one
    // from the model name; a stated provider replaces it. Destructuring is
    // how the deletion happens without mutating `next.client`.
    const { defaultProvider: _dropped, ...client } = next.client ?? {};
    next.client =
      flags.model.explicitProvider === undefined
        ? { ...client, defaultModel: flags.model.model }
        : {
            ...client,
            defaultModel: flags.model.model,
            defaultProvider: flags.model.explicitProvider,
          };
  }
```

Also extend the doc comment above `applyCliFlags` (the list starting `--trace <file>   → ...` at line 694) with two lines:

```
 *   --model <m>      → client.defaultModel=<m> and client.defaultProvider
 *                      DELETED, so smoltalk infers the provider
 *   --model <p>/<m>  → client.defaultModel=<m> + client.defaultProvider=<p>
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd packages/agency-lang
npx vitest run lib/config.modelFlag.test.ts lib/config.test.ts \
  > /tmp/agency-t2b.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t2b.log
```

Expected: all PASS. `lib/config.test.ts` is included to prove the existing `applyCliFlags` behaviour is untouched.

- [ ] **Step 6: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
feat(config): map a resolved --model onto the client defaults

A bare model sets client.defaultModel and deletes any inherited
client.defaultProvider, so smoltalk infers the provider from the name.
A provider/model value sets both.

The deletion matters because the layers merge field by field: a provider
left in place would survive and route the request somewhere the model
does not belong.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/lib/config.ts packages/agency-lang/lib/config.modelFlag.test.ts
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 3: The resolver

**Files:**
- Create: `packages/agency-lang/lib/cli/modelFlag.ts`
- Create: `packages/agency-lang/lib/cli/modelFlag.test.ts`

**Interfaces:**
- Consumes: `levenshtein` from Task 1; `ResolvedModelFlag` from Task 2.
- Produces: `export function resolveModelFlag(value: string, catalogNames?: string[]): ResolvedModelFlag`

**Background the implementer needs.**

`InvalidArgumentError` comes from Commander and is the error type Commander recognises: throwing it from an option parser makes Commander print `error: option '--model <name>' argument '<value>' is invalid. <your message>` and exit non-zero. `scripts/agency.ts` already throws it from `parseBoundedInt`.

The catalog is the **hosted text models**. `_listHostedModels()` in `lib/stdlib/llm.ts:104` returns `HostedModelInfo[]` already filtered to `model.type === "text"`. Do not call smoltalk's `getAllModels()` directly: it returns 68 entries of which only 56 are text, and the rest are image, embedding and speech models that would be accepted as chat models and then fail at the first call.

- [ ] **Step 1: Write the failing tests**

Create `packages/agency-lang/lib/cli/modelFlag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveModelFlag } from "./modelFlag.js";

const CATALOG = ["gpt-4o-mini", "gpt-4o", "claude-opus-4-8", "gemini-2.5-pro"];

const resolve = (value: string) => resolveModelFlag(value, CATALOG);

describe("resolveModelFlag: bare names", () => {
  it("accepts a known model and states no provider", () => {
    expect(resolve("gpt-4o-mini")).toEqual({ model: "gpt-4o-mini" });
  });

  it("rejects an unknown name and suggests the closest catalog entry", () => {
    expect(() => resolve("gpt-4o-minii")).toThrow(/Unknown model "gpt-4o-minii"/);
    expect(() => resolve("gpt-4o-minii")).toThrow(/Did you mean "gpt-4o-mini"/);
  });

  it("rejects an unknown name with no near match, and suggests nothing", () => {
    expect(() => resolve("zzzzzzzzzzzz")).toThrow(/Unknown model/);
    expect(() => resolve("zzzzzzzzzzzz")).not.toThrow(/Did you mean/);
  });

  it("names the prefix escape in the error", () => {
    expect(() => resolve("gpt-4o-minii")).toThrow(/provider\/model/);
  });
});

describe("resolveModelFlag: provider prefixes", () => {
  it("splits on the first slash", () => {
    expect(resolve("anthropic/claude-opus-4-8")).toEqual({
      model: "claude-opus-4-8",
      explicitProvider: "anthropic",
    });
  });

  it("keeps every later slash in the model name", () => {
    expect(resolve("openrouter/anthropic/claude-sonnet-4")).toEqual({
      model: "anthropic/claude-sonnet-4",
      explicitProvider: "openrouter",
    });
  });

  it("accepts an unknown provider, because provider modules register at runtime", () => {
    expect(resolve("my-company/my-tune")).toEqual({
      model: "my-tune",
      explicitProvider: "my-company",
    });
  });

  it("never checks a prefixed model against the catalog", () => {
    expect(() => resolve("openai/not-a-real-model-at-all")).not.toThrow();
  });
});

describe("resolveModelFlag: structurally invalid values", () => {
  it.each([
    ["", "empty value"],
    ["/claude-opus-4-8", "empty provider"],
    ["anthropic/", "empty model"],
    ["/", "both empty"],
  ])("rejects %s (%s)", (value) => {
    expect(() => resolve(value)).toThrow();
  });
});

describe("resolveModelFlag: the default catalog", () => {
  it("excludes non-text models", () => {
    // gpt-image-1 is in smoltalk's catalog, but as an image model. Accepting
    // it here would fail at the first llm() call instead.
    expect(() => resolveModelFlag("gpt-image-1")).toThrow(/Unknown model/);
  });

  it("accepts a real text model from the default catalog", () => {
    expect(resolveModelFlag("gpt-4o-mini")).toEqual({ model: "gpt-4o-mini" });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/agency-lang
npx vitest run lib/cli/modelFlag.test.ts > /tmp/agency-t3.log 2>&1; tail -20 /tmp/agency-t3.log
```

Expected: FAIL — cannot resolve `./modelFlag.js`.

- [ ] **Step 3: Write the resolver**

Create `packages/agency-lang/lib/cli/modelFlag.ts`:

```ts
import { InvalidArgumentError } from "commander";
import type { ResolvedModelFlag } from "@/config.js";
import { levenshtein } from "@/levenshtein.js";
import { _listHostedModels } from "@/stdlib/llm.js";

/** Suggest a catalog name only when it is this close to what was typed. */
const SUGGESTION_DISTANCE = 3;

function hostedTextModelNames(): string[] {
  return _listHostedModels().map((model) => model.name);
}

/**
 * Turn a `--model` value into a model and, when the user said one, a provider.
 *
 * A slash means a provider was named: everything before the FIRST slash is the
 * provider, everything after is the model. Splitting on the first slash only is
 * what lets `openrouter/anthropic/claude-sonnet-4` work — OpenRouter model
 * identifiers contain a slash of their own.
 *
 * A bare name is validated against the hosted text catalog, because that is the
 * only case where agency has to work the provider out for itself. A prefixed
 * name is never validated: `client.providerModules` can register a provider
 * under any name at startup, so at flag-parse time a custom provider and a typo
 * look identical, and guessing would reject working setups.
 */
export function resolveModelFlag(
  value: string,
  catalogNames: string[] = hostedTextModelNames(),
): ResolvedModelFlag {
  if (value === "") {
    throw new InvalidArgumentError("No model named.");
  }

  const slash = value.indexOf("/");
  if (slash !== -1) {
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    if (provider === "" || model === "") {
      throw new InvalidArgumentError(
        `"${value}" is not a model. Write provider/model, e.g. openrouter/anthropic/claude-sonnet-4.`,
      );
    }
    return { model, explicitProvider: provider };
  }

  if (catalogNames.includes(value)) {
    return { model: value };
  }
  throw new InvalidArgumentError(unknownModelMessage(value, catalogNames));
}

function unknownModelMessage(value: string, catalogNames: string[]): string {
  const lines = [`Unknown model "${value}".`];
  const suggestion = closestName(value, catalogNames);
  if (suggestion !== undefined) {
    lines.push(`Did you mean "${suggestion}"?`);
  }
  lines.push(
    `For a model from another provider, write provider/model — e.g. openrouter/${value}.`,
    "Run `agency models list` to see the catalog.",
  );
  return lines.join("\n  ");
}

function closestName(
  value: string,
  catalogNames: string[],
): string | undefined {
  let best: string | undefined;
  let bestDistance = SUGGESTION_DISTANCE + 1;
  for (const name of catalogNames) {
    const distance = levenshtein(value, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return bestDistance <= SUGGESTION_DISTANCE ? best : undefined;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd packages/agency-lang
npx vitest run lib/cli/modelFlag.test.ts > /tmp/agency-t3b.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t3b.log
```

Expected: all PASS.

- [ ] **Step 5: Typecheck**

```bash
cd packages/agency-lang
npx tsc --noEmit -p tsconfig.json 2>&1 | head -10
```

Expected: no output. If `@/stdlib/llm.js` does not resolve, check the path alias against a neighbouring file's imports rather than switching to a relative path.

- [ ] **Step 6: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
feat(cli): resolve a --model value into a model and provider

Splits on the first slash only, so an OpenRouter identifier survives as
the model name. A bare name is checked against the hosted TEXT catalog;
a prefixed one never is, because a provider module can register any name
at startup and a custom provider is indistinguishable from a typo here.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/lib/cli/modelFlag.ts packages/agency-lang/lib/cli/modelFlag.test.ts
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 4: Wire the flag into the CLI

**Files:**
- Modify: `packages/agency-lang/scripts/agency.ts` — the `addRunOptions` function, and the `RunOptions` type at line 132
- Create: `packages/agency-lang/scripts/agency.modelFlag.test.ts`

**Interfaces:**
- Consumes: `resolveModelFlag` from Task 3, `ResolvedModelFlag` from Task 2.
- Produces: `agency run --model <name>` and `agency --model <name> <file>`.

**Background the implementer needs — read this before writing the option.**

Commander calls an option parser with **two** arguments: `(value, previous)`, where `previous` is whatever the parser returned last time the flag appeared. So passing `resolveModelFlag` straight in means that on

```bash
agency run --model gpt-4o-mini --model claude-opus-4-8 greet.agency
```

the second call receives the first `ResolvedModelFlag` as its `catalogNames` argument, and the resolver validates against nonsense. The existing parsers dodge this by accident — `parsePositiveInt(value: string)` declares one parameter, so the extra argument is dropped. A resolver with a meaningful second parameter cannot rely on that.

**Wrap it in a one-line adapter.** This is not decoration; Step 1's test fails without it.

`addRunOptions` is shared by `run` and the hidden `default` command (the `agency <file>` shorthand), so one declaration serves both.

- [ ] **Step 1: Write the failing wiring test**

Create `packages/agency-lang/scripts/agency.modelFlag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createProgram } from "./agency.js";

/** Parse an argv and hand back the RunOptions the `run` action would see. */
function runOptionsFor(words: string[]): Record<string, unknown> {
  const program = createProgram({});
  const run = program.commands.find((cmd) => cmd.name() === "run");
  if (run === undefined) throw new Error("no run command");
  let captured: Record<string, unknown> = {};
  run.action(() => {
    captured = run.opts();
  });
  program.exitOverride();
  run.exitOverride();
  program.parse(["node", "agency", ...words], { from: "user" });
  return captured;
}

describe("--model wiring", () => {
  it("resolves a bare model", () => {
    const opts = runOptionsFor(["run", "--model", "gpt-4o-mini", "f.agency"]);
    expect(opts.model).toEqual({ model: "gpt-4o-mini" });
  });

  it("resolves a prefixed model", () => {
    const opts = runOptionsFor([
      "run", "--model", "openrouter/anthropic/claude-sonnet-4", "f.agency",
    ]);
    expect(opts.model).toEqual({
      model: "anthropic/claude-sonnet-4",
      explicitProvider: "openrouter",
    });
  });

  it("takes the last value when the flag is repeated", () => {
    // Commander passes the PREVIOUS parsed value as the parser's second
    // argument. Without an adapter, that object lands in `catalogNames`.
    const opts = runOptionsFor([
      "run", "--model", "gpt-4o-mini", "--model", "claude-opus-4-8", "f.agency",
    ]);
    expect(opts.model).toEqual({ model: "claude-opus-4-8" });
  });

  it("rejects an unknown bare model", () => {
    expect(() =>
      runOptionsFor(["run", "--model", "gpt-4o-minii", "f.agency"]),
    ).toThrow();
  });
});
```

If `createProgram` is not exported from `scripts/agency.ts`, export it — it is already used this way by `scripts/agency.test.ts`, so check there first.

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/agency-lang
npx vitest run scripts/agency.modelFlag.test.ts > /tmp/agency-t4.log 2>&1; tail -20 /tmp/agency-t4.log
```

Expected: FAIL — `opts.model` is `undefined`, because the option does not exist yet.

- [ ] **Step 3: Add the option**

In `packages/agency-lang/scripts/agency.ts`, add the import beside the other `@/cli/...` imports:

```ts
import { resolveModelFlag } from "@/cli/modelFlag.js";
```

Add `model` to the `RunOptions` type (line 132):

```ts
type RunOptions = Omit<CliFlags, "trace"> & {
  trace?: boolean;
  traceFile?: string;
  resume?: string;
  policy?: string;
  approve?: string;
  reject?: string;
  interactive?: boolean;
  maxCost?: string;
  maxTime?: string;
};
```

`CliFlags` already carries `model?: ResolvedModelFlag` from Task 2, so `RunOptions` inherits it and no new field is needed here. Confirm that by reading the type — if `RunOptions` does not spread `CliFlags`, add `model?: ResolvedModelFlag` explicitly and import the type.

Then, inside `addRunOptions`, add the option to the chain:

```ts
      .option(
        "--model <name>",
        "Model for this run's LLM calls, as `model` or `provider/model` (e.g. gpt-4o-mini, openrouter/anthropic/claude-sonnet-4)",
        // Adapter, not decoration: commander calls a parser with
        // (value, previous), and `previous` would land in the resolver's
        // catalogNames parameter when --model is repeated.
        (value: string) => resolveModelFlag(value),
      )
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd packages/agency-lang
npx vitest run scripts/agency.modelFlag.test.ts scripts/agency.test.ts \
  > /tmp/agency-t4b.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t4b.log
```

Expected: all PASS.

- [ ] **Step 5: Prove the adapter is load-bearing**

Temporarily change the option's parser from `(value: string) => resolveModelFlag(value)` to `resolveModelFlag`, re-run only the repeated-flag test, and confirm it FAILS. Then put the adapter back and confirm it passes again.

```bash
cd packages/agency-lang
npx vitest run scripts/agency.modelFlag.test.ts -t "repeated" \
  > /tmp/agency-t4c.log 2>&1; grep -E "Tests |FAIL" /tmp/agency-t4c.log
```

A test that passes either way is not a test. Do not skip this step.

- [ ] **Step 6: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
feat(cli): agency run --model, and the shorthand too

The option goes on addRunOptions, which `run` and the bare
`agency <file>` shorthand already share, so one declaration serves both.

The parser is wrapped in an adapter because commander calls a parser
with (value, previous): passing the resolver directly would hand the
previously parsed object to its catalogNames parameter whenever --model
appears twice.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/scripts/agency.ts packages/agency-lang/scripts/agency.modelFlag.test.ts
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 5: Prove the configuration reaches the generated program

**Files:**
- Modify: `packages/agency-lang/lib/backends/smoltalkDefaults.codegen.test.ts`

**Interfaces:**
- Consumes: the `applyCliFlags` mapping from Task 2.
- Produces: nothing for later tasks.

**Background the implementer needs.** The compiler writes the smoltalk client configuration into the generated JavaScript. `lib/backends/typescriptBuilder.ts:4413` emits `model: <string>` always, and emits `provider: <string>` **only when `client.defaultProvider` is set** — the comment there says it leaves it unset otherwise so smoltalk's model-to-provider lookup still applies. That conditional is exactly what the bare-model rule depends on, so it is worth pinning.

This file already has a `generate(source, config)` helper that runs the parser, preprocessor and builder and returns the printed TypeScript.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("smoltalkDefaults codegen", ...)` block in `packages/agency-lang/lib/backends/smoltalkDefaults.codegen.test.ts`:

```ts
  it("bakes client.defaultModel into the generated client config", () => {
    const out = generate(PROGRAM, { client: { defaultModel: "claude-opus-4-8" } });
    expect(out).toContain('model: "claude-opus-4-8"');
  });

  it("emits no provider when none is configured, so smoltalk infers one", () => {
    const out = generate(PROGRAM, { client: { defaultModel: "claude-opus-4-8" } });
    expect(out).not.toContain("provider:");
  });

  it("bakes both when a provider is configured", () => {
    const out = generate(PROGRAM, {
      client: {
        defaultModel: "anthropic/claude-sonnet-4",
        defaultProvider: "openrouter",
      },
    });
    expect(out).toContain('model: "anthropic/claude-sonnet-4"');
    expect(out).toContain('provider: "openrouter"');
  });
```

- [ ] **Step 2: Run the tests**

```bash
cd packages/agency-lang
npx vitest run lib/backends/smoltalkDefaults.codegen.test.ts \
  > /tmp/agency-t5.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t5.log
```

Expected: all PASS immediately — this is existing behaviour being pinned, not new behaviour. If the second case fails because `provider:` appears for an unrelated reason, tighten the assertion to `expect(out).not.toContain('provider: "')` and note why in a comment.

- [ ] **Step 3: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
test(codegen): pin the model and provider baked into the client config

The bare-model rule depends on the code generator emitting no provider
when none is configured, so smoltalk infers one from the model name.
That conditional had no test.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/lib/backends/smoltalkDefaults.codegen.test.ts
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 6: Prove a stated provider is sticky

**Files:**
- Create: `packages/agency-lang/lib/runtime/modelPrecedence.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — this pins existing runtime behaviour the design depends on.
- Produces: nothing for later tasks.

**Background the implementer needs.** The spec's central claim is that model and provider merge **independently**, so a provider set by a lower layer survives a higher layer that changes only the model. Two places do that merging:

- `lib/runtime/state/context.ts:763` — `getSmoltalkConfig(config)` returns `{ ...this.smoltalkDefaults, ...config }`
- `lib/runtime/prompt.ts:1026` — `ctx.getSmoltalkConfig({ ...stackSmolDefaults, ...restClientConfig })`

If someone later "fixes" either into a merge that clears the provider when the model changes, the sticky-provider rule this feature documents silently stops holding. Nothing in the suite would notice. That is what this test is for.

Note this test does **not** make an LLM call. The deterministic mock client reports `model: "deterministic"` in its result and does not expose the incoming model, so an end-to-end assertion is not available; the merge functions are the real mechanism and are tested directly.

`lib/runtime/configOverrides.test.ts:159` shows how to construct a `RuntimeContext` in a test — copy its construction shape rather than inventing one.

- [ ] **Step 1: Write the test**

Create `packages/agency-lang/lib/runtime/modelPrecedence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RuntimeContext } from "./state/context.js";

/**
 * A context whose baked defaults are what `--model openrouter/foo` would
 * produce: both a model and a provider.
 */
function contextWithBakedPair() {
  return new RuntimeContext({
    smoltalkDefaults: { model: "foo", provider: "openrouter" },
  } as never);
}

describe("model and provider merge independently", () => {
  it("keeps a baked provider when only the model is overridden", () => {
    const ctx = contextWithBakedPair();
    // What `setModel("claude-opus-4-8")` contributes: the model alone.
    const merged = ctx.getSmoltalkConfig({ model: "claude-opus-4-8" });
    expect(merged.model).toBe("claude-opus-4-8");
    expect(merged.provider).toBe("openrouter");
  });

  it("replaces the provider when the caller supplies one", () => {
    const ctx = contextWithBakedPair();
    const merged = ctx.getSmoltalkConfig({
      model: "claude-opus-4-8",
      provider: "anthropic",
    });
    expect(merged.model).toBe("claude-opus-4-8");
    expect(merged.provider).toBe("anthropic");
  });

  it("leaves the provider unset when nothing baked one", () => {
    const ctx = new RuntimeContext({
      smoltalkDefaults: { model: "gpt-4o-mini" },
    } as never);
    const merged = ctx.getSmoltalkConfig({ model: "claude-opus-4-8" });
    expect(merged.provider).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd packages/agency-lang
npx vitest run lib/runtime/modelPrecedence.test.ts \
  > /tmp/agency-t6.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t6.log
```

Expected: all PASS — this pins behaviour that already exists. If the `RuntimeContext` constructor rejects that argument shape, open `lib/runtime/configOverrides.test.ts` around line 159 and copy the fields it passes, keeping `smoltalkDefaults` as above.

- [ ] **Step 3: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
test(runtime): pin that model and provider merge independently

The --model design depends on a stated provider surviving a later
model-only override, which follows from getSmoltalkConfig being a
shallow spread. Nothing tested that, so a later merge change would break
the documented rule in silence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/lib/runtime/modelPrecedence.test.ts
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 7: End-to-end through the real binary

**Files:**
- Modify: `packages/agency-lang/tests/integration/cli/test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing for later tasks.

**Background the implementer needs.** This suite installs a packed tarball into a temporary project and drives the installed `agency` binary. It makes **no LLM calls**, so the assertions are on compiled output and exit status, not on a completed request.

Use `./node_modules/.bin/agency`, never `npx agency` — npx consumes `--`, and this suite already documents that. The `run(dir, cmd, { expectFail: true })` helper returns combined output for a command expected to exit non-zero.

`make` must be run before packing, or the tarball ships a stale CLI.

- [ ] **Step 1: Add the test cases**

In `packages/agency-lang/tests/integration/cli/test.mjs`, immediately before the line `console.log("Test 8 passed");`, insert:

```js
  // --- --model reaches the compiled program ---
  // An agency.json with a provider already set, so the bare-model case has
  // something to clear. Without this the "no provider" assertion could pass
  // for the wrong reason.
  writeFile(dir, "agency.json", JSON.stringify({
    client: { defaultModel: "gpt-4o-mini", defaultProvider: "openrouter" },
  }, null, 2));

  // A bare model replaces the model AND drops the inherited provider, so
  // smoltalk infers one from the name.
  run(dir, "./node_modules/.bin/agency compile --model claude-opus-4-8 greet.agency");
  const bareOut = readFileSync(join(dir, "greet.js"), "utf-8");
  assertIncludes(bareOut, 'model: "claude-opus-4-8"');
  if (bareOut.includes('provider: "')) {
    throw new Error("a bare --model left a provider in the generated config");
  }

  // A prefixed model sets both.
  run(dir, "./node_modules/.bin/agency compile --model openrouter/anthropic/claude-sonnet-4 greet.agency");
  const prefixedOut = readFileSync(join(dir, "greet.js"), "utf-8");
  assertIncludes(prefixedOut, 'model: "anthropic/claude-sonnet-4"');
  assertIncludes(prefixedOut, 'provider: "openrouter"');

  // The flag works on `run` and on the shorthand, which share addRunOptions.
  const modelRun = run(dir, "./node_modules/.bin/agency run --model claude-opus-4-8 greet.agency --name alice");
  assertIncludes(modelRun, "Hello, alice!");
  const modelShorthand = run(dir, "./node_modules/.bin/agency --model claude-opus-4-8 greet.agency --name alice");
  assertIncludes(modelShorthand, "Hello, alice!");

  // An unknown bare model fails BEFORE compiling. Deleting the output first
  // and asserting it was never recreated is what proves the ordering — a test
  // that only checked the message would pass even if validation ran last.
  rmSync(join(dir, "greet.js"), { force: true });
  const badModel = run(
    dir,
    "./node_modules/.bin/agency run --model gpt-4o-minii greet.agency 2>&1",
    { expectFail: true },
  );
  assertIncludes(badModel, 'Unknown model "gpt-4o-minii"');
  assertIncludes(badModel, 'Did you mean "gpt-4o-mini"');
  if (badModel.includes("    at ")) {
    throw new Error(`an unknown model printed a stack trace: ${badModel}`);
  }
  if (existsSync(join(dir, "greet.js"))) {
    throw new Error("compilation happened despite an invalid --model");
  }

  // Leave no agency.json behind for the later cases in this file.
  rmSync(join(dir, "agency.json"), { force: true });
```

Extend the `node:fs` import at the top of the file to cover the helpers used above:

```js
import { readFileSync, existsSync, rmSync } from "node:fs";
```

- [ ] **Step 2: Build and run the suite**

```bash
cd packages/agency-lang
make > /tmp/agency-t7-make.log 2>&1; echo "make=$?"
npm pack > /tmp/agency-t7-pack.log 2>&1
node tests/integration/cli/test.mjs ./agency-lang-*.tgz > /tmp/agency-t7.log 2>&1; echo "cli=$?"
rm -f agency-lang-*.tgz
tail -30 /tmp/agency-t7.log
```

Expected: `make=0`, `cli=0`, and the suite ends with `=== All CLI tests passed ===`.

If the bare-model case fails because `greet.js` already existed from an earlier case in the file, add `rmSync(join(dir, "greet.js"), { force: true });` before the first compile as well.

- [ ] **Step 3: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
test(cli): --model end to end, on run and the shorthand

Starts from an agency.json that already names a provider, so the
bare-model case has something to clear and cannot pass for the wrong
reason. The invalid-model case deletes the output first and asserts it
was never written, which is what proves validation runs before
compilation rather than after it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/tests/integration/cli/test.mjs
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 8: Developer documentation

**Files:**
- Modify: `packages/agency-lang/docs/dev/config.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

**Background the implementer needs.** `docs/dev/config.md` documents `AgencyConfig` and has a "Config resolution (single source of truth)" section at line 9 listing sources in increasing precedence. That is where a reader goes to find out what a flag means in configuration terms, so that is where this belongs. Do not touch `docs/site/**`.

- [ ] **Step 1: Add the section**

In `packages/agency-lang/docs/dev/config.md`, after the "Config resolution (single source of truth)" section, add:

```markdown
## What `--model` means

`agency run --model` and the `agency <file>` shorthand set the run's default
model. The value is parsed by `resolveModelFlag` in `lib/cli/modelFlag.ts` and
mapped by `applyCliFlags`:

| you write | `client.defaultModel` | `client.defaultProvider` |
| --- | --- | --- |
| `gpt-4o-mini` | `gpt-4o-mini` | **deleted** |
| `anthropic/claude-opus-4-8` | `claude-opus-4-8` | `anthropic` |
| `openrouter/anthropic/claude-sonnet-4` | `anthropic/claude-sonnet-4` | `openrouter` |

Three things about this are easy to get wrong later.

**A bare model deletes the provider rather than leaving it.** The code generator
emits a provider only when one is configured, so deleting it is how smoltalk is
allowed to infer the provider from the model name. If your `agency.json` sets
`defaultProvider` to route through a proxy, a bare `--model` bypasses that
proxy; name it (`--model litellm/gpt-4o-mini`) to keep it.

**A stated provider is sticky.** The layers merge field by field
(`lib/runtime/state/context.ts:763`), so a provider set by the flag survives a
later `setModel("other")` in Agency code — the pair becomes that provider plus
the new model. Code that wants to move provider too must say
`setLlmOptions({ model, provider })`. `lib/runtime/modelPrecedence.test.ts` pins
this.

**Only a bare name is validated.** It is checked against the hosted **text**
models from `_listHostedModels()` — not smoltalk's `getAllModels()`, which also
returns image, embedding and speech models. A prefixed name is never checked,
because `client.providerModules` can register a provider under any name at
startup, so at flag-parse time a custom provider and a typo are the same thing.
```

- [ ] **Step 2: Check the surrounding document still reads in order**

```bash
cd packages/agency-lang
grep -n "^#" docs/dev/config.md
```

Expected: the new `## What --model means` heading sits after "Config resolution" and before "All options".

- [ ] **Step 3: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
docs(dev): what --model means in config terms

Records the three things a later change is most likely to get wrong: a
bare model deletes the provider, a stated provider is sticky under a
model-only override, and only bare names are validated.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/docs/dev/config.md
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Finishing up

- [ ] **Run every test this change touches, in one go**

```bash
cd packages/agency-lang
npx vitest run \
  lib/levenshtein.test.ts \
  lib/config.modelFlag.test.ts \
  lib/config.test.ts \
  lib/cli/modelFlag.test.ts \
  lib/eval/grading/graders/ \
  scripts/agency.modelFlag.test.ts \
  scripts/agency.test.ts \
  lib/backends/smoltalkDefaults.codegen.test.ts \
  lib/runtime/modelPrecedence.test.ts \
  > /tmp/agency-final.log 2>&1
grep -E "Test Files|Tests |FAIL" /tmp/agency-final.log
```

Expected: all PASS. If anything fails, read `/tmp/agency-final.log` rather than re-running.

- [ ] **Run the structural linter**

```bash
cd packages/agency-lang
pnpm run lint:structure > /tmp/agency-lint.log 2>&1; echo "lint=$?"; tail -20 /tmp/agency-lint.log
```

- [ ] **Audit the diff against the anti-patterns list**

Read `docs/dev/anti-patterns.md`, then read your own diff:

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
git diff $(git merge-base HEAD origin/main) --stat
git diff $(git merge-base HEAD origin/main)
```

Use `git merge-base`, not `origin/main` directly — main moves.

- [ ] **Push and open a PR**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
git push -u origin adit/run-model-flag
```

Write the PR body to a file and pass it with `gh pr create --body-file`. Cover: what the flag does with an example of each form; that a bare model clears an inherited provider and why; that a stated provider is sticky; that only bare names are validated and the prefix is the escape; and the `--trace`-style note that `agency models refresh` is not an escape because it persists nothing.

**Open the PR and stop.** The owner squash-merges every PR; do not run `gh pr merge`.

---

## Self-review notes

Checked against the spec, revision 3:

- **Every spec section has a task.** Reading the value → Task 3. Provider semantics → Tasks 2 and 6. Validation, both structural and catalog → Task 3. Suggestions → Tasks 1 and 3. Dataflow and the Commander adapter → Task 4. The `ResolvedModelFlag` location → Task 2. The codegen effect → Task 5. Integration coverage → Task 7. Documentation → Task 8.
- **The spec's test list is covered**, with one deliberate substitution: the spec asked for an Agency execution test observing `{ model, provider }` for four flag-and-code combinations. The deterministic mock client reports `model: "deterministic"` and does not expose the incoming model, so that observation is not available end to end. Task 6 tests the merge functions directly instead, and Task 7 covers the flag-to-codegen half. The seam left untested is "generated JavaScript values become `smoltalkDefaults`", which is pre-existing behaviour this change does not touch. **This is a real reduction in coverage from what the spec asked for and should be raised in the PR description** rather than passed off as equivalent.
- **Names are consistent across tasks**: `ResolvedModelFlag` (Task 2, used in 3 and 4), `resolveModelFlag` (Task 3, used in 4), `levenshtein` (Task 1, used in 3), `explicitProvider` throughout.
- **Two steps ask the implementer to watch a test fail on purpose** — Task 4 Step 5 in particular, which temporarily removes the adapter. That step exists because the repeated-flag test is the only thing standing between this design and a bug that unit tests structurally cannot see.
