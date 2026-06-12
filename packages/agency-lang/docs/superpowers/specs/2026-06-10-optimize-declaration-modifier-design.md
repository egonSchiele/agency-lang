# Optimize Declaration Modifier Design

**Date:** 2026-06-10
**Status:** Draft

## Summary

Replace the current `@optimize(...)` statement tag with an `optimize` declaration modifier. The optimizer should mutate declarations that users explicitly mark as optimizable, rather than inferring a target from a tag attached to a nearby `llm(...)` call.

The v1 scope is intentionally narrow:

- `optimize` applies only to variable declarations.
- Runtime execution treats `optimize` as a no-op.
- `agency eval optimize file.agency:node` uses `node` as the eval entrypoint, but discovers optimized declarations across the root agent file and its local `.agency` import tree.
- V1 supports only string and multiline-string initializers.
- Discovery emits a sorted target catalog consumed by the declarative mutator and optimize eval pipeline.
- `targets.json` records discovered targets. Mutation artifacts, source diffs, and writeback timing are owned by the declarative mutator and optimize eval pipeline specs.

General AST editing for agents is out of scope for this design. This design solves the deterministic optimizer-target discovery problem first. The declarative mutation API that consumes discovered target IDs is specified separately in `docs/superpowers/specs/2026-06-11-declarative-optimize-mutator-design.md`.

## Relationship to the Existing Optimize Design

This spec supersedes the target-selection portions of the earlier `agency eval optimize` design. The eval pipeline refactor owns run/judge composition and acceptance-policy details. This document only assumes the loop can run a baseline, ask a mutator for a candidate patch set, evaluate candidate vs champion with the task suite, call shared judge-suite logic, and accept or reject the candidate as a unit.

The key change is the mutation surface. The earlier design optimized exactly one `@optimize(prompt)` annotation attached to an `llm(...)` statement. This design removes that annotation and instead optimizes any declarations explicitly marked with the `optimize` modifier in the root file and local `.agency` import tree.

When this spec conflicts with the earlier optimize-command spec, this spec wins for:

- parser and formatter syntax,
- optimize target discovery,
- target catalog shape, and
- target ID stability rules.

The eval pipeline specs own judge sampling, aggregation, run directory conventions, and summary/verdict concepts. This declaration-modifier spec owns target syntax and discovery.

The declarative mutator spec owns source mutation APIs, preview/apply behavior, context-specific replacement validation, and future extensibility beyond string variable initializers. This spec only defines the target catalog contract that mutator consumes.

## Motivation

The current `@optimize(prompt)` model requires optimizer code to infer what the user intended to mutate:

```agency
const prompt = "What is the capital of India?"
@optimize(prompt)
const result = llm(prompt)
```

That creates ambiguity:

- Does `prompt` refer to a semantic LLM prompt slot or a variable named `prompt`?
- If `llm(prompt)` is used, should the optimizer mutate the argument expression or the variable initializer?
- If multiple `llm(...)` calls exist near tags, which one is the target?
- How should future targets such as model or temperature be represented?

The declaration modifier model removes the inference problem:

```agency
optimize const prompt = "What is the capital of India?"
const result = llm(prompt)
```

The user marks exactly the value the optimizer is allowed to change. The optimizer then discovers marked declarations, validates their value domains, asks the mutator for target-level changes, applies those changes deterministically, and evaluates the resulting agent.

## User-Facing Syntax

### Valid Forms

V1 accepts these declaration forms:

```agency
optimize const prompt = "..."
optimize let prompt = "..."
optimize static const systemPrompt = "..."
```

`optimize` is a declaration modifier. During ordinary execution, it has no runtime behavior.

### Invalid Forms

V1 rejects unsupported modifier placement and non-declaration usage:

```agency
static optimize const prompt = "..." // unsupported modifier order in v1
const optimize prompt = "..."        // invalid declaration syntax
optimize prompt = "..."              // not a declaration
def foo(optimize prompt: string) {}   // parameters cannot be optimized
const config = { optimize prompt: "" } // object fields cannot be optimized
```

The parser should start strict: only `optimize static const`, `optimize const`, and `optimize let` are valid. The formatter should emit canonical modifier order:

```agency
optimize static const prompt = "..."
```

Arbitrary modifier ordering can be added later if needed.

## Runtime Semantics

`optimize` is ignored by TypeScript generation and runtime execution. These two declarations behave the same at runtime:

```agency
optimize const prompt = "Classify: ${text}"
const prompt = "Classify: ${text}"
```

The modifier exists only for optimizer tooling.

## Command Surface

The optimize command lives under the eval namespace:

