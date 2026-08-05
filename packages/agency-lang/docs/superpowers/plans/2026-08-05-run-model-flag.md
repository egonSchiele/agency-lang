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
| `lib/config.test.ts` | **Modify.** Add cases to its existing `describe("applyCliFlags")` block at line 184. |
| `lib/cli/modelFlag.ts` | **Create.** `resolveModelFlag` — parse `provider/model`, validate structure, validate a bare name against the text catalog, build the error message. |
| `lib/cli/modelFlag.test.ts` | **Create.** Tests for the resolver. |
| `scripts/agency.ts` | **Modify.** Add the option to `addRunOptions`, behind a one-line adapter. |
| `scripts/agency.test.ts` | **Modify.** Add Commander wiring cases; it already owns `createProgram` and CLI parsing. |
| `lib/backends/smoltalkDefaults.codegen.test.ts` | **Modify.** Add cases proving the configuration reaches the generated client block. |
| `lib/runtime/agencyLlm.test.ts` | **Modify.** Add four precedence cases observing the final client config via the existing `RecordingClient`. |
| `tests/integration/cli/test.mjs` | **Modify.** End-to-end through the real binary, both commands, and the failure-before-compilation case. |
| `docs/dev/config.md` | **Modify.** Document what `--model` means in configuration terms, beside the other flags. |

Tests live in the suites that already own the behaviour rather than in new
narrowly named files. Only `lib/cli/modelFlag.test.ts` and
`lib/levenshtein.test.ts` are new, because their modules are new.

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
- Modify: `packages/agency-lang/lib/config.test.ts` — the existing `describe("applyCliFlags")` block at line 184

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

Append these to the existing `describe("applyCliFlags", ...)` block in
`packages/agency-lang/lib/config.test.ts` (line 184). Do not create a new file —
that block already owns this behaviour and its helpers.

Note the fixtures need no casts: these objects already satisfy `AgencyConfig`,
and casting through `unknown` would hide a bad fixture instead of asking
TypeScript to check it.

```ts
  describe("--model", () => {
    /** A config with a provider already set, as agency.json might. */
    function configWithProvider(): AgencyConfig {
      return {
        client: {
          defaultModel: "gpt-4o-mini",
          defaultProvider: "openrouter",
          providerModules: ["./my-provider.mjs"],
        },
      };
    }

    it("does nothing when the flag is absent", () => {
      const after = applyCliFlags(configWithProvider(), {});
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
      const after = applyCliFlags({}, { model: { model: "claude-opus-4-8" } });
      expect(after.client?.defaultModel).toBe("claude-opus-4-8");
      expect(after.client?.defaultProvider).toBeUndefined();
    });
  });
```

