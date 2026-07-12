# Diagnostic explanations: CLI lookup, generated docs, agent knowledge

**Follow-on to #474 / PR #517** (the codes + registry). Owner-approved scope
decisions (2026-07-11): all ~70 codes get explanations in v1 (the coverage
guarantee is compile-time and only exists if required from day one); compile
output gains a one-line discovery hint; docs generation is a BUILD script,
not a user-facing command.

## The content model (what exists per diagnostic)

Two pieces of authored content per code — everything else is rendering:

1. **The message template** (exists, in `DIAGNOSTICS`): the one-liner the
   user sees rendered in every error. Also reused verbatim as the code's
   one-line summary in `diagnostics list` and the docs index.
2. **The long explanation** (new): markdown prose — what the error means,
   why it fires, how to fix it. Convention: one short paragraph of
   what/why, then fix guidance; 2-4 sentences for most codes, longer for
   the high-traffic ones (assignability, undefined names, strict member
   access, exhaustiveness). May include a small Agency example (correct
   syntax per docs/site/guide/basic-syntax.md — verify snippets parse).

The **hint line** is not content: it is one trailing line after a failed
check advertising the lookup, naming the first error-severity code:

```
Run 'agency explain AG2001' for an explanation.
```

## Where the explanations live (Approach B — approved)

New file `lib/typeChecker/diagnosticExplanations.ts`:

```ts
import type { DiagnosticName } from "./diagnostics.js";

/** Long-form explanation per diagnostic, in markdown. EXHAUSTIVE by type:
 *  adding a registry entry without an explanation is a compile error. */
export const DIAGNOSTIC_EXPLANATIONS: Record<DiagnosticName, string> = {
  typeNotAssignable: `The value on the right has a type the target cannot
hold. [...] **How to fix:** [...]`,
  // ... one entry per DiagnosticName
};
```

- `Record<DiagnosticName, string>` is the coverage guarantee.
- A future retired/deprecated registry entry still demands an explanation
  here — correct, since the docs keep explaining a code users may still see
  from older compilers. Note this in the file's header comment so nobody
  "cleans it up."
- The registry (`diagnostics.ts`) stays lean — machine data only.
- Rejected alternatives: inline `explanation` fields (drowns the registry
  in prose); markdown files as source (runtime file reads in the CLI,
  exhaustiveness degrades to a test).

Category ranges become DATA (they are prose in the registry header today),
so the generator and CLI share one source:

```ts
// in diagnostics.ts
export const DIAGNOSTIC_CATEGORIES = [
  { prefix: "AG1", slug: "types-aliases", title: "Types and aliases" },
  { prefix: "AG2", slug: "checking", title: "Assignability and checking" },
  { prefix: "AG3", slug: "effects", title: "Interrupts, effects, and handlers" },
  { prefix: "AG4", slug: "names", title: "Names, scope, and reserved words" },
  { prefix: "AG5", slug: "match", title: "Match and narrowing" },
  { prefix: "AG6", slug: "tools", title: "Calls, tools, and LLM usage" },
  { prefix: "AG7", slug: "static-init", title: "Static init, config, and imports" },
] as const;
```

## Surface 1: the CLI

**Command name: `agency explain`, NOT `agency diagnostics`.** `agency
diagnostics` already exists (`scripts/agency.ts:808`) — a VSCode-facing
command taking `[inputs...]` that parses each file and prints `TarsecError`
JSON. Grafting `code`/`list` subcommands onto it would break its
positional-input contract. `agency explain <code>` is collision-free, is the
name the #474 spec originally reserved for this feature, and reads better in
the hint line.

`agency explain` command family in `scripts/agency.ts`:

- **`agency explain <code>`** — accepts an `AG####` code (case-insensitive)
  or a registry name (`typeNotAssignable`). Prints, with termcolors: the
  code and name, default severity, the message template, and the
  explanation. Reads the compiled-in tables — no file I/O. Unknown code:
  exit 1 with `Unknown diagnostic code 'AG9999'. Run 'agency explain --list'
  to see all codes.`
- **`agency explain --list`** (also `agency explain` with no argument) — a
  table of every code, sorted, with its message template as the one-line
  summary, grouped under the category titles.

Rendering lives in a testable helper (`renderDiagnosticText(codeOrName)` and
`renderDiagnosticList()` in a small `lib/cli/explain.ts`), the commander
action being a thin wrapper — the repo's push-logic-out-of-CLI convention.

## Surface 2: generated docs (build script, NOT a user command)

`scripts/generateDiagnosticsDocs.ts`, compiled to `dist/scripts/` like
`stdlib-stamp`, invoked from the Makefile next to the `doc` target:

```
node ./dist/scripts/generateDiagnosticsDocs.js docs/site/diagnostics/
```

Regenerates the whole directory each run (one fast node invocation — no
stamp machinery). Output:

- `docs/site/diagnostics/index.md` — intro (what codes are, the
  suppression syntax `// @tc-ignore AG####`, the `agency explain <code>`
  lookup), then one
  table per category: Code | Message, each code linking to its section.
- One page per category (`types-aliases.md`, `checking.md`, `effects.md`,
  `names.md`, `match.md`, `tools.md`, `static-init.md`): a `## AG2001 —
  <message template>` section per code with the default severity and the
  explanation.

