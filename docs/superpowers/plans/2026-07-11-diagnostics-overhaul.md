# Diagnostics Overhaul (issue #474) Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline execution — this owner does not use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

> **Rev 2** applies all findings from
> `docs/superpowers/plans/2026-07-11-diagnostics-overhaul-plan-review.md`:
> must-fixes 1-3 (dedup key, ANSI regex, TypeCheckDiagnostic public-API step +
> PR #514 hazard), should-fixes 4-7, all anti-pattern hits in code blocks, and
> the full test-plan section (T1-T11). One review nit adopted with a caveat:
> the usaspending/verdict cleanup line is kept but conditioned — those are
> recurring make/test ARTIFACTS (appear after builds, not in fresh status).

**Goal:** Every type-checker diagnostic gets a stable code, required severity, a real (or deliberately-null) location, and a message rendered from a single template registry — with byte-identical message text to today.

**Architecture:** Strangler migration. New fields land as OPTIONAL on `TypeCheckError` alongside a registry + factory (Task 1); call sites migrate file-by-file with every commit green (Tasks 2-3); then the fields flip to REQUIRED and the legacy fields are deleted, so `tsc` proves no site or consumer was missed (Task 4). Printer + the public `TypeCheckDiagnostic` API (Task 5), suppression + dedup (Task 6), location-audit + verification (Task 7).

**Tech Stack:** TypeScript (template literal types for typed params), vitest.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-11-diagnostics-overhaul-design.md`

## Global Constraints

- **Byte-identical messages** (spec gate): templates are extracted VERBATIM. Any message that must change to fit a template is a recorded deviation in the PR body, never a silent edit. Existing tests that assert message text must pass untouched.
- Registry is append-only; codes match `AG\d{4}`; category ranges: AG1xxx types/aliases, AG2xxx assignability/checking, AG3xxx interrupts/effects/handlers, AG4xxx names/scope/reserved/const, AG5xxx match/narrowing/exhaustiveness, AG6xxx tools/llm/blocks, AG7xxx static-init/config/imports.
- Repo rules: types not interfaces, objects not maps, arrays not sets, NO one-line ifs (brace everything, including in plan-transcribed code), NO nested ternaries, no module-global per-run state.
- Commit messages: NO apostrophes; multi-line via `git commit -F <file>`.
- Save all test output to files; don't rerun to re-read. Do NOT run the agency execution suite locally (CI does).
- `loc.line` is 0-indexed (docs/dev/locations.md) — display line prints `+1`; display-col indexing is pinned at execution against a fixture (do not guess).

## Verified facts (2026-07-11; per-file counts re-verified exact by the external review)

- **Sweep inventory (76 sites, 17 files):** validate.ts 11, synthesizer.ts 11, checker.ts 11, scopes.ts 7, index.ts 7, effectPayloadCheck.ts 7, utils.ts 4, validateStaticInit.ts 3, interruptAnalysis.ts 3, undefinedFunctionDiagnostic.ts 2, toolBlockBinding.ts 2, staticInitRules.ts 2, raisesDiagnostic.ts 2, undefinedVariableDiagnostic.ts 1, matchExhaustiveness.ts 1, functionTypeRaises.ts 1, definiteReturns.ts 1. (`lib/logsViewer/parse.ts` has 4 additional `errors.push` into a DIFFERENT error type — out of scope.)
- `TypeCheckError` (lib/typeChecker/types.ts:19-26): `message` + all-optional fields. `SourceLocation` already has `{line, col, start, end}` (lib/types/base.ts:1-6).
- **Public API chain (review finding):** `lib/compiler/typecheck.ts:37` mirrors `variableName`/`expectedType`/`actualType` into `TypeCheckDiagnostic`, re-exported from `lib/compiler/compile.ts:94`, surfaced as the public Agency type `TypeCheckReport` (`stdlib/agency.agency:79`), returned by `std::agency.typecheck`, consumed by the `writeAgency` review loop. Changing it requires editing `stdlib/agency.agency`, running `make`, and taking the regenerated stdlib docs.
- **Coordination hazard:** PR #514 is (or was) open against `stdlib/agency.agency` + `lib/stdlib/agency.ts`. Check its state at worktree setup; if merged, base on it; if open, do Tasks 1-3 first and rebase before Task 5, coordinating with the owner if it is still open by then.
- `formatErrors` (lib/typeChecker/index.ts, end of file) prints `${severityWord}: ${message}` — no file/line. Callers: `lib/cli/serve.ts:63,66`, `lib/compiler/buildSession.ts:648,652`, `lib/compiler/compile.ts:157` (already one-arg; only the two `"warning"` call sites change signature-wise).
- `color.red`/`color.yellow` (lib/utils/termcolors.ts:158, `createColorFunction()`) color UNCONDITIONALLY — test assertions must strip real ANSI (`\x1b[...m`), the TTY-gated variant is the separate `ttyColor` export.
- Suppression (lib/typeChecker/suppression.ts): `parseSuppressions` → `{nocheck, ignoreLines: Set<number>}` (directive on line i suppresses line i+1); `applySuppressions` keeps `!e.loc` errors unconditionally. **Behavior change shipping in this PR (deliberate, documented):** sites that gain real locations become suppressible by pre-existing bare `@tc-ignore` comments that previously could not touch them.
- Dedup (lib/typeChecker/index.ts:408-416): key = `${err.message}:${err.loc?.start ?? -1}`.
- `ctx.currentFile` set once in the TypeChecker constructor (index.ts:105); stamping placement before the `applySuppressions(deduplicateErrors())` return (~index.ts:400) is coherent.
- Shared error-building helpers: `checkType` + `emitAssignabilityError` (utils.ts), `reportNotAssignable` (scopes.ts), `validateTypeReferences` (validate.ts, pushes into a passed array).
- Hand-constructed `TypeCheckError` values in 10+ test files — Task 4 flip breaks them; fixed mechanically via tsc.
- Config-driven severities (registry default + per-call override; `silent` skips the push at the site): strict member access (synthesizer.ts), matchExhaustiveness, undefinedFunctionDiagnostic, undefinedVariableDiagnostic.
- Output reaches the LLM: the `typecheck` stdlib tool and the review agent (`lib/agents/review/agent.agency:32`).
- Type-alias/def nodes carry locs (withLoc-wrapped parsers), so most currently loc-less index.ts sites can get real locations.

## File structure

- Create `lib/typeChecker/diagnostics.ts` (+ `diagnostics.test.ts`) — registry, param typing, factory, `renderMessage`.
- Modify `lib/typeChecker/types.ts`; all 17 sweep files; `lib/typeChecker/index.ts` (stamping, dedup, formatErrors); `lib/typeChecker/suppression.ts` (+ test); `lib/cli/serve.ts`; `lib/compiler/buildSession.ts`; `lib/compiler/typecheck.ts`; **`stdlib/agency.agency` (public TypeCheckReport shape — requires `make` + regenerated stdlib docs)**.
- Create `lib/typeChecker/formatErrors.test.ts`, `lib/typeChecker/diagnosticLocations.test.ts` (the location-audit suite).
- Modify the `@tc-ignore` docs page (grep `tc-ignore` under docs/ at execution).

## Worktree setup (before Task 1)

```bash
cd /Users/adityabhargava/agency-lang
git fetch origin
gh pr view 514 --repo egonSchiele/agency-lang --json state,files -q '{state: .state}'   # coordination check (see Verified facts)
git worktree add .claude/worktrees/diagnostics-overhaul -b diagnostics-overhaul origin/main
cd .claude/worktrees/diagnostics-overhaul && pnpm install
cd packages/agency-lang && make > /tmp/diag-setup-make.log 2>&1
```

All paths below are inside `.claude/worktrees/diagnostics-overhaul/packages/agency-lang/`.

---

### Task 1: Registry, factory, typed params (no call-site changes)

**Files:**
- Create: `lib/typeChecker/diagnostics.ts`
- Modify: `lib/typeChecker/types.ts:19-26`
- Test: `lib/typeChecker/diagnostics.test.ts`

**Interfaces:**
- Produces: `DIAGNOSTICS`, `type DiagnosticName`, `type DiagnosticParams<N>`, `diagnostic(name, params, loc, overrides?): TypeCheckError`, `renderMessage(template, params): string` — **`renderMessage` THROWS on a missing param** (review T2: a diagnostic about diagnostics beats silently rendering the string "undefined" into user-facing output).
- `TypeCheckError` gains OPTIONAL `code?`, `name?`, `params?`, `file?` (severity/loc flip in Task 4).

- [ ] **Step 1: Write the failing tests** — `lib/typeChecker/diagnostics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DIAGNOSTICS, diagnostic, renderMessage } from "./diagnostics.js";

describe("diagnostic registry invariants", () => {
  const entries = Object.entries(DIAGNOSTICS);

  it("codes are unique", () => {
    const codes = entries.map(([, entry]) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("codes match AG####", () => {
    for (const [, entry] of entries) {
      expect(entry.code).toMatch(/^AG\d{4}$/);
    }
  });

  it("no template contains an unconverted TS interpolation", () => {
    // The likeliest sweep mistake: copying `${expr}` verbatim instead of
    // converting to {placeholder}. Neither the render regex nor the
    // placeholder regex would touch it — this tripwire does.
    for (const [, entry] of entries) {
      expect(entry.message).not.toContain("${");
    }
  });

  it("every brace in a template is part of a well-formed {word} placeholder", () => {
    for (const [, entry] of entries) {
      expect(entry.message.replace(/\{\w+\}/g, "")).not.toMatch(/[{}]/);
    }
  });
});

describe("renderMessage", () => {
  it("substitutes named params", () => {
    expect(renderMessage("got '{a}' and '{b}'", { a: "x", b: 2 })).toBe(
      "got 'x' and '2'",
    );
  });

  it("THROWS on a missing param instead of rendering undefined", () => {
    expect(() => renderMessage("got '{a}'", {})).toThrow(/missing param 'a'/);
  });
});

describe("diagnostic factory", () => {
  it("renders the message byte-identically to the legacy string", () => {
    const err = diagnostic(
      "reassignToConst",
      { name: "counter" },
      { line: 3, col: 2, start: 40, end: 55 },
    );
    expect(err.message).toBe("Cannot reassign to constant 'counter'.");
    expect(err.code).toBe(DIAGNOSTICS.reassignToConst.code);
    expect(err.name).toBe("reassignToConst");
    expect(err.severity).toBe("error");
    expect(err.params).toEqual({ name: "counter" });
    expect(err.loc).toEqual({ line: 3, col: 2, start: 40, end: 55 });
  });

  it("severity override wins over the registry default", () => {
    const err = diagnostic("reassignToConst", { name: "c" }, null, {
      severity: "warning",
    });
    expect(err.severity).toBe("warning");
  });

  it("loc null is carried through (file-level diagnostic)", () => {
    // Task 4 flips this to .toBe(null) when TypeCheckError.loc becomes
    // `SourceLocation | null`.
    expect(diagnostic("reassignToConst", { name: "c" }, null).loc).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/typeChecker/diagnostics.test.ts > /tmp/diag-task1-red.log 2>&1`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/typeChecker/diagnostics.ts`:**

```ts
import type { SourceLocation } from "../types/base.js";
import type { TypeCheckError } from "./types.js";

/**
 * The single source of truth for every diagnostic the type checker can emit.
 *
 * APPEND-ONLY: a shipped code is never renumbered or reused. A retired
 * diagnostic keeps its entry with `retired: true` so the code stays reserved.
 * Codes are AG#### with category ranges (documentation, not machinery):
 *   AG1xxx types/aliases          AG2xxx assignability/checking
 *   AG3xxx interrupts/effects     AG4xxx names/scope/reserved/const
 *   AG5xxx match/narrowing        AG6xxx tools/llm/blocks
 *   AG7xxx static-init/config/imports
 *
 * Message templates use {param} placeholders. Templates are extracted
 * VERBATIM from the legacy inline strings — rendered output must be
 * byte-identical (the migration safety gate). Conditional phrasing NEVER
 * goes into a param (params are structured data, not sentence fragments):
 * a site that built its message conditionally gets one entry per phrasing.
 *
 * Deliberate `loc: null` (file-level) diagnostics are listed here as the
 * sweep finds them, one line each with the reason no AST node is reachable:
 *   (populated during Tasks 2-3; final list goes in the PR body for review)
 */
export const DIAGNOSTICS = {
  reassignToConst: {
    code: "AG4005",
    severity: "error",
    message: "Cannot reassign to constant '{name}'.",
  },
  // Entries grow file-by-file during the Task 2-3 sweeps.
} as const;

export type DiagnosticName = keyof typeof DIAGNOSTICS;

/** The {placeholder} names of a template, as a string-literal union. */
type Placeholders<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;

/** Typed params for a diagnostic: one key per {placeholder} in its template. */
export type DiagnosticParams<N extends DiagnosticName> = Record<
  Placeholders<(typeof DIAGNOSTICS)[N]["message"]>,
  string | number
>;

/**
 * Render a template. Throws on a missing param: typed call sites cannot hit
 * this, but an `as any` caller or future untyped path must fail loudly
 * rather than ship the string "undefined" inside a user-facing message.
 */
export function renderMessage(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`renderMessage: missing param '${key}' for template: ${template}`);
    }
    return String(value);
  });
}

/**
 * Build a TypeCheckError from the registry. `loc: null` is a DELIBERATE
 * file-level diagnostic (greppable), never an accident of omission.
 * `overrides.severity` exists for config-driven sites (strict member access,
 * exhaustiveness, undefined names) — the registry carries the default.
 */
export function diagnostic<N extends DiagnosticName>(
  name: N,
  params: DiagnosticParams<N>,
  loc: SourceLocation | null,
  overrides?: { severity?: "error" | "warning" },
): TypeCheckError {
  const entry = DIAGNOSTICS[name];
  return {
    code: entry.code,
    name,
    message: renderMessage(entry.message, params),
    severity: overrides?.severity ?? entry.severity,
    params,
    loc: loc ?? undefined, // transitional; Task 4 flips to `loc` verbatim
  };
}
```

And in `lib/typeChecker/types.ts` (transitional shape; `import type { DiagnosticName } from "./diagnostics.js"` is type-only — no runtime cycle with diagnostics.ts's type-only import of TypeCheckError):

```ts
export type TypeCheckError = {
  message: string;
  severity?: "error" | "warning"; // required after Task 4
  code?: string;                  // required after Task 4
  name?: DiagnosticName;          // required after Task 4
  params?: Record<string, string | number>; // required after Task 4
  file?: string;                  // stamped in TypeChecker.check() (Task 4)
  variableName?: string;          // DELETED in Task 4
  expectedType?: string;          // DELETED in Task 4
  actualType?: string;            // DELETED in Task 4
  loc?: SourceLocation;           // becomes `SourceLocation | null`, required, in Task 4
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/typeChecker/diagnostics.test.ts > /tmp/diag-task1-green.log 2>&1` — PASS. `npx tsc --noEmit -p . > /tmp/diag-task1-tsc.log 2>&1` — clean.

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/diagnostics.ts lib/typeChecker/diagnostics.test.ts lib/typeChecker/types.ts
git commit -m "Diagnostic registry, typed template params, and factory (no call sites yet)"
```

---

### Tasks 2-3: The sweep (file-by-file, every commit green)

**The transformation recipe, applied to every `errors.push` site:**

1. Copy the message string VERBATIM into a new registry entry; replace each
   interpolated `${expr}` with a named `{placeholder}`; pick the code from
   the file's category range (next free number).
2. Replace the pushed object literal with
   `diagnostic("<name>", { <placeholder>: <the exact same expr> }, <loc>)`.
3. Loc: pass the same loc the site used. If the site passed NONE, hunt the
   nearest AST node loc (alias/def nodes are withLoc-wrapped); only if no
   node is reachable, pass `null` AND add the site to the deliberate-null
   list in the registry doc comment (final list → PR body, per review).
4. Severity: config-resolved or explicit `"warning"` severities pass via
   `overrides`; otherwise the registry default carries it. `silent` still
   skips the push at the site.
5. Legacy fields (`variableName`/`expectedType`/`actualType`): DROP at the
   site — the values land in `params` (name them `name`, `expected`,
   `actual` so params read well).
6. Two sites emitting the SAME message shape share ONE registry entry.
7. **Conditionally-built messages** (ternary phrasing, appended hints):
   one registry entry PER PHRASING, selected by the same condition at the
   site. Params NEVER contain sentence fragments — they are structured
   data (review finding 4).

**Worked examples (each shape class):**

Simple interpolation (scopes.ts:118-123 — verified byte-identical to main by the review):

```ts
// before
ctx.errors.push({
  message: `Cannot reassign to constant '${node.variableName}'.`,
  variableName: node.variableName,
  loc: node.loc,
});
// after
ctx.errors.push(
  diagnostic("reassignToConst", { name: node.variableName }, node.loc ?? null),
);
```

Shared helper with computed params (scopes.ts `reportNotAssignable`):

```ts
// registry entry
typeNotAssignable: {
  code: "AG2001",
  severity: "error",
  message: "Type '{actual}' is not assignable to type '{expected}'.",
},
// after (inside reportNotAssignable)
ctx.errors.push(
  diagnostic(
    "typeNotAssignable",
    { actual: formatTypeHint(actual), expected: formatTypeHint(expected) },
    loc ?? null,
  ),
);
```

Previously loc-less site gains a real loc (index.ts type-param ordering; verify the loc field available at the site):

```ts
// before (NO loc)
this.errors.push({
  message: `Type parameter '${p.name}' (no default) must come before parameters that have defaults in '${name}'.`,
});
// after
this.errors.push(
  diagnostic("typeParamDefaultOrder", { param: p.name, alias: name }, entry.loc ?? null),
);
```

Config-driven severity (undefinedFunctionDiagnostic.ts):

```ts
ctx.errors.push(
  diagnostic("undefinedFunction", { name: fnName }, callNode.loc ?? null, {
    severity: resolvedSeverity,
  }),
);
```

### Task 2: Sweep batch A — shared helpers + core files

**Files:** `utils.ts` (FIRST — checkType/emitAssignabilityError feed many messages), `scopes.ts`, `index.ts`, `validate.ts`, `validateStaticInit.ts`, `staticInitRules.ts` (~34 sites).

- [ ] **Step 1:** Apply the recipe file-by-file, adding registry entries as encountered.
- [ ] **Step 2: Golden growth (review T11):** as their entries land, add factory goldens to `diagnostics.test.ts` for `typeNotAssignable` (multi-param, `formatTypeHint`-computed values) and one more high-traffic diagnostic from this batch — byte-for-byte against today's output.
- [ ] **Step 3:** After EACH file: `npx vitest run lib/typeChecker > /tmp/diag-task2-<file>.log 2>&1` — green with ZERO message-text churn (a failing message assertion means the template drifted: fix the template, not the test).
- [ ] **Step 4: Commit per file or per 2-3 files:**

```bash
git commit -m "Diagnostics sweep: utils, scopes, index, validate, static-init (batch A)"
```

### Task 3: Sweep batch B — the rest

**Files:** `synthesizer.ts`, `checker.ts`, `effectPayloadCheck.ts`, `interruptAnalysis.ts`, `undefinedFunctionDiagnostic.ts`, `undefinedVariableDiagnostic.ts`, `toolBlockBinding.ts`, `raisesDiagnostic.ts`, `matchExhaustiveness.ts`, `functionTypeRaises.ts`, `definiteReturns.ts` (~42 sites).

- [ ] **Step 1:** Same recipe. Config-driven sites use the override form.
- [ ] **Step 2: Config-severity verification (review T8):** for each of the four config-driven sites, VERIFY an existing test pins warn-mode output (a `severity: "warning"` assertion under warn config); add the pin where absent. Do not assume coverage — list the four verdicts in the PR body.
- [ ] **Step 3:** Add a config-driven golden to `diagnostics.test.ts` (completes the 3-4 goldens the spec asked for).
- [ ] **Step 4:** Per-file green runs (`/tmp/diag-task3-<file>.log`).
- [ ] **Step 5:** Sanity sweep: `grep -rn "errors.push({" lib/typeChecker --include="*.ts" | grep -v test` → ZERO raw object pushes remain.
- [ ] **Step 6: Commit** (per file or small groups).

---

### Task 4: The flip — required fields, legacy fields deleted, file stamping

**Files:** `lib/typeChecker/types.ts`, `lib/typeChecker/diagnostics.ts` (drop `loc ?? undefined`; flip the transitional test assertion to `.toBe(null)`), `lib/typeChecker/index.ts` (stamping), every file tsc flags.

- [ ] **Step 1: Flip the type:**

```ts
export type TypeCheckError = {
  code: string;
  name: DiagnosticName;
  message: string;
  severity: "error" | "warning";
  params: Record<string, string | number>;
  loc: SourceLocation | null; // null = deliberate file-level diagnostic
  file?: string;              // stamped once in TypeChecker.check()
};
```

- [ ] **Step 2: Let tsc enumerate the fallout** (`/tmp/diag-task4-tsc.log`): hand-constructed test errors → build via `diagnostic(...)` or a test-local helper; typed consumers of the deleted legacy fields → migrate to `err.params.<key>`, recording each in the PR body. **The `lib/compiler/typecheck.ts` / `TypeCheckDiagnostic` hit is NOT mechanical — it is Task 5 Step 4's public-API decision; when tsc flags it here, apply the Task 5 Step 4 change (or a temporary local mirror if you want this commit isolated, removed in Task 5).**
- [ ] **Step 3: Positive-evidence audit (review finding 7 — tsc misses `any`-typed and serialized consumers):**

```bash
grep -rn "variableName\|expectedType\|actualType" lib tests --include="*.ts" --include="*.json" > /tmp/diag-task4-legacy-grep.log
```

Triage the hits: parser/preprocessor/AST `variableName` fields are unrelated (same name, different type); anything reading these fields off a typecheck ERROR object (statelog events, test.json expectations, `any`-typed access) migrates or is recorded. Attach the triaged list to the PR body.
- [ ] **Step 4: File stamping.** At the end of `TypeChecker.check()`, before the dedup/suppression return (~index.ts:400). Nothing sets `file` before this point, so assign plainly (review anti-pattern 3 — no `?? ` guard defending an impossible case):

```ts
    const file = this.currentFile;
    if (file !== undefined) {
      for (const err of this.errors) {
        err.file = file;
      }
    }
```

- [ ] **Step 5:** Full green: `npx vitest run lib > /tmp/diag-task4-tests.log 2>&1` + tsc clean.
- [ ] **Step 6: Commit.**

---

### Task 5: Printer + public TypeCheckDiagnostic API + LLM-path audit

**Files:**
- Modify: `lib/typeChecker/index.ts` (`formatErrors`), `lib/cli/serve.ts:63,66`, `lib/compiler/buildSession.ts:648,652`, `lib/compiler/typecheck.ts` (TypeCheckDiagnostic), **`stdlib/agency.agency`** (TypeCheckReport)
- Test: `lib/typeChecker/formatErrors.test.ts` (new)

- [ ] **Step 1: Write the failing tests** (ANSI stripper includes the ESC byte — review must-fix 2; colors are UNCONDITIONAL in `color.red`):

```ts
import { describe, it, expect } from "vitest";
import { formatErrors } from "./index.js";
import { diagnostic } from "./diagnostics.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatErrors", () => {
  it("prints file:line:col - severity CODE: message (1-indexed display)", () => {
    const err = {
      ...diagnostic("reassignToConst", { name: "c" }, { line: 12, col: 8, start: 100, end: 110 }),
      file: "main.agency",
    };
    expect(plain(formatErrors([err]))).toBe(
      "main.agency:13:9 - error AG4005: Cannot reassign to constant 'c'.",
    );
  });

  it("a warning renders the word warning and its code", () => {
    // review T7: without this, swapping the severity branches breaks nothing
    const err = {
      ...diagnostic("reassignToConst", { name: "c" }, null, { severity: "warning" }),
      file: "main.agency",
    };
    expect(plain(formatErrors([err]))).toBe(
      "main.agency - warning AG4005: Cannot reassign to constant 'c'.",
    );
  });

  it("file-level (loc null) prints without position", () => {
    const err = { ...diagnostic("reassignToConst", { name: "c" }, null), file: "main.agency" };
    expect(plain(formatErrors([err]))).toBe(
      "main.agency - error AG4005: Cannot reassign to constant 'c'.",
    );
  });

  it("no file falls back to severity CODE: message", () => {
    const err = diagnostic("reassignToConst", { name: "c" }, null);
    expect(plain(formatErrors([err]))).toBe("error AG4005: Cannot reassign to constant 'c'.");
  });
});
```

(Display-col indexing: pin whichever the parser produces — verify against a known fixture before finalizing the `:9` expectation; adjust test AND implementation together.)

- [ ] **Step 2: Implement** (no nested ternary — review anti-pattern 1):

```ts
export function formatErrors(errors: TypeCheckError[]): string {
  return errors
    .map((err) => {
      const colorFunc = err.severity === "warning" ? color.yellow : color.red;
      let where = "";
      if (err.file && err.loc) {
        where = `${err.file}:${err.loc.line + 1}:${err.loc.col + 1} - `;
      } else if (err.file) {
        where = `${err.file} - `;
      }
      return `${where}${colorFunc(err.severity)} ${err.code}: ${err.message}`;
    })
    .join("\n");
}
```

Drop the dead `errorType` parameter; update the two `"warning"`-passing callers (serve.ts:66, buildSession.ts:652).

- [ ] **Step 3: LLM-path audit.** Read how the `typecheck` stdlib tool and the review agent consume checker output; fix any parse of the old `error:` shape; grep statelog emission for typecheck error text. Record findings in the PR body.
- [ ] **Step 4: Public API decision (review must-fix 3).** `TypeCheckDiagnostic` (lib/compiler/typecheck.ts:37) DROPS the legacy field mirrors and GAINS `code`, `severity`, and `params` — stable codes are exactly what the `writeAgency` review loop should key on. Update the public `TypeCheckReport` type in `stdlib/agency.agency:79` to match, with doc comments (docstrings become tool descriptions — keep them user-facing). Run `make`; take the regenerated stdlib doc changes for THIS type only (revert unrelated drift). This is a deliberate public stdlib API change — its own line in the PR body.
- [ ] **Step 5:** Green: `npx vitest run lib/typeChecker lib/compiler lib/cli > /tmp/diag-task5.log 2>&1` (tests asserting the old `error: message` shape change here — list them in the PR body).
- [ ] **Step 6: Commit.**

---

### Task 6: Suppression by code + dedup key

**Files:** `lib/typeChecker/suppression.ts` (+ test), `lib/typeChecker/index.ts:408-416` (dedup), the `@tc-ignore` docs page (grep `tc-ignore` under docs/).

**Directive semantics (decided now, per review T9 — each case pinned):**
- Bare `@tc-ignore`, or `@tc-ignore` followed by prose with NO code-shaped token → `"all"` (today's behavior, back-compat).
- Tokens matching `/^AG\d{4}$/` → suppress exactly those codes.
- A token that LOOKS like a code attempt but is malformed (`/^ag\d+$/i` failing the strict pattern — e.g. `AG201`, `ag2001`) → the user clearly meant to name codes: suppress NOTHING on that line (fail closed; a typo must not silently widen to suppress-everything).
- Mixed valid + junk (`AG2001 because reasons`) → the valid codes only.

- [ ] **Step 1: Write the failing tests** (append to suppression.test.ts, adapting to its helpers; all red on main — `ignoreLines` is a `Set` today):

```ts
const locOnLine1 = { line: 1, col: 0, start: 30, end: 40 };
const errWith = (code: string) => ({
  ...diagnostic("reassignToConst", { name: "x" }, locOnLine1),
  code,
});

it("@tc-ignore with codes suppresses only those codes on the next line", () => {
  const sup = parseSuppressions("// @tc-ignore AG2001, AG4005\nconst x = 1\n");
  expect(applySuppressions([errWith("AG2001")], sup)).toEqual([]);
  expect(applySuppressions([errWith("AG9999")], sup)).toHaveLength(1);
});

it("bare @tc-ignore still suppresses everything on the next line", () => {
  const sup = parseSuppressions("// @tc-ignore\nconst x = 1\n");
  expect(applySuppressions([errWith("AG2001")], sup)).toEqual([]);
});

it("trailing prose keeps the suppress-all meaning (back-compat)", () => {
  const sup = parseSuppressions("// @tc-ignore known false positive\nconst x = 1\n");
  expect(applySuppressions([errWith("AG2001")], sup)).toEqual([]);
});

it("a malformed code attempt suppresses NOTHING (fail closed)", () => {
  const sup = parseSuppressions("// @tc-ignore AG201\nconst x = 1\n");
  expect(applySuppressions([errWith("AG2001")], sup)).toHaveLength(1);
});

it("mixed valid codes and junk suppresses the valid codes only", () => {
  const sup = parseSuppressions("// @tc-ignore AG2001 because reasons\nconst x = 1\n");
  expect(applySuppressions([errWith("AG2001")], sup)).toEqual([]);
  expect(applySuppressions([errWith("AG4005")], sup)).toHaveLength(1);
});

it("a file-level (loc null) diagnostic is immune to @tc-ignore", () => {
  const sup = parseSuppressions("// @tc-ignore\nconst x = 1\n");
  const fileLevel = diagnostic("reassignToConst", { name: "x" }, null);
  expect(applySuppressions([fileLevel], sup)).toHaveLength(1);
});
```

And the dedup pins (both directions — review must-fix 1; unit-test the dedup function directly, exporting it as `_dedupeForTest` if needed):

```ts
it("two different codes at the same position both survive dedup", () => {
  const a = { ...errWith("AG2001") };
  const b = { ...errWith("AG4005"), message: a.message }; // same message + position
  expect(_dedupeForTest([a, b])).toHaveLength(2);
});

it("same code with different params at the same position both survive dedup", () => {
  // regression guard for the code+start key bug the plan review caught
  const a = { ...errWith("AG2001"), message: "Type 'string' is not assignable to type 'number'." };
  const b = { ...errWith("AG2001"), message: "Type 'string' is not assignable to type 'boolean'." };
  expect(_dedupeForTest([a, b])).toHaveLength(2);
});

it("identical code, message, and position collapse to one", () => {
  expect(_dedupeForTest([errWith("AG2001"), errWith("AG2001")])).toHaveLength(1);
});
```

- [ ] **Step 2: Implement.**

```ts
export type Suppressions = {
  nocheck: boolean;
  /** line -> "all" (bare directive / prose only) or the specific codes. */
  ignoreLines: Record<number, "all" | string[]>;
};
```

`parseSuppressions`: capture the directive tail; tokenize on `/[\s,]+/`; valid codes = `/^AG\d{4}$/` matches; malformed attempts = `/^ag\d+$/i` matches that fail the strict pattern. Rules: any malformed attempt → store `[]` (suppresses nothing); else valid codes if any; else `"all"`.

`applySuppressions` (braced, per repo rules):

```ts
export function applySuppressions(
  errors: TypeCheckError[],
  suppressions: Suppressions,
): TypeCheckError[] {
  if (suppressions.nocheck) {
    return [];
  }
  return errors.filter((e) => {
    if (e.loc === null) {
      return true; // file-level: not line-suppressible (documented)
    }
    const rule = suppressions.ignoreLines[e.loc.line];
    if (rule === undefined) {
      return true;
    }
    if (rule === "all") {
      return false;
    }
    return !rule.includes(e.code);
  });
}
```

Dedup key (review must-fix 1 — code alone would collapse same-code different-params errors that survive today):

```ts
const key = `${err.code}:${err.message}:${err.loc?.start ?? -1}`;
```

- [ ] **Step 3:** Green (`/tmp/diag-task6.log`). Update the `@tc-ignore` docs page: code-scoped syntax, the fail-closed malformed-token rule, AND the deliberate behavior change (errors that gained locations are now suppressible by pre-existing bare `@tc-ignore` comments — review finding 5).
- [ ] **Step 4: Commit.**

---

### Task 7: Location audit, full verification, follow-up issue, PR

- [ ] **Step 1: Location-audit suite (review T5 — the spec's test #6, previously missing).** Create `lib/typeChecker/diagnosticLocations.test.ts`: for EACH site that was loc-less on main (enumerated during the sweep; known members: index.ts type-param ordering, reserved-type-name loop, alias-validation loop), a minimal source snippet triggering it, asserting the emitted diagnostic has `loc !== null` — except sites on the deliberate-null list, which are asserted `loc === null` (so removing a null-site justification is a test diff, not a drift). Shape:

```ts
it("type-param ordering error carries a location", () => {
  const errs = checkSource("type Pair<A = string, B> = { a: A, b: B }");
  const hit = errs.find((e) => e.name === "typeParamDefaultOrder");
  expect(hit).toBeDefined();
  expect(hit?.loc).not.toBe(null);
});
```

(`checkSource` = the file-local parse+typeCheck helper pattern from matchExpression.test.ts.)
- [ ] **Step 2: End-to-end stamping pin (review T6).** Compile a source WITH AN EXPLICIT sourcePath (no synthesized tempdir paths — deterministic output) producing two known errors; assert the full two-line formatted block including the `file:line:col` prefixes. Document in the test that THIS is the file-stamping test.
- [ ] **Step 3: Build + linter + full lib suite.**

```bash
make > /tmp/diag-task7-make.log 2>&1
pnpm run lint:structure > /tmp/diag-task7-lint.log 2>&1
npx vitest run lib > /tmp/diag-task7-tests.log 2>&1
```
All clean. If the recurring make/test artifacts appear (`docs/site/stdlib/data/usaspending.md` drift beyond the intended TypeCheckReport docs, `a.vs.b.verdict.json`), revert/delete them — they are build artifacts, keep only the Task 5 stdlib-doc change.
- [ ] **Step 4: File the emit-once follow-up issue** (label `typechecker`): part 4 of #474 — pure synth, emission confined to check passes, deletes the flowEnv-silent gate and the dedup band-aid; note the dedup-key upgrade shipped here.
- [ ] **Step 5: Commit spec + plan + review docs; push; open the PR.** Body checklist (each its own section):
  - `Closes #474`; registry/factory design; byte-identical-messages gate result.
  - **The deliberate-null `loc` list** (review finding 6 — the review gate moves here).
  - **Named behavior changes:** bare `@tc-ignore` now reaches errors that gained locations; malformed code tokens fail closed; the public `TypeCheckReport`/`TypeCheckDiagnostic` shape change (legacy fields → code/severity/params).
  - Consumer audits: Task 4 tsc + grep triage, Task 5 LLM-path findings, the four config-severity coverage verdicts (T8).
  - Tests changed for the new output format (listed).
  - Residual risk (review T11): the zero-churn gate is only as strong as existing message-assertion coverage; the `${` tripwire and goldens close the worst classes.
  - Scope-outs: emit-once → new issue #NNN, `agency explain`, parser-side errors, LSP.

---

## Self-review notes (rev 2)

- All review must-fixes and should-fixes applied: dedup key carries message (1), ANSI stripper carries `\x1b` (2), TypeCheckDiagnostic/stdlib public-API change is Task 5 Step 4 with the #514 coordination check in setup (3), recipe step 7 for conditional phrasing (4), behavior-change documentation in Task 6 Step 3 + PR body (5), null-list review gate moved to the PR body (6), legacy-field grep in Task 4 Step 3 (7), anti-pattern fixes transcribed into all code blocks (8), and T1-T11 test findings folded into Tasks 1, 2, 3, 5, 6, 7 (9).
- Review nit adopted with correction: inventory says 76 sites (matches the list sum). The usaspending/verdict cleanup line is kept but reworded as conditional — these are recurring post-build artifacts (observed in five consecutive worktrees), not repo files; the reviewer checked a fresh status, where they correctly do not exist.
- `name: DiagnosticName` restored per the review nit, with the type-only-import justification written into the Task 1 text.
- Directive semantics for malformed codes are now a DECIDED, pinned behavior (fail closed) rather than an accident of the tokenizer.