If `AgencyConfig` requires fields these fixtures omit, add only what the
compiler demands — do not reach for a cast.

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd packages/agency-lang
npx vitest run lib/config.test.ts > /tmp/agency-t2.log 2>&1; tail -25 /tmp/agency-t2.log
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
npx vitest run lib/config.test.ts > /tmp/agency-t2b.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t2b.log
```

Expected: all PASS — the new cases and every pre-existing `applyCliFlags` case, which together prove the mapping was added without disturbing the others.

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
git add packages/agency-lang/lib/config.ts packages/agency-lang/lib/config.test.ts
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
import { describe, expect, it, vi } from "vitest";
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

// The default catalog comes from `_listHostedModels()`. Mock it rather than
// asserting on real model names: which models ship changes month to month, and
// a test that breaks when a catalog is refreshed is a test nobody trusts. The
// text-only filtering belongs to `_listHostedModels` and is already covered in
// `lib/stdlib/llm.test.ts`; what matters here is that the resolver asks it.
vi.mock("@/stdlib/llm.js", () => ({
  _listHostedModels: () => [
    { name: "catalog-model-one", provider: "openai" },
    { name: "catalog-model-two", provider: "anthropic" },
  ],
}));

describe("resolveModelFlag: the default catalog", () => {
  it("accepts a name the adapter returns", () => {
    expect(resolveModelFlag("catalog-model-one")).toEqual({
      model: "catalog-model-one",
    });
  });

  it("rejects a name the adapter does not return", () => {
    expect(() => resolveModelFlag("catalog-model-three")).toThrow(
      /Unknown model/,
    );
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
- Modify: `packages/agency-lang/scripts/agency.test.ts` — it already owns `createProgram` and CLI parsing

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

Append to `packages/agency-lang/scripts/agency.test.ts`:

```ts
describe("--model wiring", () => {
  /** Parse an argv and hand back the RunOptions the `run` action would see. */
  async function runOptionsFor(words: string[]): Promise<Record<string, unknown>> {
    const program = createProgram({});
    const run = program.commands.find((cmd) => cmd.name() === "run");
    if (run === undefined) throw new Error("no run command");
    let captured: Record<string, unknown> = {};
    run.action(() => {
      captured = run.opts();
    });
    program.exitOverride();
    run.exitOverride();
    // `from: "user"` means every element is a user argument — commander does
    // NOT strip a leading node/script pair in this mode. Passing them would
    // send "node" through the hidden default command instead of testing `run`.
    await program.parseAsync(words, { from: "user" });
    return captured;
  }

  it("resolves a bare model", async () => {
    const opts = await runOptionsFor(["run", "--model", "gpt-4o-mini", "f.agency"]);
    expect(opts.model).toEqual({ model: "gpt-4o-mini" });
  });

  it("resolves a prefixed model", async () => {
    const opts = await runOptionsFor([
      "run", "--model", "openrouter/anthropic/claude-sonnet-4", "f.agency",
    ]);
    expect(opts.model).toEqual({
      model: "anthropic/claude-sonnet-4",
      explicitProvider: "openrouter",
    });
  });

  it("takes the last value when the flag is repeated", async () => {
    // Commander passes the PREVIOUS parsed value as the parser's second
    // argument. Without the adapter, that object lands in `catalogNames`.
    const opts = await runOptionsFor([
      "run", "--model", "gpt-4o-mini", "--model", "claude-opus-4-8", "f.agency",
    ]);
    expect(opts.model).toEqual({ model: "claude-opus-4-8" });
  });

  it("rejects an unknown bare model", async () => {
    await expect(
      runOptionsFor(["run", "--model", "gpt-4o-minii", "f.agency"]),
    ).rejects.toThrow();
  });
});
```

The model names above must exist in the real catalog, because this test drives
the real resolver through the real program. `gpt-4o-mini` and `claude-opus-4-8`
are both in it today; if either has been retired, substitute a current name from
`agency models list` rather than mocking here — the point of this suite is the
wiring, end to end.

If `createProgram` is not exported from `scripts/agency.ts`, export it — it is already used this way by `scripts/agency.test.ts`, so check there first.

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd packages/agency-lang
npx vitest run scripts/agency.test.ts > /tmp/agency-t4.log 2>&1; tail -20 /tmp/agency-t4.log
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
npx vitest run scripts/agency.test.ts \
  > /tmp/agency-t4b.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t4b.log
```

Expected: all PASS.

- [ ] **Step 5: Prove the adapter is load-bearing**

Temporarily change the option's parser from `(value: string) => resolveModelFlag(value)` to `resolveModelFlag`, re-run only the repeated-flag test, and confirm it FAILS. Then put the adapter back and confirm it passes again.

```bash
cd packages/agency-lang
npx vitest run scripts/agency.test.ts -t "repeated" \
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
git add packages/agency-lang/scripts/agency.ts packages/agency-lang/scripts/agency.test.ts
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 5: Prove the configuration reaches the generated program

**Files:**
- Modify: `packages/agency-lang/lib/backends/smoltalkDefaults.codegen.test.ts`

**Interfaces:**
- Consumes: nothing. This task pins existing code-generation behaviour; it does
  **not** exercise `applyCliFlags`, because the `generate` helper hands a
  ready-made `AgencyConfig` straight to `TypeScriptBuilder`. Task 2 covers the
  mapping and Task 7 covers the two joined together.
- Produces: nothing for later tasks.

**Background the implementer needs.** The compiler writes the smoltalk client
configuration into the generated JavaScript. `lib/backends/typescriptBuilder.ts:4413`
emits `model: <string>` always, and emits `provider: <string>` **only when
`client.defaultProvider` is set**.

**Most of this is already tested.** `smoltalkDefaults.codegen.test.ts` has
`omits provider when defaultProvider is unset` (line 64) and `bakes provider when
defaultProvider is set` (line 71). Leave both alone. Note the existing test
anchors on `/provider:\s*"/` rather than the bare token, with a comment
explaining that `provider` appears elsewhere in generated output — do not add a
looser assertion beside it.