```bash
agency eval optimize <file>[:<node>] (--goal "<text>" | --tasks <file|dir>) [options]
```

`<file>[:<node>]` still selects the eval entrypoint. The selected node is the program under evaluation, not the complete target-discovery boundary. Target discovery starts from `<file>` and follows local relative `.agency` imports reachable from that file.

The command no longer requires or accepts `@optimize(...)` tags. Startup validation should fail if any legacy optimize tags remain in the local Agency import tree:

```text
`@optimize(...)` is no longer supported.
Mark the declaration to optimize instead, for example:

  optimize const prompt = "..."
```

Optimize loop options remain conceptually valid where they are not judge-specific: `--iterations`, `--run-id`, `--runs-dir`, `--no-writeback`, `--mutator-model`, and `--verbose`. Judge-related options should mirror shared `eval judge` options such as samples, confidence threshold, and margin threshold. Optimize should not add judge behavior that `eval judge` does not expose.

### Stdlib Boundary

The declaration modifier design is primarily file-oriented because discovery and writeback operate across an import tree. A stdlib `optimize(...)` wrapper can still exist, but it should not pretend that a single in-memory source string is enough for the full multi-file feature.

V1 should use one of these stdlib semantics:

1. accept a real `entryFile` and `workingDir`, mirroring the CLI, or
2. keep in-memory `agentSource` support only for self-contained agents with no relative `.agency` imports.

The implementation plan should choose the smallest compatible path based on the state of the existing stdlib optimize wrapper. In either case, CLI behavior is the source of truth for multi-file discovery, artifacts, and writeback.

## Optimize Target Discovery

### Entry Point vs Discovery Scope

For this command:

```bash
agency eval optimize foo.agency:main --tasks tasks.json
```

`foo.agency:main` selects the eval entrypoint. It does not limit optimize target discovery to declarations inside `main`.

The optimizer discovers optimized declarations in:

1. the root agent file, and
2. local relative `.agency` imports reachable from that file.

Discovery is syntactic, not runtime-reachability-based. If a local `.agency` file is reachable through the import tree, its optimized declarations are discovered even if the selected eval entrypoint does not call code from that file at runtime.

The optimizer canonicalizes local import paths before traversal, uses a canonical absolute-path visited set, and visits each file at most once. Import cycles are allowed; already-visited files are skipped. Paths that spell the same file differently, such as `./prompts.agency` and `../pkg/prompts.agency`, collapse to one file identity.

The optimizer does not discover or mutate declarations in:

- `std::` imports,
- `pkg::` imports,
- JS/TS imports,
- bare package imports, or
- files outside the local Agency import tree.

This boundary is intentionally narrower than general runtime dependency discovery. A program may read data files, import JS helpers, or depend on package code at evaluation time; those dependencies are execution/materialization concerns, not optimize-target concerns.

### Target Identity

Each optimize target gets a deterministic ID:

```text
<relative-file>:<scope>:<variable>
```

`relative-file` is computed from a single normalized base directory, using POSIX `/` separators in artifacts and logs. V1 should use the CLI working directory as that base unless a later implementation plan identifies a better existing project-root helper.

Examples:

```text
foo.agency:global:systemPrompt
foo.agency:main:capitalPrompt
helpers/prompts.agency:classify:judgeGoal
```

Scope names in v1 are:

- `global` for top-level declarations,
- function name for function-local declarations,
- node name for node-local declarations.

The optimizer should fail on duplicate target IDs.

Targets are sorted by ID everywhere they are reported or sent to the mutator: startup logs, `targets.json`, mutator input, mutation artifacts, and patch application. This keeps runs reproducible and avoids import-order-dependent mutator prompts.

Discovery also emits a target catalog entry for every target. V1 variable targets use this shape:

```ts
type OptimizeVariableTarget = {
  id: string
  kind: "variable"
  file: string
  scope: "global" | string
  name: string
  valueKind: "string" | "multilineString"
  value: string
}
```

The catalog, not hand-authored strings, is the source of truth for legal mutations. Human-readable target IDs are designed for logs, artifacts, and LLM-generated mutation proposals, but every mutation must still be validated against a discovered catalog entry.

Future optimized type declarations should use the same catalog model with a different target kind. The likely ID shape for top-level types is:

```text
<relative-file>:<type-name>
```

Example:

```text
foo.agency:ResultType
```

And the target entry can extend the same discriminated union:

```ts
type OptimizeTypeTarget = {
  id: string
  kind: "type"
  file: string
  name: string
  definition: string
}
```

