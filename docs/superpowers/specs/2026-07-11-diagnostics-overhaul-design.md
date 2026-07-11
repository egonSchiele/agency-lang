# Diagnostics overhaul: codes, severity, spans, template registry (issue #474)

**Issue:** #474 — stable error codes, required severity, full spans, emit-once
discipline. **Scope of this spec: the first three, plus the message-template
registry (owner chose Approach 3 over code-only registry).** Emit-once /
pure-synth (issue part 4) is a follow-up: this PR closes #474 and files a
focused issue for it. Also deferred by owner decision: `agency explain <code>`
and long how-to-fix texts (fast-follow once codes settle; the registry this PR
creates is where they will live).

## Problem (verified against main, 2026-07-11)

`TypeCheckError` is a message string plus optional everything:

- No codes: suppression (`@tc-ignore`) is all-or-nothing per line; tests
  assert on message wording (rewording breaks tests); no place to hang
  per-error documentation.
- `severity` optional, "missing means error" — the `?? "error"` convention
  already caused one real bug (downstream read `err.severity` directly).
- Many of the 76 `errors.push` sites (15 files) pass no `loc` at all, and
  loc-less errors are BOTH unlocatable for users AND invisible to
  `@tc-ignore` (`applySuppressions` keeps `!e.loc` errors unconditionally).
  `SourceLocation` already carries full spans (`line/col/start/end`) — the
  gap is sites that do not pass it, not the type.
- The printer (`formatErrors`) shows `error: <message>` — no file, no line,
  even when a loc exists. PR #510's `loc: undefined` regression is the live
  exhibit: nothing in the types stops a diagnostic from shipping without a
  position.

## Design

### 1. The diagnostic registry (single source of truth)

New file `lib/typeChecker/diagnostics.ts`. Every diagnostic the checker can
emit is one entry, keyed by a descriptive name, carrying its code, default
severity, and message TEMPLATE:

```ts
export const DIAGNOSTICS = {
  typeNotAssignable: {
    code: "AG2001",
    severity: "error",
    message: "Type '{actual}' is not assignable to type '{expected}'.",
  },
  undefinedVariable: {
    code: "AG4002",
    severity: "error",
    message: "Variable '{name}' is not defined.",
  },
  reassignToConst: {
    code: "AG4005",
    severity: "error",
    message: "Cannot reassign to constant '{name}'.",
  },
  // ... one entry per distinct diagnostic (~50-70 expected from 76 sites;
  // some sites share a diagnostic)
} as const;

export type DiagnosticName = keyof typeof DIAGNOSTICS;
```

Uniqueness of names is free (object keys). Uniqueness of CODES is enforced by
a registry unit test (codes are data, not keys). The registry is append-only:
a shipped code is never renumbered or reused; a retired diagnostic keeps its
entry with a `retired: true` marker so the code stays reserved.

Numbering: category ranges, assigned during the sweep — AG1xxx types/aliases,
AG2xxx assignability/checking, AG3xxx interrupts/effects/handlers, AG4xxx
names/scope/reserved/const, AG5xxx match/narrowing/exhaustiveness, AG6xxx
tools/llm/blocks, AG7xxx static-init/config/imports. Ranges are documentation,
not machinery — nothing parses them.

### 2. The factory (sites stop hand-writing messages)

```ts
export function diagnostic<N extends DiagnosticName>(
  name: N,
  params: DiagnosticParams<N>,
  loc: SourceLocation | null,
  overrides?: { severity?: "error" | "warning" },
): TypeCheckError;
```

- `DiagnosticParams<N>` is derived from the entry's template via template
  literal types (extract `{placeholder}` names), so forgetting or misnaming a
  parameter is a COMPILE error at the call site. If the type machinery fights
  TS (perf or inference), the documented fallback is
  `Record<string, string | number>` params plus a registry test that renders
  every template with dummy params and asserts no `{...}` survives — decide
  in the plan, prefer the typed version.
- `overrides.severity` exists because several diagnostics are config-driven
  (strict member access, match exhaustiveness, undefined functions/variables:
  `silent | warn | error`). The registry carries the DEFAULT; config-driven
  sites pass the resolved severity; `silent` stays handled at the site (skip
  the push entirely), unchanged.
- A site becomes:

```ts
// before
ctx.errors.push({
  message: `Cannot reassign to constant '${node.left.value}'.`,
  variableName: node.left.value,
  loc: node.loc,
});
// after
ctx.errors.push(
  diagnostic("reassignToConst", { name: node.left.value }, node.loc ?? null),
);
```

### 3. The error shape

```ts
export type TypeCheckError = {
  code: string;                       // e.g. "AG4005" (from the registry)
  name: DiagnosticName;               // registry key, for programmatic use
  message: string;                    // RENDERED template — byte-identical to today
  severity: "error" | "warning";     // REQUIRED
  loc: SourceLocation | null;         // REQUIRED; null = deliberate file-level
  file?: string;                      // stamped once in TypeChecker.check()
  params: Record<string, string | number>; // the structured payload
};
```