Only one assertion is missing: that `client.defaultModel` is baked at all.

- [ ] **Step 1: Write the failing tests**

Append one case to the `describe("smoltalkDefaults codegen", ...)` block in
`packages/agency-lang/lib/backends/smoltalkDefaults.codegen.test.ts`:

```ts
  it("bakes client.defaultModel into the generated client config", () => {
    const out = generate(PROGRAM, { client: { defaultModel: "claude-opus-4-8" } });
    expect(out).toMatch(/model:\s*"claude-opus-4-8"/);
  });
```

Do not add provider cases; lines 64 and 71 already cover both directions.

- [ ] **Step 2: Run the tests**

```bash
cd packages/agency-lang
npx vitest run lib/backends/smoltalkDefaults.codegen.test.ts \
  > /tmp/agency-t5.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t5.log
```

Expected: all PASS immediately — this is existing behaviour being pinned, not new behaviour.

- [ ] **Step 3: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
test(codegen): pin the model baked into the client config

The provider cases were already covered; only the model itself had no
assertion.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/lib/backends/smoltalkDefaults.codegen.test.ts
git commit -F .tmp/msg.txt && rm -rf .tmp
```

---

## Task 6: Prove precedence at the final client config

**Files:**
- Modify: `packages/agency-lang/lib/runtime/agencyLlm.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — this pins existing runtime behaviour the design depends on.
- Produces: nothing for later tasks.

**Background the implementer needs.** The spec's central claim is that model and
provider merge **independently**, so a provider set by a lower layer survives a
higher layer that changes only the model. If someone later "fixes" that into a
merge that clears the provider whenever the model changes, the sticky-provider
rule silently stops holding and nothing in the suite notices.

This is observable end to end. `lib/runtime/agencyLlm.test.ts` already has a
`RecordingClient` (line 35) that stores every `PromptConfig` it is handed in
`configs[]`, and an existing test at line 103 asserts on
`client.configs[0].provider` after `_setLlmOptions({ provider, model })`. Assert
on the recorded pair rather than on any internal merge function.

Two facts that shape the cases:

- `makeCtx()` (line 11) hard-codes `smoltalkDefaults: { model: "default-model" }`.
  It needs a parameter so a test can bake a provider too. Give the parameter the
  current value as its default so every existing caller is unaffected.
- The TypeScript `agency.llm` facade forwards only `model` and `maxTokens` to
  `clientConfig` (`lib/runtime/agencyLlm.ts:96`) — **not** `provider`. Generated
  Agency code does forward it, but this facade does not, so the per-call
  provider case uses `_setLlmOptions({ model, provider })`, which the spec names
  as the supported way to move both.

- [ ] **Step 1: Give `makeCtx` a defaults parameter**

In `packages/agency-lang/lib/runtime/agencyLlm.test.ts`, change `makeCtx` (line 11):

```ts
function makeCtx(
  smoltalkDefaults: Record<string, unknown> = { model: "default-model" },
): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults,
    dirname: "/tmp",
  });
}
```

The default keeps every existing caller identical.

- [ ] **Step 2: Write the precedence cases**

Append to `packages/agency-lang/lib/runtime/agencyLlm.test.ts`:

```ts
describe("model and provider precedence", () => {
  /** The pair the client was actually asked for. */
  async function effectivePair(
    baked: Record<string, unknown>,
    call: () => Promise<unknown>,
  ): Promise<{ model?: string; provider?: string }> {
    const ctx = makeCtx(baked);
    const client = new RecordingClient(["ok"]);
    ctx.setLLMClient(client);
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await inFrame(ctx, threads, call);
    const config = client.configs[0] as any;
    return { model: config.model, provider: config.provider };
  }

  it("a branch model override leaves no provider when none was baked", async () => {
    const pair = await effectivePair({ model: "baked-model" }, async () => {
      _setLlmOptions({ model: "branch-model" });
      return agency.llm("hi");
    });
    expect(pair).toEqual({ model: "branch-model", provider: undefined });
  });

  it("a baked provider survives a branch model-only override", async () => {
    const pair = await effectivePair(
      { model: "baked-model", provider: "openrouter" },
      async () => {
        _setLlmOptions({ model: "branch-model" });
        return agency.llm("hi");
      },
    );
    expect(pair).toEqual({ model: "branch-model", provider: "openrouter" });
  });

  it("a baked provider survives a per-call model-only override", async () => {
    const pair = await effectivePair(
      { model: "baked-model", provider: "openrouter" },
      () => agency.llm("hi", { model: "call-model" }),
    );
    expect(pair).toEqual({ model: "call-model", provider: "openrouter" });
  });

  it("supplying both replaces the baked provider", async () => {
    const pair = await effectivePair(
      { model: "baked-model", provider: "openrouter" },
      async () => {
        _setLlmOptions({ model: "branch-model", provider: "anthropic" });
        return agency.llm("hi");
      },
    );
    expect(pair).toEqual({ model: "branch-model", provider: "anthropic" });
  });
});
```

The first three cases are the sticky-provider rule the spec promises. The fourth
is the escape it names.

- [ ] **Step 3: Run the suite**

```bash
cd packages/agency-lang
npx vitest run lib/runtime/agencyLlm.test.ts \
  > /tmp/agency-t6.log 2>&1; grep -E "Test Files|Tests |FAIL" /tmp/agency-t6.log
```

Expected: all PASS, new and pre-existing. These pin behaviour that already
exists; if one fails, the merge does not work the way the spec claims and the
spec is wrong — stop and say so rather than adjusting the assertion to match.

- [ ] **Step 4: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
test(runtime): pin model and provider precedence at the client

The --model design depends on a stated provider surviving a later
model-only override. Asserted on the config the client is actually
handed, via the RecordingClient this suite already has, rather than on
an internal merge function.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
git add packages/agency-lang/lib/runtime/agencyLlm.test.ts
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

In `packages/agency-lang/tests/integration/cli/test.mjs`, immediately before the
line `console.log("Test 8 passed");`, insert:

```js
  // --- --model reaches the compiled program ---
  // `--model` lives on addRunOptions, which `run` and the shorthand share.
  // `agency compile` has its own option list and does NOT take it, so these
  // cases drive the two supported surfaces and read what they compiled.
  //
  // Start from an agency.json that already names a provider, so the bare-model
  // case has something to clear and cannot pass for the wrong reason.
  writeFile(dir, "agency.json", JSON.stringify({
    client: { defaultModel: "gpt-4o-mini", defaultProvider: "openrouter" },
  }, null, 2));

  // A bare model replaces the model AND drops the inherited provider, so
  // smoltalk infers one from the name.
  const bareRun = run(dir, "./node_modules/.bin/agency run --model claude-opus-4-8 greet.agency --name alice");
  assertIncludes(bareRun, "Hello, alice!");
  const bareOut = readFileSync(join(dir, "greet.js"), "utf-8");
  assertIncludes(bareOut, 'model: "claude-opus-4-8"');
  // Anchored on a baked literal: the bare token `provider` also appears in
  // unrelated generated output.
  if (/provider:\s*"/.test(bareOut)) {
    throw new Error("a bare --model left a provider in the generated config");
  }

  // The shorthand takes the flag too, and a prefixed value sets both fields.
  const prefixedRun = run(dir, "./node_modules/.bin/agency --model openrouter/anthropic/claude-sonnet-4 greet.agency --name alice");
  assertIncludes(prefixedRun, "Hello, alice!");
  const prefixedOut = readFileSync(join(dir, "greet.js"), "utf-8");
  assertIncludes(prefixedOut, 'model: "anthropic/claude-sonnet-4"');
  if (!/provider:\s*"openrouter"/.test(prefixedOut)) {
    throw new Error("a prefixed --model did not bake its provider");
  }

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

  // The position rule applies to the new flag like any other: after the
  // filename it belongs to the program, is NOT validated by agency, and draws
  // the standard warning. greet does not declare --model, so its own parser
  // rejects it — which is also the proof the flag was forwarded.
  const modelAfterFile = run(
    dir,
    "./node_modules/.bin/agency run greet.agency --model gpt-4o-mini 2>&1",
    { expectFail: true },
  );
  assertIncludes(modelAfterFile, "Warning: --model went to your program");
  assertIncludes(modelAfterFile, "unknown flag --model");
  if (modelAfterFile.includes("Unknown model")) {
    throw new Error("agency validated a --model that belonged to the program");
  }

  // Leave no agency.json behind for the later cases in this file.
  rmSync(join(dir, "agency.json"), { force: true });
```