V1 does not parse or mutate `optimize type`; the catalog shape is reserved so the mutator API can add type operations later without replacing the variable-target contract.

### Scope Restrictions in V1

To keep target IDs simple and deterministic, v1 supports optimized declarations only in these locations:

- top-level global declarations,
- top-level statements directly inside a function body,
- top-level statements directly inside a node body.

Optimized declarations inside nested blocks, branches, loops, handlers, threads, or other nested statement bodies are rejected in v1:

```text
Optimize declarations inside nested block scopes are unsupported in v1.
```

This restriction can be lifted later by adding block-level scope identity to target IDs.

### Startup Reporting

Before mutation/evaluation begins, the optimizer prints the discovered targets:

```text
[optimize] Entry point: foo.agency:main
[optimize] Found 3 optimize targets:
  - foo.agency:global:systemPrompt            string
  - foo.agency:main:capitalPrompt             string
  - prompts.agency:global:judgeRubric         string
```

This gives users immediate feedback about exactly what will be optimized.

If the discovered target set is large, the command should still print every target in deterministic order. Hidden mutation targets are worse than noisy startup output.

## Candidate Materialization

Each iteration evaluates a complete candidate file set, not a synthetic single-file rewrite. The candidate file set contains:

- the root agent file,
- every local relative `.agency` import discovered from the root file, and
- unchanged copies of discovered files that were not mutated in that iteration.

Files should be materialized under the iteration `agent/` artifact directory while preserving paths relative to the discovery base. For example:

```text
runs/optimize/<run-id>/iter-1/agent/
  foo.agency
  helpers/prompts.agency
  shared/goals.agency
```

The eval command then runs against the materialized entry file inside that file set. This ensures accepted and rejected candidates are reproducible from artifacts and avoids evaluating against a mixture of candidate source and live on-disk imported Agency files.

V1 does not need to solve general workspace copying. It should not broadly copy the user's working directory just to make optimization work. Non-Agency runtime dependencies should resolve the same way they do for `eval run`, using the configured working directory and existing module/path resolution rules. If a future implementation needs broader dependency materialization, that should be designed separately.

## Supported Value Domains

V1 supports optimized declarations whose initializer AST node is a string literal or multiline string literal:

```agency
optimize const prompt = "Classify: ${text}"
```

```agency
optimize const prompt = """
Classify this input:
${text}
"""
```

Unsupported optimized values fail before eval starts:

```agency
optimize const temperature = 0.2
optimize const prompt = basePrompt
optimize const prompt = "A" + suffix
```

Error:

```text
Unsupported optimize target foo.agency:main:temperature.
Only string and multiline string initializers are supported today.
```

Even if an expression has type `string`, v1 rejects it unless it is a literal string or multiline string initializer. Identifiers, binary expressions, function calls, object lookups, conditional expressions, destructuring, and any multi-binding declaration form are out of scope for v1.

Future versions can use type annotations to define domains for non-string values:

```agency
optimize const model: "gpt-4o-mini" | "gpt-4.1" = "gpt-4o-mini"
optimize const temperature: NumberInRange(0, 1) = 0.2
```

## Mutation API Boundary

The declaration modifier feature produces a deterministic target catalog. The declarative mutator API consumes that catalog. This split is intentional:

- this spec owns syntax, AST representation, import-tree discovery, target IDs, value-domain validation, and target catalog artifacts;
- `2026-06-11-declarative-optimize-mutator-design.md` owns mutation operation schemas, `preview`/`apply`, context-specific replacement validation, diffs, stale-target checks, and future target kinds such as optimized types.

The v1 optimizer still sends target values to the bundled mutation agent and receives target-level changes, but the TypeScript source-editing interface should use the declarative operation model from the mutator spec rather than a declaration-modifier-specific patch API.

### Mutator Input

Each iteration sends the mutator all current target values:

```json
{
  "goal": "Improve the agent so it answers the capital of France correctly.",
  "targets": [
    {
      "id": "foo.agency:main:prompt",
      "value": "What is the capital of India?"
    },
    {
      "id": "prompts.agency:global:judgeGoal",
      "value": "Answer accurately."
    }
  ],
  "history": "..."
}
```

### Mutator Output

The mutator returns target-level changes:

```json
{
  "changes": [
    {
      "id": "foo.agency:main:prompt",
      "value": "What is the capital of France?",
      "rationale": "The task asks about France, so the prompt should ask about France directly."
    }
  ],
  "rationale": "Updated the main prompt to match the target task."
}
```

The mutator may change one, many, or all targets. Targets not mentioned in `changes` remain unchanged.

### Mutation Application