Seven category pages (not 70 per-code pages) is deliberate: it matches how
the agent's flat docs tool lists pages (surface 3), and category pages read
well for humans browsing.

## Surface 3: agent knowledge

Mirrors the existing guide/cli pipeline exactly:

1. Makefile `stage-stdlib-docs` adds:
   `rm -rf stdlib/docs/diagnostics` + `cp -r docs/site/diagnostics
   stdlib/docs/diagnostics` (ordering: generation runs before staging).
2. `_docsDir` (lib/stdlib/skills.ts) and `docsSkill` (stdlib/skills.agency)
   widen their section union to `"guide" | "cli" | "diagnostics"`; the
   docstring gains one line describing the section (docstrings are
   tool descriptions — keep it user-facing).
3. ALL FOUR docsSkill-bearing subagents wire
   `static const diagnosticsSkill = docsSkill("diagnostics")` next to their
   existing guide/cli tools:
   - `subagents/oracle.agency` (guide + cli today)
   - `subagents/research.agency`
   - `subagents/code.agency` — the one that runs `typecheck` and fixes type
     errors; it needs the diagnostics pages most of all
   - `subagents/explorer.agency`

   Wiring all four (not just oracle/research) is deliberate: the code
   subagent is the primary consumer, and the pattern is identical across
   all four sites.

The agent's code tool already returns structured `code` values from
`typecheck` (PR #517), and the review agent execs the CLI — both see the
hint line or the codes, and can then read the diagnostics pages on demand.

## The hint line

One trailing line, appended AFTER the formatted error block, naming the
first **error-severity** diagnostic's code — `errors.find(e => e.severity
=== "error")`, NOT `errors[0]`. The array can lead with a warning (warning
at line 2, error at line 9); `errors[0]` would name the warning's code while
claiming errors exist, contradicting the "warnings-only gets no hint" rule.
Emitted by a helper exported next to `formatErrors`
(`formatDiagnosticsHint(errors): string | null` — null when no error-severity
diagnostic is present), so the wording lives in one place. The hint must go
to the same stream as the error block (`console.error` at the typecheck
action) so an agent capturing stderr sees both. Wired at the
human/agent-facing print sites only:

- the `agency typecheck` command action (scripts/agency.ts), and
- the buildSession compile-failure print (lib/compiler/buildSession.ts).

NOT inside `formatErrors` itself — programmatic consumers (`compile.ts`
returning error strings, serve.ts warnings) are untouched. Warnings-only
output gets no hint (hint fires when at least one error exists).

## Tests

1. **Coverage:** compile-time via the exhaustive Record. Runtime pins:
   every explanation is non-empty, contains no `${...}` leakage and no
   unrendered `{placeholder}` outside code spans (reuse the SAME
   well-formedness check from `diagnostics.test.ts`, honoring the `{{...}}`
   escape convention — do not write a second, subtly different regex), and
   is at least ~100 characters (a floor against one-word stubs).
2. **Snippet parsing:** extract every fenced code block tagged as Agency
   from every explanation and run `parseAgency` on it — the same content
   flows into the generated category pages, so this gates both. Given this
   repo's documented history of Agency-syntax mistakes in prose, ~70
   hand-written entries will otherwise accumulate broken snippets; this
   converts the authoring convention into a mechanical gate.
3. **Code↔category coverage, in the REGISTRY suite:** every code's `AG#`
   prefix matches exactly one `DIAGNOSTIC_CATEGORIES` entry. This is a
   registry-shaped invariant, so it lives next to the existing
   uniqueness/format pins in `diagnostics.test.ts` — a new AG8xxx code
   without a category entry then fails there with a message that says what
   to do, rather than surfacing later as a docs-generator bug.
4. **CLI helper:** `renderDiagnosticText("AG2001")` and
   `renderDiagnosticText("typeNotAssignable")` return the same text and
   include the template + explanation; unknown input returns the
   error-with-suggestion; `renderDiagnosticList()` contains every code
   exactly once.
5. **Generator invariants (unit-test the generation functions on an
   in-memory result, then one filesystem smoke test):** index lists every
   code exactly once with a link; each code appears on exactly one category
   page; heading anchors are unique. (The prefix-membership invariant itself
   lives in the registry suite per test 3.)
6. **Hint line:** typecheck-command path emits the hint naming the first
   error-severity code when errors exist; no hint on success or
   warnings-only; and — the discriminating case — a list LEADING with a
   warning followed by an error emits a hint naming the ERROR's code, not
   the warning's.
7. **Wiring smoke:** after `make`, `stdlib/docs/diagnostics/index.md`
   exists (asserted in CI by make itself; the plan adds a cheap existence
   test to the skills tests if one fits the existing pattern).

## Non-goals

- Parser errors (still code-less — same boundary as #474/#517).
- Rewording any message template (that is #518; explanations MAY note an
  awkward wording and its planned fix).
- Website navigation/sidebar work beyond writing the files into
  docs/site/diagnostics/.
- Localization; per-code URL pages; `agency doc` integration (diagnostics
  docs are generated from OUR registry by OUR build — never user-run).

## Estimated size

Plumbing ~1.5-2 days (explanations table + CLI family + generator script +
Makefile/staging + docsSkill union + subagent wiring + hint line + tests),
plus roughly a day of explanation writing (~70 entries, calibrated).