Extend the `node:fs` import at the top of the file to cover the helpers used
above:

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

If the bare-model case reads a stale `greet.js` from an earlier case in this
file, add `rmSync(join(dir, "greet.js"), { force: true });` before the first run
as well.

- [ ] **Step 3: Commit**

```bash
cd /Users/adityabhargava/agency-lang/worktree-model-flag
mkdir -p .tmp && cat > .tmp/msg.txt <<'EOF'
test(cli): --model end to end, on run and the shorthand

Starts from an agency.json that already names a provider, so the
bare-model case has something to clear and cannot pass for the wrong
reason. The invalid-model case deletes the output first and asserts it
was never written, which proves validation runs before compilation. A
last case puts --model after the filename and asserts agency forwards it
without validating, so the new option obeys the position rule.

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
`setLlmOptions({ model, provider })`. The precedence cases in
`lib/runtime/agencyLlm.test.ts` pin this.

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
  lib/config.test.ts \
  lib/cli/modelFlag.test.ts \
  lib/eval/grading/graders/ \
  scripts/agency.test.ts \
  lib/backends/smoltalkDefaults.codegen.test.ts \
  lib/runtime/agencyLlm.test.ts \
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

Checked against the spec, revision 3, and revised after review.

- **Every spec section has a task.** Reading the value → Task 3. Provider
  semantics → Tasks 2 and 6. Validation, both structural and catalog → Task 3.
  Suggestions → Tasks 1 and 3. Dataflow and the Commander adapter → Task 4. The
  `ResolvedModelFlag` location → Task 2. The codegen effect → Task 5.
  Integration coverage → Task 7. Documentation → Task 8.
- **The spec's four-way precedence test is now delivered in full.** An earlier
  revision of this plan claimed the observation was unavailable and substituted
  a test of an internal merge function. That was wrong: `RecordingClient` in
  `lib/runtime/agencyLlm.test.ts` records every `PromptConfig` handed to the
  client, including both `model` and `provider`, and an existing test already
  asserts on it. The claim came from checking the deterministic mock client and
  stopping there. Task 6 now asserts on the configuration the client actually
  receives.
- **Tests live in the suites that own the behaviour.** `applyCliFlags` cases go
  in `lib/config.test.ts`, Commander wiring in `scripts/agency.test.ts`,
  precedence in `lib/runtime/agencyLlm.test.ts`. Only `lib/cli/modelFlag.test.ts`
  and `lib/levenshtein.test.ts` are new files, because their modules are new.
- **Task 5 adds one assertion, not three.** The two provider cases already exist
  at lines 64 and 71 of `smoltalkDefaults.codegen.test.ts`, with an anchored
  regex and a comment explaining why the bare `provider:` token is the wrong
  thing to match. Only the model assertion was missing.
- **Task 7 drives only the two surfaces that have the flag.** `--model` is on
  `addRunOptions`, which `compile` does not use, so the integration cases use
  `run` and the shorthand and read the files those runs compiled.
- **Names are consistent across tasks**: `ResolvedModelFlag` (Task 2, used in 3
  and 4), `resolveModelFlag` (Task 3, used in 4), `levenshtein` (Task 1, used in
  3), `explicitProvider` throughout.
- **Three steps ask the implementer to watch something fail on purpose.** Task 4
  Step 5 temporarily removes the Commander adapter, because the repeated-flag
  test is the only thing standing between this design and a bug that unit tests
  structurally cannot see. Task 6 Step 3 says to stop and report if a precedence
  case fails, rather than adjust the assertion to match — those cases encode the
  spec's central claim, so a failure means the spec is wrong.