Mutation application is delegated to the declarative mutator layer. For v1 variable targets, the default operation is equivalent to replacing the declaration initializer while preserving the declaration shape and `optimize` modifier. The mutator layer validates the new source in the target's syntactic context, preserves required string interpolations, renders changed files, and emits target-level/file-level diffs.

## Optimization Strategy

### V1 Joint Patch Strategy

V1 treats each mutator response as a coordinated patch set:

```text
baseline champion
  ↓
iteration 1: propose target-level patch set
  ↓
eval candidate
  ↓
judge candidate vs champion
  ↓
accept/reject whole patch set
```

The champion starts as the baseline file set. If an iteration wins, the candidate file set becomes the champion. If it loses or ties, the champion remains unchanged.

### Future Attribution

When multiple targets are optimized together, future optimizers should be able to estimate how much each target contributed to an improvement. V1 does not implement attribution, but artifacts should be structured to support it later.

Future strategies may include:

- coordinate descent: optimize one target at a time,
- patch-set ablation: evaluate individual and grouped subsets of a winning patch set,
- hybrid strategies: alternate single-target moves and coordinated patch sets.

Target-level mutation records should leave room for future fields such as:

```json
{
  "targetId": "foo.agency:main:prompt",
  "estimatedContribution": 0.7,
  "attributionMethod": "single-target-ablation"
}
```

## Artifacts

Each run should write artifacts that make target discovery and candidate changes easy to inspect without broad workspace copies.

Suggested layout:

```text
runs/optimize/<run-id>/
  config.json
  targets.json
  iter-0/
    agent/
      foo.agency
      prompts.agency
    eval-run/
  iter-1/
    agent/
      foo.agency
      prompts.agency
    mutation.json
    mutation.md
    diff.patch
    verdict.json
    eval-run/
  champion/
    agent/
      foo.agency
      prompts.agency
    championIter
  summary.json
```

### targets.json

`targets.json` records all discovered targets:

```json
[
  {
    "id": "foo.agency:main:prompt",
    "file": "foo.agency",
    "scope": "main",
    "variable": "prompt",
    "kind": "string",
    "initialValue": "What is the capital of India?"
  }
]
```

### mutation.json

`mutation.json` records machine-readable target-level changes:

```json
{
  "iter": 1,
  "strategy": "joint-patch-v1",
  "changes": [
    {
      "targetId": "foo.agency:main:prompt",
      "oldValue": "What is the capital of India?",
      "newValue": "What is the capital of France?",
      "rationale": "The task asks about France, so the prompt should ask about France directly."
    }
  ]
}
```

### mutation.md

`mutation.md` records human-readable target-level changes:

````md
# Mutation

Updated 1 target.

## foo.agency:main:prompt

Rationale:
The task asks about France, so the prompt should ask about France directly.

Old:
```text
What is the capital of India?
```

New:
```text
What is the capital of France?
```
````

### diff.patch

`diff.patch` records file-level source changes:

```diff
--- a/foo.agency
+++ b/foo.agency
@@
-optimize const prompt = "What is the capital of India?"
+optimize const prompt = "What is the capital of France?"
```

## Writeback

Writeback remains gated by the existing CLI writeback behavior/flag.

During optimization, imported local files may be mutated in the candidate file set and evaluated from the iteration `agent/` artifact file set. On-disk updates are separate: when writeback is enabled, accepted champion changes may write back to every local `.agency` file that contains an accepted optimized target, including imported local `.agency` files.

Writeback safety is per file:

1. Store the original hash for each local source file at run start.
2. Before writeback, re-read every file that would be written.
3. If any file changed externally, abort writeback for all files with a clear error.
4. Never write to `std::`, `pkg::`, JS/TS, bare imports, or files outside the local import tree.

## Implementation Architecture

### Parser and AST

Add `optimize?: boolean` to assignment AST nodes:

```ts
type Assignment = BaseNode & {
  type: "assignment"
  variableName: string
  declKind?: "let" | "const"
  static?: boolean
  optimize?: boolean
  value: Expression | MessageThread
}
```

Parser grammar for v1:

```text
[optimize] [static] (const | let) name [: type]? = expr
```

Only canonical modifier order is accepted:

```text
optimize static const
optimize const
optimize let
```

The Agency generator/formatter preserves the modifier in canonical order. TypeScript generation ignores it.

### Target Discovery Module

Add a dedicated optimizer target module, for example:

```text
lib/optimize/targets.ts
```

Core target shape:

```ts
type OptimizeTarget = {
  id: string
  file: string
  scope: string
  variable: string
  valueKind: "string" | "multilineString"
  value: string
  node: Assignment
}
```

