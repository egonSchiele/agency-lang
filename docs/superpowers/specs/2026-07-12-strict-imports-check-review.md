# Review: strict-imports-check design

**Reviews:** `docs/superpowers/specs/2026-07-12-strict-imports-check-design.md`

**Date:** 2026-07-12

**Verdict:** The core idea is real and worth doing, and the spec is unusually well-grounded in the code (the `getFile` loaded-vs-defined insight is exactly right). But it has one factual hole that makes part of the design dead code, plus an unresolved altitude question about severity. Revise before writing the plan. Every claim below was verified against the source in the `strict-imports-check` worktree. Findings are ranked by severity.

---

## 1. [Blocker] The `export { } from` case is already validated — and the spec's handling of it is unreachable

The spec's premise is "two mistakes go unreported," and it lists `export { missing } from "./lib.agency"` as a silent case to newly catch (Design line 80, test line 110). **That case is not silent.** `mergeExportsFrom` (`lib/symbolTable.ts:461`) throws during `SymbolTable.build`:

- `symbolTable.ts:490` — `Symbol '<name>' is not defined in '<module>'`
- `symbolTable.ts:494` — `<kind> '<name>' … is not exported`

It is called at `symbolTable.ts:229` inside `build`, with no surrounding try/catch, and `agency tc` calls `SymbolTable.build` *before* it runs any typechecker pass. Consequences:

- The premise "Running `agency tc` … reports `No type errors found`" is **false** for `export from` (today it throws — arguably too hard, an unhandled crash rather than a clean diagnostic).
- The new pass's `export { } from` branch is **dead code**: `build` throws before `checkMissingImports` ever runs.
- The test on line 110 would surface a thrown `Error` (or a crash), not `importNameNotFound`.

**Recommendation:** Either drop `export from` from this pass entirely (already covered), or — more valuable — retarget the work to convert those *thrown* re-export errors into clean registry diagnostics aligned with #474. That is a genuinely useful cleanup, but a different framing than "catch a silent mistake," and the spec should say which it is doing. As written it appears unaware the throw path exists.

## 2. [Altitude] "Always an error, no config knob" conflicts with the existing `undefinedFunctions` knob

The spec's closest sibling, `checkUndefinedFunctions`, has **config-controlled severity** (`config.typechecker.undefinedFunctions`, `undefinedFunctionDiagnostic.ts:18`) defaulting to *warning* — which is why the spec's own example (line 45) shows `warning AG4004`. The spec then proposes the new import diagnostics be **always errors with no knob** (lines 94, 131).

That is incoherent from a user's mental model: `missingFn()` (a call to a name that exists nowhere) is a silenceable, default-*warning*, but `import { missingFn }` would be an un-silenceable *error*. Someone who sets `undefinedFunctions: "off"` still gets hard failures on imports. The codebase already owns "how strict are undefined-name diagnostics." The spec should reuse `undefinedFunctions`, or add a parallel `unresolvedImports` knob, and justify the default against the existing one rather than asserting strictness by fiat.

## 3. [Design gap] The `pkg::` throw is not in the main algorithm

The spec correctly flags `pkg::` as highest-risk (line 99), but treats the throw as an edge note. Verified: `resolvePkgAgencyPath` throws in multiple cases (`importPaths.ts:455-483`), and `resolveAgencyImportPath` propagates it. So the design's happy path — "resolve the path (step 1), then `existsSync` (step 2)" — **crashes** on an absent package before it can reach the existence check. The `try/catch` that maps a resolution throw to `importModuleNotFound` belongs in the core per-name flow (the "What it checks" section), not the edge-cases section.

## 4. [Minor] Scope/premise wording

- Line 13 is garbled: "imports a name that the target Agency file exists but does not define." Rewrite.
- After findings 1–2, state the *actually novel* gap precisely: plain `import { name }` of a non-existent name, and plain imports from a non-existent module. That is the real, verified silent case (`resolveImport` skips at `symbolTable.ts:289`; `scopes.ts:403` declares it `"any"`). It is a good catch — lead with it.

## 5. [Minor] Make the export-visibility asymmetry explicit

The existing re-export path enforces `export` visibility (throws on non-exported, `symbolTable.ts:494`), but the spec makes export-visibility a non-goal for plain imports. Net user-visible result: `import { x }` of a *defined-but-not-exported* name stays silent, while `export { x } from` of the same name errors. That inconsistency is defensible but should be named in the spec, not left implicit.

---

## What's solid

- The `getFile` loaded-vs-not-loaded distinction is the right primitive and correctly reasoned.
- Staying silent on parse-failed targets avoids double-reporting.
- Mirroring `checkUndefinedFunctions` as a new pass is the right altitude for the *plain-import* case.
- The rollout sweep over `stdlib/` + fixtures is exactly right for a new hard error.

## Bottom line

Fix finding 1 (it changes what the feature even is for re-exports), resolve finding 2 (severity/altitude — likely a product call), and fold finding 3 into the algorithm. Findings 4–5 are wording. After that it is plan-ready.