- `loc: SourceLocation | null` — omission becomes impossible; `null` is a
  deliberate, greppable statement that a diagnostic is file-level (reserved
  names, alias-loop declarations where no node is in reach). The sweep fills
  real locations everywhere an AST node exists; the plan lists every
  remaining `null` site explicitly so the review can challenge each one.
- `file` is stamped once onto all errors at the end of `TypeChecker.check()`
  from `ctx.currentFile` (one checker instance = one file) — not threaded
  through 76 sites.
- `params` replaces the ad-hoc `variableName`/`expectedType`/`actualType`
  fields as the structured payload. Plan-time audit: every consumer of those
  three fields (tests, tooling) migrates to `params` or, if a production
  consumer needs them, they stay as deprecated aliases populated by the
  factory. Intent: they go.

### 4. Output format

`formatErrors` upgrades (display line/col are 1-indexed; `loc.line` is
0-indexed per docs/dev/locations.md):

```
main.agency:13:7 - error AG2001: Type 'string' is not assignable to type 'number'.
main.agency - error AG1203: Type parameter 'T' (no default) must come before parameters that have defaults in 'Pair'.
```

(Second line: a file-level `loc: null` diagnostic.) Colors as today: severity
word colored, rest plain.

### 5. Suppression by code

`parseSuppressions` extends: bare `// @tc-ignore` keeps today's meaning
(suppress everything on the next line); `// @tc-ignore AG2001, AG2005`
suppresses only those codes. `@tc-nocheck` unchanged. `applySuppressions`
matches on `error.code`. Errors with `loc: null` remain un-suppressible by
`@tc-ignore` (nothing to line-match) — unchanged from today, now documented.

### 6. Dedup key upgrade

`deduplicateErrors()` stays (it is the emit-once band-aid until part 4), but
its key becomes `code + loc.start` instead of `message + loc.start` — two
different diagnostics sharing a message and position no longer collapse.

## Behavior-preservation gate (the safety rail)

Every template is extracted VERBATIM from its current message string, so all
rendered messages are byte-identical to today's. Acceptance: the full
existing lib suite passes with changes ONLY to (a) tests that construct
`TypeCheckError` values by hand (new required fields) and (b) tests that
assert on `formatErrors` output (new format). Zero message-wording churn. Any
site whose message must change to fit a template is a plan deviation to
record, not a silent edit.

## Known break-risk audit (plan-time)

Anything that string-matches today's output: the agent's compile-feedback
path (compile errors are fed back to the LLM as text — the NEW format is
strictly more useful there, but the consumption sites need eyeballing),
statelog error events, `lib/compiler/compile.ts` / `buildSession.ts` /
`serve.ts` (all call `formatErrors`), and tests asserting on the `error:`
prefix. The plan enumerates these with greps before the sweep starts.

## Non-goals

- Emit-once / pure synth (part 4): follow-up issue, filed when this merges.
- `agency explain <code>` + long how-to-fix texts: fast-follow (owner call).
- Mass-migrating existing test assertions from message-matching to codes:
  messages do not change, so nothing forces it; migrate opportunistically.
- Parser-side errors (TarsecError/parseError messages): out of scope — this
  is the TYPE CHECKER's diagnostic system. A future increment can extend
  codes to parse errors on the same registry.
- LSP integration itself (the spans make it possible; building it is not
  this PR).

## Tests (red-first)

1. **Registry invariants:** all codes unique; all codes match `AG\d{4}`;
   every template's placeholders render (no `{...}` left after formatting
   with the factory); registry is importable without cycles.
2. **Factory:** renders byte-identical messages for 3-4 representative
   diagnostics (golden strings copied from today's output); severity
   override wins over registry default; params land on the error object.
3. **Printer:** `file:line:col - severity CODE: message` for a located
   error; `file - severity CODE: message` for a `loc: null` error;
   1-indexing pinned against a known-position fixture.
4. **Suppression:** bare `@tc-ignore` suppresses all (regression pin);
   `@tc-ignore AG2001` suppresses only AG2001 on the next line (red on
   main); unknown codes in the directive are ignored (not an error).
5. **Dedup:** two different codes at the same position both survive (red on
   main with a same-message construction); same code+position collapses.
6. **Location audit:** for each site currently pushing without a loc, a pin
   that the diagnostic now carries one (or is on the explicit `null` list).
7. **End-to-end:** one compile of a multi-error file asserting the full
   formatted output block.

## Estimated size

Bigger than the code-only variant by design: registry (~60 entries), factory
+ param typing, 76-site sweep across 15 files, printer, suppression, dedup,
consumer audit. 4-6 days. Natural commit seams: registry+factory+type first
(compiler then finds every site), then per-file sweeps, then
printer/suppression/dedup, then audits.