Discovery API:

```ts
discoverOptimizeTargets(entryFile: string, config: AgencyConfig): OptimizeTargetSet
```

Responsibilities:

- parse files without synthetic `std::index` injection,
- traverse local relative `.agency` imports,
- canonicalize paths and skip already-visited files,
- skip unsupported import kinds,
- collect `assignment.optimize === true`,
- compute deterministic target IDs,
- reject unsupported initializer values,
- reject nested-block optimize declarations in v1,
- reject duplicate target IDs,
- sort targets by ID,
- retain parsed documents by file for later patch application.

### Declarative Mutator Module

The source-editing implementation lives in the declarative mutator module described by `2026-06-11-declarative-optimize-mutator-design.md`. That module consumes `OptimizeTargetSet` and returns preview/apply results for operation records such as:

```ts
{
  target: "foo.agency:main:prompt",
  kind: "variable",
  op: "replaceInitializer",
  value: "\"What is the capital of France?\""
}
```

The declaration modifier implementation should not grow a separate patch API that duplicates the mutator module.

### Bundled LLM Mutator

The bundled LLM mutator should use the declarative mutator operation schema rather than a declaration-modifier-specific `{ id, value }` change shape. See `2026-06-11-declarative-optimize-mutator-design.md` for the exact operation records and validation rules.

### Optimize Loop

Change `OptimizeLoopConfig.target` from one source string to a local file set:

```ts
target: {
  entryFile: string
  entryNode: string
  workingDir: string
  files: Record<string, string>
  targets: OptimizeTarget[]
  writebackPaths?: Record<string, string>
}
```

Each iteration:

1. reads the champion file set,
2. discovers current target values,
3. calls the LLM mutator with all target values,
4. previews/applies returned declarative operations through the source mutator,
5. writes the candidate file set,
6. evaluates `entryFile:entryNode`,
7. judges candidate against champion,
8. accepts or rejects the whole operation batch.

## Backward Compatibility

Remove `@optimize(...)` support immediately in this branch. The feature has not shipped, and keeping both target systems would create unnecessary implementation and documentation complexity.

Docs and tests should describe only the declaration modifier model.

## Errors and Diagnostics

### No Targets

```text
No optimize targets found in local Agency import tree for foo.agency.
Mark string declarations with `optimize const`, for example:

  optimize const prompt = "..."
```

### Unsupported Target Value

```text
Unsupported optimize target foo.agency:main:temperature.
Only string and multiline string initializers are supported today.
```

### Duplicate Target ID

```text
Duplicate optimize target id foo.agency:main:prompt.
Each optimized variable must be unique within its file and scope.
```

### Nested Optimize Declaration

```text
Optimize declarations inside nested block scopes are unsupported in v1.
Move foo.agency:main:prompt to the top level of the function or node body.
```

### Invalid Mutator Change

```text
Mutation rejected: target foo.agency:main:prompt removed interpolation ${text}.
```

## Testing Plan

### Parser Tests

- parses `optimize const`,
- parses `optimize let`,
- parses `optimize static const`,
- rejects unsupported modifier positions,
- rejects optimize on non-declarations.

### Formatter Tests

- preserves `optimize`,
- emits canonical `optimize static const` ordering.

### TypeScript Builder / Runtime Tests

- generated runtime ignores `optimize`,
- `optimize const` behaves like `const`,
- `optimize let` behaves like `let`,
- `optimize static const` behaves like `static const`.

### Target Discovery Tests

- root file target,
- function-local target,
- node-local target,
- global/static target,
- rejects nested block-local target,
- local import tree target,
- import cycle handling,
- path canonicalization for duplicate import spellings,
- skips std/pkg/js imports,
- duplicate IDs,
- unsupported initializer values.

### Patch Application Tests

- replaces string literal initializer,
- replaces multiline string initializer,
- preserves interpolations,
- rejects missing/unknown target,
- renders changed file source,
- produces per-target and file-level diff.

### Optimize Loop Tests

- mutator receives target list,
- candidate writes all changed files,
- mutation artifacts include target-level changes,
- writeback updates root and imported local files,
- writeback aborts if any original file changed externally.

### Agency Integration Test

- small agent with `optimize const prompt = "...India..."`,
- France task,
- deterministic mutator changes prompt,
- final candidate/champion source reflects optimized declaration.

## Non-Goals

- General-purpose AST editing for agents.
- Persistent graph store or source/projection drift management.
- Optimizing non-string values in v1.
- Optimizing stdlib, package, JS, or TS imported values.
- Target attribution / ablation strategy in v1.
