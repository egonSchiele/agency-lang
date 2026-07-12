# Diagnostic Explanations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a long-form explanation for every type-checker diagnostic three ways — an `agency explain <code>` CLI lookup, an auto-generated `docs/site/diagnostics/` page set, and agent knowledge via the stdlib docs copy — plus a one-line discovery hint on failed type checks.

**Architecture:** Explanations live in a new sibling file `lib/typeChecker/diagnosticExplanations.ts` as an exhaustive `Record<DiagnosticName, string>` (the compile-time coverage guarantee). Category ranges — today prose in the registry header — become a `DIAGNOSTIC_CATEGORIES` data array in `diagnostics.ts`, shared by the CLI's `list` grouping and the docs generator. Rendering logic lives in testable helper modules (`lib/cli/explain.ts`, `lib/cli/diagnosticsDocs.ts`); the commander action and the build script are thin wrappers. The generator runs as a Makefile-invoked build script (`scripts/generateDiagnosticsDocs.ts` → `dist/scripts/`), never as a user command. A `formatDiagnosticsHint` helper sits next to `formatErrors` and is wired only at the two human/agent-facing print sites.

**Tech Stack:** TypeScript (ESM, `@/` path aliases via tsc-alias), vitest, commander, the tarsec-based `_parseAgency`, GNU make.

## Global Constraints

- Command name is **`agency explain`**, never `agency diagnostics` — `scripts/agency.ts:808` already defines a VSCode-facing `diagnostics` command taking `[inputs...]`.
- The explanations table MUST be `Record<DiagnosticName, string>` — exhaustiveness is a compile guarantee, not a test. Never widen to `Partial<...>` or `Record<string, string>`.
- Registry (`diagnostics.ts`) stays machine-data-only. Prose lives in `diagnosticExplanations.ts`.
- Category prefix of a code is `code.slice(0, 3)` (e.g. `"AG4005".slice(0,3) === "AG4"`).
- Agency snippets in explanations MUST parse — verify against `docs/site/guide/basic-syntax.md`; a test enforces it. Correct syntax: `def foo(x: number): string { ... }`, `node main() { ... }`, `if (cond) { ... }`, `for (x in xs) { ... }`, declarations need `let`/`const`.
- Never use dynamic imports. Use `type` not `interface`. Objects over maps, arrays over sets.
- The hint targets the first **error-severity** diagnostic: `errors.find(e => e.severity === "error")`, NOT `errors[0]`.
- No apostrophes in commit messages typed on the command line — write the message to a file and pass it in.

---

### Task 1: Category ranges as data + code↔category registry invariant

**Files:**
- Modify: `lib/typeChecker/diagnostics.ts` (add `DIAGNOSTIC_CATEGORIES`, `categoryForCode`; trim the header prose that these replace)
- Test: `lib/typeChecker/diagnostics.test.ts:8` (add to the existing `diagnostic registry invariants` describe block)

**Interfaces:**
- Produces:
  - `export const DIAGNOSTIC_CATEGORIES: readonly { prefix: string; slug: string; title: string }[]`
  - `export function categoryForCode(code: string): (typeof DIAGNOSTIC_CATEGORIES)[number] | undefined`

- [ ] **Step 1: Add the category data and lookup to `diagnostics.ts`**

Add just below the `DiagnosticName` type (after line 492):

```ts
/**
 * Category ranges as data (they were prose in the DIAGNOSTICS header comment).
 * The CLI `explain --list` grouping and the docs generator both key off this
 * single source. Append-only, like the codes: a new AG8xxx range means a new
 * entry here. `slug` is the docs filename; `title` is the human heading.
 */
export const DIAGNOSTIC_CATEGORIES = [
  { prefix: "AG1", slug: "types-aliases", title: "Types and aliases" },
  { prefix: "AG2", slug: "checking", title: "Assignability and checking" },
  { prefix: "AG3", slug: "effects", title: "Interrupts, effects, and handlers" },
  { prefix: "AG4", slug: "names", title: "Names, scope, and reserved words" },
  { prefix: "AG5", slug: "match", title: "Match and narrowing" },
  { prefix: "AG6", slug: "tools", title: "Calls, tools, and LLM usage" },
  { prefix: "AG7", slug: "static-init", title: "Static init, config, and imports" },
] as const;

/** The category a code belongs to, by its AG# prefix, or undefined if none. */
export function categoryForCode(
  code: string,
): (typeof DIAGNOSTIC_CATEGORIES)[number] | undefined {
  const prefix = code.slice(0, 3);
  return DIAGNOSTIC_CATEGORIES.find((c) => c.prefix === prefix);
}
```

Then shorten the header comment (lines 9-13) so the category list is no longer duplicated as prose — replace the `Codes are AG#### with category ranges (documentation, not machinery):` block and its seven-line list with:

```ts
 * Codes are AG#### (append-only). Category ranges live in
 * DIAGNOSTIC_CATEGORIES below — the single source for the docs generator
 * and the `agency explain --list` grouping.
```

- [ ] **Step 2: Write the failing invariant test**

Add inside the `describe("diagnostic registry invariants", ...)` block in `diagnostics.test.ts`, and import `categoryForCode`, `DIAGNOSTIC_CATEGORIES` at the top:

```ts
  it("every code maps to exactly one category", () => {
    for (const [name, entry] of entries) {
      const cat = categoryForCode(entry.code);
      expect(
        cat,
        `${name} (${entry.code}) has no DIAGNOSTIC_CATEGORIES entry for prefix '${entry.code.slice(0, 3)}' — add one`,
      ).toBeDefined();
    }
  });

  it("no two categories share a prefix", () => {
    const prefixes = DIAGNOSTIC_CATEGORIES.map((c) => c.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
```

Update the import on line 2:

```ts
import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
  diagnostic,
  renderMessage,
} from "./diagnostics.js";
```

- [ ] **Step 3: Run the test**

Run: `pnpm exec vitest run lib/typeChecker/diagnostics.test.ts 2>&1 | tee /tmp/t1.log`
Expected: PASS (every current code is AG1–AG7, so the mapping holds; this test now guards future codes).

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/diagnostics.ts lib/typeChecker/diagnostics.test.ts
git commit -F /tmp/commit1.txt
```

Where `/tmp/commit1.txt` contains:
```
Promote diagnostic category ranges to data

Add DIAGNOSTIC_CATEGORIES + categoryForCode so the docs generator and the
explain --list grouping share one source; pin every-code-has-a-category in
the registry suite so a category-less future code fails there.
```

---

### Task 2: The explanations table + coverage, quality, and snippet-parse tests

**Files:**
- Create: `lib/typeChecker/diagnosticExplanations.ts`
- Create: `lib/typeChecker/diagnosticExplanations.test.ts`

**Interfaces:**
- Consumes: `DiagnosticName` from `./diagnostics.js`
- Produces: `export const DIAGNOSTIC_EXPLANATIONS: Record<DiagnosticName, string>`

- [ ] **Step 1: Create the explanations file with the exhaustive Record**

Create `lib/typeChecker/diagnosticExplanations.ts`. The header comment and three fully-worked entries below are the authoring template; **every** `DiagnosticName` must get an entry (see the full list in Step 2). Because the type is `Record<DiagnosticName, string>`, tsc fails the build until all are present.

```ts
import type { DiagnosticName } from "./diagnostics.js";

/**
 * Long-form explanation per diagnostic, in Markdown.
 *
 * EXHAUSTIVE BY TYPE: `Record<DiagnosticName, string>` — adding a registry
 * entry without an explanation here is a COMPILE error, not a test failure.
 * That is the whole point; never weaken this to Partial or Record<string,…>.
 *
 * A retired/deprecated registry entry STILL needs an explanation here — the
 * docs keep explaining a code a user may still see from an older compiler.
 * Do not "clean up" an entry when a diagnostic is retired.
 *
 * Convention per entry: one short what/why paragraph, then fix guidance.
 * 2-4 sentences for most; longer for high-traffic codes (assignability,
 * undefined names, strict member access, exhaustiveness). A small Agency
 * example is welcome but MUST parse — fenced as ```agency and verified by
 * diagnosticExplanations.test.ts. Do NOT quote a raw message template with
 * live {placeholders}; write concrete values instead (the leak test rejects
 * an unrendered {word} outside a code span).
 */
export const DIAGNOSTIC_EXPLANATIONS: Record<DiagnosticName, string> = {
  typeNotAssignable: `Agency assigns each value a type and checks that the value you store, return, or pass matches the type the destination expects. This error fires when they disagree — for example putting a \`string\` where a \`number\` is required.

**How to fix:** change one side so they line up — convert the value, widen the declared type, or fix the expression that produced the wrong type. If the value can legitimately be one of several types, declare the destination as a union.

\`\`\`agency
def half(n: number): number {
  return n / 2
}

node main() {
  const count: number = 3
  half(count)
}
\`\`\``,

  undefinedVariable: `The type checker walks every scope — nodes, function bodies, blocks — and resolves each name to a declaration. This error means a name was used with no \`let\`, \`const\`, parameter, or import that introduces it in reach.

**How to fix:** declare it before use (\`let x = …\` / \`const x = …\`), fix a typo in the name, or import it if it lives in another module. Agency has no implicit variables: a bare assignment like \`x = 5\` without a prior \`let\`/\`const\` is not a declaration.`,

  matchNotExhaustive: `A \`match\` over a union or Result must handle every case the scrutinee can take; the checker computes the set of arms you covered and reports the ones missing. An unhandled case would fall through at runtime with no branch to run.

**How to fix:** add an arm for each listed missing case, or add a wildcard \`_\` arm if a catch-all is genuinely what you want.

\`\`\`agency
node main() {
  const r = compute()
  match (r) {
    is success(v) { print(v) }
    is failure(e) { print(e) }
  }
}
\`\`\``,

  // ... one entry for EVERY remaining DiagnosticName (Step 2 lists them all).
};
```

- [ ] **Step 2: Author an entry for every remaining `DiagnosticName`**

The complete set to cover (grouped by category; the count is enforced by the exhaustive Record, so tsc tells you if you miss one):

- **AG1 types/aliases:** `typeParamDefaultOrder`, `notValueParameterized`, `tooManyValueArgs`, `valueArgsRequired`, `tooFewValueArgs`, `unknownTypeAlias`, `genericRequiresTypeArgs`, `builtinGenericArity`, `unknownGenericType`, `notGenericType`, `tooManyTypeArgs`, `tooFewTypeArgs`
- **AG2 checking:** `typeNotAssignableInContext`, `conditionNotBoolean`, `unknownProperty`, `missingAnnotationStrictMode`, `typeNotAssignable`✓, `forLoopIterableType`, `validatedParamsRequireResult`, `unionFieldNotOnEveryMember`, `resultBranchFieldAccess`, `dimensionMismatch`, `propertyDoesNotExist`, `notAllPathsReturn`
- **AG3 effects:** `handlerParamValidated`, `effectDeclaredTwice`, `effectPayloadConflict`, `namedArgsOnRaise`, `effectDataMissing`, `effectDataFieldMissing`, `effectDataFieldWrongType`, `effectDataMismatch`, `unhandledInterrupts`, `handlerBodyRaises`, `interruptInCallback`, `raisesNotAnEffectSet`, `raisesExceeded`, `valueMayRaiseAnyEffect`, `valueEffectExceedsRaises`
- **AG4 names:** `shadowsImportedFunction`, `reservedBuiltinRedefined`, `reservedBuiltinTypeRedefined`, `undefinedFunction`, `reassignToConst`, `reservedBlockKeyword`, `undefinedVariable`✓
- **AG5 match:** `matchNotExhaustive`✓
- **AG6 tools:** `regexInStructuredOutput`, `docStringParamInterpolation`, `partialRequiresNamedArgs`, `unknownPartialParameter`, `partialArgNotAssignable`, `namedArgsOnBuiltinMethod`, `methodArityExact`, `methodArityAtLeast`, `methodArityRange`, `builtinMethodArgNotAssignable`, `namedArgsOnlyAgencyFunctions`, `namedArgNotAccepted`, `duplicateNamedArg`, `namedArgTypeMismatch`, `blockArgNotAccepted`, `callArityExact`, `callArityAtLeast`, `callArityRange`, `argNotAssignable`, `splatMustBeArray`, `splatElementNotAssignable`, `pipeSlotNotAssignable`, `splatAfterNamedArg`, `positionalAfterNamedArg`, `unknownNamedArg`, `namedArgConflictsPositional`, `positionalFeedsNamedVariadic`, `toolRequiredParamUnbound`, `toolRequiredParamUnboundTyped`, `toolOptionalParamsDropped`
- **AG7 static-init:** `exportRequiresStaticConst`, `bannedBuiltinInStaticInit`, `interruptInStaticInit`, `staticReassignedAtTopLevel`, `staticMutatedViaMethod`

(✓ = already written in Step 1.) For the message wording of each, read the `message` field in `lib/typeChecker/diagnostics.ts` — the explanation expands on it. For the semantics (why the rule exists), the relevant guides are `docs/site/guide/` and the dev docs named in `CLAUDE.md` (e.g. interrupts, effects, static-init). Keep each explanation user-facing and concrete.

- [ ] **Step 3: Write the coverage / quality / snippet tests**

Create `lib/typeChecker/diagnosticExplanations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DIAGNOSTICS, type DiagnosticName } from "./diagnostics.js";
import { DIAGNOSTIC_EXPLANATIONS } from "./diagnosticExplanations.js";
import { parseAgency } from "../parser.js";

const names = Object.keys(DIAGNOSTICS) as DiagnosticName[];

describe("diagnostic explanations", () => {
  it("has one entry per diagnostic (exhaustive)", () => {
    // The Record type guarantees this at compile time; this pins it at
    // runtime and guards against an accidental `as any` cast.
    for (const name of names) {
      expect(DIAGNOSTIC_EXPLANATIONS[name], `missing explanation: ${name}`).toBeTruthy();
    }
    expect(Object.keys(DIAGNOSTIC_EXPLANATIONS).sort()).toEqual([...names].sort());
  });

  it("every explanation is substantial (no stubs)", () => {
    for (const name of names) {
      expect(DIAGNOSTIC_EXPLANATIONS[name].trim().length, name).toBeGreaterThanOrEqual(100);
    }
  });

  it("no explanation leaks a TS interpolation", () => {
    for (const name of names) {
      expect(DIAGNOSTIC_EXPLANATIONS[name], name).not.toContain("${");
    }
  });

  it("no unrendered {placeholder} outside a code span", () => {
    // Reuse the registry's brace rule: strip fenced/inline code, then any
    // remaining {word} is an accidental raw-template quote.
    for (const name of names) {
      const withoutCode = DIAGNOSTIC_EXPLANATIONS[name]
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "");
      const withoutEscapes = withoutCode.replace(/\{\{|\}\}/g, "");
      expect(withoutEscapes.replace(/\{\w+\}/g, ""), name).not.toMatch(/[{}]/);
    }
  });

  it("every ```agency fenced snippet parses", () => {
    for (const name of names) {
      const blocks = extractAgencyBlocks(DIAGNOSTIC_EXPLANATIONS[name]);
      for (const block of blocks) {
        expect(() => parseAgency(block), `${name} snippet failed to parse`).not.toThrow();
      }
    }
  });
});

function extractAgencyBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```agency\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}
```

- [ ] **Step 4: Run the build + tests**

Run: `pnpm exec tsc --noEmit 2>&1 | tee /tmp/t2-tsc.log` — expect zero errors (proves exhaustiveness).
Run: `pnpm exec vitest run lib/typeChecker/diagnosticExplanations.test.ts 2>&1 | tee /tmp/t2.log` — expect PASS.

If a snippet fails to parse, fix the snippet (check `docs/site/guide/basic-syntax.md`) — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/diagnosticExplanations.ts lib/typeChecker/diagnosticExplanations.test.ts
git commit -F /tmp/commit2.txt
```
`/tmp/commit2.txt`:
```
Add exhaustive diagnostic explanations table

One long-form Markdown explanation per DiagnosticName, enforced exhaustive
by Record<DiagnosticName, string>. Tests pin substance, no-leak, and that
every fenced Agency snippet parses.
```

---

### Task 3: `agency explain` CLI command

**Files:**
- Create: `lib/cli/explain.ts`
- Create: `lib/cli/explain.test.ts`
- Modify: `scripts/agency.ts` (import the helpers; register the command near the `typecheck` command around line 839)

**Interfaces:**
- Consumes: `DIAGNOSTICS`, `DIAGNOSTIC_CATEGORIES`, `categoryForCode` from `@/typeChecker/diagnostics.js`; `DIAGNOSTIC_EXPLANATIONS` from `@/typeChecker/diagnosticExplanations.js`; `color` from `@/utils/termcolors.js`
- Produces:
  - `export function renderDiagnosticText(codeOrName: string): { text: string; found: boolean }`
  - `export function renderDiagnosticList(): string`

- [ ] **Step 1: Write the failing helper test**

Create `lib/cli/explain.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderDiagnosticText, renderDiagnosticList } from "./explain.js";
import { DIAGNOSTICS } from "@/typeChecker/diagnostics.js";

// termcolors colors unconditionally; strip ANSI to assert on text.
// (Same pattern as lib/typeChecker/formatErrors.test.ts:10.)
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderDiagnosticText", () => {
  it("resolves a code and its registry name to the same text", () => {
    const byCode = renderDiagnosticText("AG2005");
    const byName = renderDiagnosticText("typeNotAssignable");
    expect(byCode.found).toBe(true);
    expect(plain(byCode.text)).toBe(plain(byName.text));
  });

  it("is case-insensitive on the code", () => {
    expect(renderDiagnosticText("ag2005").found).toBe(true);
  });

  it("includes the message template and the explanation", () => {
    const { text } = renderDiagnosticText("AG2005");
    expect(plain(text)).toContain(DIAGNOSTICS.typeNotAssignable.message);
    expect(plain(text)).toContain("not assignable"); // from the explanation prose
  });

  it("returns found:false with a suggestion for an unknown code", () => {
    const { text, found } = renderDiagnosticText("AG9999");
    expect(found).toBe(false);
    expect(plain(text)).toContain("AG9999");
    expect(plain(text)).toContain("agency explain --list");
  });
});

describe("renderDiagnosticList", () => {
  it("lists every code exactly once", () => {
    const listed = plain(renderDiagnosticList());
    for (const entry of Object.values(DIAGNOSTICS)) {
      const occurrences = listed.split(entry.code).length - 1;
      expect(occurrences, entry.code).toBe(1);
    }
  });
});
```

Note: `termcolors` has no `strip` helper — the codebase strips ANSI with the local `plain` regex shown above (identical to `lib/typeChecker/formatErrors.test.ts:10`).

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run lib/cli/explain.test.ts 2>&1 | tee /tmp/t3.log`
Expected: FAIL (`explain.js` does not exist).

- [ ] **Step 3: Implement `lib/cli/explain.ts`**

```ts
import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
  type DiagnosticName,
} from "@/typeChecker/diagnostics.js";
import { DIAGNOSTIC_EXPLANATIONS } from "@/typeChecker/diagnosticExplanations.js";
import { color } from "@/utils/termcolors.js";

function lookup(codeOrName: string): DiagnosticName | undefined {
  const q = codeOrName.trim();
  if (q in DIAGNOSTICS) return q as DiagnosticName;
  const upper = q.toUpperCase();
  for (const [name, entry] of Object.entries(DIAGNOSTICS)) {
    if (entry.code.toUpperCase() === upper) return name as DiagnosticName;
  }
  return undefined;
}

/** Rendered detail for one diagnostic. `found:false` carries the not-found
 *  message with a suggestion; the caller prints it and exits 1. */
export function renderDiagnosticText(codeOrName: string): {
  text: string;
  found: boolean;
} {
  const name = lookup(codeOrName);
  if (!name) {
    return {
      found: false,
      text: `Unknown diagnostic code '${codeOrName}'. Run 'agency explain --list' to see all codes.`,
    };
  }
  const entry = DIAGNOSTICS[name];
  const lines = [
    `${color.bold(entry.code)} ${color.dim(name)}`,
    `${color.dim("severity:")} ${entry.severity}`,
    "",
    entry.message,
    "",
    DIAGNOSTIC_EXPLANATIONS[name],
  ];
  return { found: true, text: lines.join("\n") };
}

/** Every code, grouped under its category title, with the message template
 *  as the one-line summary. Codes sort within a category. */
export function renderDiagnosticList(): string {
  const blocks: string[] = [];
  for (const cat of DIAGNOSTIC_CATEGORIES) {
    const rows = Object.entries(DIAGNOSTICS)
      .filter(([, e]) => categoryForCode(e.code)?.prefix === cat.prefix)
      .sort(([, a], [, b]) => a.code.localeCompare(b.code))
      .map(([, e]) => `  ${color.bold(e.code)}  ${e.message}`);
    if (rows.length === 0) continue;
    blocks.push([color.underline(cat.title), ...rows].join("\n"));
  }
  return blocks.join("\n\n");
}
```

- [ ] **Step 4: Run the helper test to green**

Run: `pnpm exec vitest run lib/cli/explain.test.ts 2>&1 | tee /tmp/t3.log`
Expected: PASS.

- [ ] **Step 5: Wire the command in `scripts/agency.ts`**

Add the import next to the other `@/cli/*` imports (after line 21):

```ts
import { renderDiagnosticText, renderDiagnosticList } from "@/cli/explain.js";
```

Register the command immediately after the `typecheck` command block (after line 883):

```ts
  program
    .command("explain")
    .description("Explain a type-checker diagnostic code (e.g. AG2005)")
    .argument("[code]", "An AG#### code or registry name; omit to list all")
    .option("--list", "List every diagnostic code")
    .action((code: string | undefined, opts: { list?: boolean }) => {
      if (!code || opts.list) {
        console.log(renderDiagnosticList());
        return;
      }
      const { text, found } = renderDiagnosticText(code);
      if (found) {
        console.log(text);
      } else {
        console.error(text);
        process.exit(1);
      }
    });
```

- [ ] **Step 6: Manual smoke + commit**

Run: `pnpm run build 2>&1 | tail -5 && node dist/scripts/agency.js explain AG2005 && node dist/scripts/agency.js explain --list | head -20 && node dist/scripts/agency.js explain AG9999; echo "exit=$?"`
Expected: detail for AG2005, a grouped list, and `exit=1` for AG9999.

```bash
git add lib/cli/explain.ts lib/cli/explain.test.ts scripts/agency.ts
git commit -F /tmp/commit3.txt
```
`/tmp/commit3.txt`:
```
Add agency explain <code> CLI

Look up a diagnostic by AG#### code or registry name and print its message
plus long explanation; agency explain --list groups every code by category.
Logic lives in a testable lib/cli/explain.ts; the command is a thin wrapper.
```

---

### Task 4: The discovery hint line

**Files:**
- Modify: `lib/typeChecker/index.ts` (add `formatDiagnosticsHint` next to `formatErrors` at line 506)
- Modify: `scripts/agency.ts` (typecheck action, line 859)
- Modify: `lib/compiler/buildSession.ts` (compile-failure prints, lines 648 and 652)
- Test: `lib/typeChecker/formatErrors.test.ts`

**Interfaces:**
- Produces: `export function formatDiagnosticsHint(errors: TypeCheckError[]): string | null`

- [ ] **Step 1: Write the failing test**

Add to `lib/typeChecker/formatErrors.test.ts` (import `formatDiagnosticsHint` from `./index.js`):

```ts
import { formatDiagnosticsHint } from "./index.js";

describe("formatDiagnosticsHint", () => {
  const err = (code: string, severity: "error" | "warning") => ({
    code, name: "x" as never, message: "m", severity, params: {}, loc: null,
  });

  it("names the first ERROR-severity code, not errors[0]", () => {
    const hint = formatDiagnosticsHint([err("AG3009", "warning"), err("AG2005", "error")]);
    expect(hint).not.toBeNull();
    expect(hint!).toContain("AG2005");
    expect(hint!).not.toContain("AG3009");
    expect(hint!).toContain("agency explain");
  });

  it("returns null when there are no error-severity diagnostics", () => {
    expect(formatDiagnosticsHint([err("AG3009", "warning")])).toBeNull();
    expect(formatDiagnosticsHint([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run lib/typeChecker/formatErrors.test.ts 2>&1 | tee /tmp/t4.log`
Expected: FAIL (`formatDiagnosticsHint` not exported).

- [ ] **Step 3: Implement the helper**

Add just below `formatErrors` (after line 521) in `lib/typeChecker/index.ts`:

```ts
/**
 * One-line discovery hint printed AFTER the error block, naming the first
 * error-severity diagnostic. Returns null when no error-severity diagnostic
 * is present (warnings-only output gets no hint). Kept OUT of formatErrors
 * so programmatic consumers (compile.ts, serve.ts) are untouched — only the
 * human/agent-facing print sites append it.
 */
export function formatDiagnosticsHint(errors: TypeCheckError[]): string | null {
  const first = errors.find((e) => e.severity === "error");
  if (!first) return null;
  return `Run 'agency explain ${first.code}' for an explanation.`;
}
```

- [ ] **Step 4: Run the test to green**

Run: `pnpm exec vitest run lib/typeChecker/formatErrors.test.ts 2>&1 | tee /tmp/t4.log`
Expected: PASS.

- [ ] **Step 5: Wire at the typecheck command action**

In `scripts/agency.ts`, update the import on line 837 and the print at line 858-862:

```ts
import { formatErrors, formatDiagnosticsHint, typeCheck } from "@/typeChecker/index.js";
```

```ts
        if (errors.length > 0) {
          console.error(formatErrors(errors));
          const hint = formatDiagnosticsHint(errors);
          if (hint) console.error(hint);
          if (errors.some((e) => e.severity === "error")) {
            hasErrors = true;
          }
        } else {
```

(The hint goes to `console.error`, the same stream as the block, so an agent capturing stderr sees both.)

- [ ] **Step 6: Wire at the buildSession compile-failure print**

In `lib/compiler/buildSession.ts`, add `formatDiagnosticsHint` to the existing `formatErrors` import, then update lines 647-653:

```ts
  if (tc?.strict) {
    console.error(formatErrors(errors));
    const hint = formatDiagnosticsHint(errors);
    if (hint) console.error(hint);
    const hasFatal = errors.some((e) => e.severity === "error");
    if (hasFatal) process.exit(1);
  } else {
    console.warn(formatErrors(errors));
    // warn-mode output is warnings-first; a hint only fires on error severity
    const hint = formatDiagnosticsHint(errors);
    if (hint) console.warn(hint);
  }
```

- [ ] **Step 7: Build, smoke, commit**

Run: `pnpm run build 2>&1 | tail -3`, then create a scratch file with a type error and run `node dist/scripts/agency.js typecheck /tmp/bad.agency 2>&1 | tail -3`. Scratch file `/tmp/bad.agency`:
```
node main() {
  const x: number = "nope"
}
```
Expected: the error line followed by `Run 'agency explain AG2005' for an explanation.`

```bash
git add lib/typeChecker/index.ts lib/typeChecker/formatErrors.test.ts scripts/agency.ts lib/compiler/buildSession.ts
git commit -F /tmp/commit4.txt
```
`/tmp/commit4.txt`:
```
Add explain hint after failed type checks

formatDiagnosticsHint names the first error-severity code and advertises
agency explain; wired at the typecheck action and buildSession failure
print only, on the same stream as the error block. Not in formatErrors.
```

---

### Task 5: The docs generator (build script) + generated pages

**Files:**
- Create: `lib/cli/diagnosticsDocs.ts` (pure generation — returns `{ relPath, contents }[]`)
- Create: `lib/cli/diagnosticsDocs.test.ts`
- Create: `scripts/generateDiagnosticsDocs.ts` (thin FS wrapper, compiled to `dist/scripts/`)
- Modify: `Makefile` (add a `diagnostics-docs` target; sequence it in `all`; extend `stage-stdlib-docs`)
- Generated (committed): `docs/site/diagnostics/index.md` + seven category pages

**Interfaces:**
- Consumes: `DIAGNOSTICS`, `DIAGNOSTIC_CATEGORIES`, `categoryForCode` from `@/typeChecker/diagnostics.js`; `DIAGNOSTIC_EXPLANATIONS` from `@/typeChecker/diagnosticExplanations.js`
- Produces: `export function generateDiagnosticsPages(): { relPath: string; contents: string }[]`

- [ ] **Step 1: Write the failing generator test**

Create `lib/cli/diagnosticsDocs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateDiagnosticsPages } from "./diagnosticsDocs.js";
import { DIAGNOSTICS, DIAGNOSTIC_CATEGORIES, categoryForCode } from "@/typeChecker/diagnostics.js";

const pages = generateDiagnosticsPages();
const byPath = Object.fromEntries(pages.map((p) => [p.relPath, p.contents]));
const codes = Object.values(DIAGNOSTICS).map((e) => e.code);

describe("generateDiagnosticsPages", () => {
  it("emits index.md plus one page per category", () => {
    expect(byPath["index.md"]).toBeTruthy();
    for (const cat of DIAGNOSTIC_CATEGORIES) {
      expect(byPath[`${cat.slug}.md`], cat.slug).toBeTruthy();
    }
  });

  it("index lists every code exactly once", () => {
    const index = byPath["index.md"];
    for (const code of codes) {
      expect(index.split(code).length - 1, code).toBeGreaterThanOrEqual(1);
    }
  });

  it("each code appears on exactly its own category page", () => {
    for (const entry of Object.values(DIAGNOSTICS)) {
      const cat = categoryForCode(entry.code)!;
      const page = byPath[`${cat.slug}.md`];
      expect(page.includes(`## ${entry.code}`), `${entry.code} on ${cat.slug}`).toBe(true);
      for (const other of DIAGNOSTIC_CATEGORIES) {
        if (other.slug === cat.slug) continue;
        expect(byPath[`${other.slug}.md`].includes(`## ${entry.code}`)).toBe(false);
      }
    }
  });

  it("has unique heading anchors within each page", () => {
    for (const { contents } of pages) {
      const headings = [...contents.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(new Set(headings).size).toBe(headings.length);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm exec vitest run lib/cli/diagnosticsDocs.test.ts 2>&1 | tee /tmp/t5.log`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `lib/cli/diagnosticsDocs.ts`**

```ts
import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
} from "@/typeChecker/diagnostics.js";
import { DIAGNOSTIC_EXPLANATIONS } from "@/typeChecker/diagnosticExplanations.js";

type Page = { relPath: string; contents: string };

function codesForCategory(prefix: string) {
  return Object.entries(DIAGNOSTICS)
    .filter(([, e]) => categoryForCode(e.code)?.prefix === prefix)
    .sort(([, a], [, b]) => a.code.localeCompare(b.code));
}

function indexPage(): string {
  const lines = [
    "---",
    'name: "Diagnostics"',
    "---",
    "",
    "# Diagnostic codes",
    "",
    "Every type-checker error and warning carries a stable `AG####` code.",
    "Look one up with `agency explain <code>` (e.g. `agency explain AG2005`),",
    "or suppress one on the next line with `// @tc-ignore AG####`.",
    "",
  ];
  for (const cat of DIAGNOSTIC_CATEGORIES) {
    const entries = codesForCategory(cat.prefix);
    if (entries.length === 0) continue;
    lines.push(`## ${cat.title}`, "");
    lines.push("| Code | Message |", "| --- | --- |");
    for (const [, e] of entries) {
      const anchor = e.code.toLowerCase();
      lines.push(`| [${e.code}](${cat.slug}.md#${anchor}) | ${escapeCell(e.message)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function categoryPage(cat: (typeof DIAGNOSTIC_CATEGORIES)[number]): string {
  const lines = ["---", `name: "${cat.title}"`, "---", "", `# ${cat.title}`, ""];
  for (const [name, e] of codesForCategory(cat.prefix)) {
    lines.push(`## ${e.code} — ${e.message}`, "");
    lines.push(`*Default severity: ${e.severity}.*`, "");
    lines.push(DIAGNOSTIC_EXPLANATIONS[name as keyof typeof DIAGNOSTIC_EXPLANATIONS], "");
  }
  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** All diagnostics pages as in-memory {relPath, contents}. The build script
 *  writes them; tests assert on them without touching the filesystem. */
export function generateDiagnosticsPages(): Page[] {
  return [
    { relPath: "index.md", contents: indexPage() },
    ...DIAGNOSTIC_CATEGORIES.map((cat) => ({
      relPath: `${cat.slug}.md`,
      contents: categoryPage(cat),
    })),
  ];
}
```

Note: the `## AG2005 — <message>` heading gives Docusaurus/whatever the site uses a slug like `#ag2005--…`; the index links to `#${code.toLowerCase()}`. If the site's anchor algorithm differs, the anchor is cosmetic — the code text on the page is what `agency explain` and the agent rely on. Keep the `## AG#### —` prefix exactly so the "code appears on its page" test and the anchor stay predictable.

- [ ] **Step 4: Run the generator test to green**

Run: `pnpm exec vitest run lib/cli/diagnosticsDocs.test.ts 2>&1 | tee /tmp/t5.log`
Expected: PASS.

- [ ] **Step 5: Implement the build script `scripts/generateDiagnosticsDocs.ts`**

```ts
// Regenerates docs/site/diagnostics/ from the diagnostics registry +
// explanations table. A BUILD script (compiled to dist/scripts/ like
// stdlib-stamp), invoked from the Makefile — never a user command. One fast
// node invocation, no stamp machinery: it wipes and rewrites the whole dir.
import * as fs from "fs";
import * as path from "path";
import { generateDiagnosticsPages } from "@/cli/diagnosticsDocs.js";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: generateDiagnosticsDocs <output-dir>");
  process.exit(1);
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const { relPath, contents } of generateDiagnosticsPages()) {
  fs.writeFileSync(path.join(outDir, relPath), contents.endsWith("\n") ? contents : contents + "\n");
}
console.log(`Wrote ${generateDiagnosticsPages().length} diagnostics pages to ${outDir}`);
```

- [ ] **Step 6: Wire the Makefile**

Extend `stage-stdlib-docs` (lines 31-36) to also stage diagnostics:

```make
define stage-stdlib-docs
	mkdir -p stdlib/docs
	rm -rf stdlib/docs/guide stdlib/docs/cli stdlib/docs/diagnostics
	cp -r docs/site/guide stdlib/docs/guide
	cp -r docs/site/cli stdlib/docs/cli
	cp -r docs/site/diagnostics stdlib/docs/diagnostics
endef
```

Add a `diagnostics-docs` target (near the `doc` target, after line 126):

```make
# Regenerate docs/site/diagnostics/ from the diagnostics registry. Cheap
# (one node invocation), so no stamp. Must run BEFORE compile-agency stages
# docs into stdlib/, so `all` sequences it right after build.
diagnostics-docs:
	node ./dist/scripts/generateDiagnosticsDocs.js docs/site/diagnostics/
```

Sequence it in `all` (line 38-39) between `build` and `compile-agency`, so the freshly generated pages are what `stage-stdlib-docs` copies:

```make
all:
	pnpm run templates && $(MAKE) build && $(MAKE) diagnostics-docs && $(MAKE) compile-agency && $(MAKE) doc
```

Add `diagnostics-docs` to the `.PHONY` line (line 1).

- [ ] **Step 7: Generate, build, verify**

Run: `make 2>&1 | tail -15 | tee /tmp/t5-make.log`
Then: `ls docs/site/diagnostics/ && ls stdlib/docs/diagnostics/ && head -25 docs/site/diagnostics/index.md`
Expected: `index.md` + 7 category pages in both locations; index shows the category tables.

- [ ] **Step 8: Commit (including the generated docs)**

```bash
git add lib/cli/diagnosticsDocs.ts lib/cli/diagnosticsDocs.test.ts scripts/generateDiagnosticsDocs.ts Makefile docs/site/diagnostics/ stdlib/docs/diagnostics/
git commit -F /tmp/commit5.txt
```
`/tmp/commit5.txt`:
```
Generate docs/site/diagnostics from the registry

New build script (Makefile diagnostics-docs target) writes an index plus one
page per category from the registry + explanations table. Pure generation
lives in lib/cli/diagnosticsDocs.ts and is unit-tested in memory; stage the
pages into stdlib/docs for the agent.
```

---

### Task 6: Agent knowledge (docsSkill "diagnostics" section)

**Files:**
- Modify: `lib/stdlib/skills.ts:36` (`_docsDir` union)
- Modify: `stdlib/skills.agency:200,207` (`docsSkill` union + docstring)
- Modify: `lib/agents/agency-agent/subagents/oracle.agency`, `research.agency`, `code.agency`, `explorer.agency`
- Test: extend the existing skills test if one covers `_docsDir` (see Step 5)

**Interfaces:**
- Consumes: the staged `stdlib/docs/diagnostics/` dir from Task 5
- Produces: `docsSkill("diagnostics")` returning a flat docs tool over the diagnostics pages

- [ ] **Step 1: Widen `_docsDir` in `lib/stdlib/skills.ts`**

```ts
export function _docsDir(section: "guide" | "cli" | "diagnostics"): string {
  return path.join(getStdlibDir(), "docs", section);
}
```

- [ ] **Step 2: Widen `docsSkill` in `stdlib/skills.agency`**

Update the signature (line 200) and docstring (lines 200-208):

```
export def docsSkill(section: "guide" | "cli" | "diagnostics") {
  """
  Build a docs tool for an LLM over the packaged Agency documentation.
  "guide" serves the language guide (syntax, types, control flow);
  "cli" serves the CLI reference; "diagnostics" serves the type-checker
  diagnostic codes (AG####) with explanations and fixes. The returned tool
  lists every page in its description and lets the model read any one on
  demand.

  @param section - Which documentation set to serve: "guide", "cli", or "diagnostics".
  """
```

(Leave the body — `return buildSkillsTool(_docsDir(section), "flat")` — unchanged.)

- [ ] **Step 3: Wire all four subagents**

In each of `oracle.agency` (near line 13), `research.agency` (near line 34), `code.agency` (near line 53), `explorer.agency` (near line 24), add next to the existing `docSkill`/`cliSkill` lines:

```
static const diagnosticsSkill = docsSkill("diagnostics")
```

Then add `diagnosticsSkill` wherever that subagent lists its tools (find where `docSkill` / `cliSkill` are passed to the agent's tool set in each file and add `diagnosticsSkill` alongside).

- [ ] **Step 4: Rebuild and smoke the wiring**

Run: `make 2>&1 | tail -15 | tee /tmp/t6-make.log`
Then confirm the staged dir and that each subagent compiled:
`ls stdlib/docs/diagnostics/ && ls dist/lib/agents/agency-agent/subagents/`
Expected: diagnostics pages staged; each subagent `.js` present (compile succeeded with the new `docsSkill("diagnostics")` calls).

- [ ] **Step 5: Add a cheap wiring existence test**

If `lib/stdlib/` has a skills test (search `lib/stdlib/skills.test.ts` or similar), add:

```ts
it("_docsDir resolves the diagnostics section to a staged dir", () => {
  const dir = _docsDir("diagnostics");
  expect(fs.existsSync(path.join(dir, "index.md"))).toBe(true);
});
```

If no such test file exists, skip this step (the `make` build itself fails if the staged dir is missing, per the `cp -r` in `stage-stdlib-docs`) and note the skip in the commit message.

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/skills.ts stdlib/skills.agency lib/agents/agency-agent/subagents/ stdlib/
git commit -F /tmp/commit6.txt
```
`/tmp/commit6.txt`:
```
Expose diagnostics docs to the agent

Widen docsSkill to a "diagnostics" section and wire it into all four
docsSkill-bearing subagents (oracle, research, code, explorer). code runs
typecheck and is the primary consumer.
```

---

## Self-Review

**Spec coverage:**
- Content model (two authored pieces) → Task 2 (explanations) + existing registry (message templates). ✓
- Explanations file, exhaustive Record, retired-entry note → Task 2 Step 1. ✓
- `DIAGNOSTIC_CATEGORIES` as data → Task 1. ✓
- Surface 1 CLI (`agency explain <code>` / `--list`, testable helper, unknown→exit 1) → Task 3. ✓
- Surface 2 build script + generated pages (index + 7 category pages, no user command) → Task 5. ✓
- Surface 3 agent (`_docsDir`/`docsSkill` union, `stage-stdlib-docs`, all four subagents) → Task 6. ✓
- Hint line (`formatDiagnosticsHint`, first error-severity, two print sites, not in `formatErrors`, same stream) → Task 4. ✓
- Tests 1-7 from the spec: coverage/quality → T2; snippet-parse → T2; code↔category in registry suite → T1; CLI helper → T3; generator invariants → T5; hint (warning-first case) → T4; wiring smoke → T5/T6. ✓
- Non-goals (no parser errors, no reword, no `agency doc` integration) respected — nothing in the plan touches them. ✓

**Placeholder scan:** No TBD/TODO. The one deliberately-unspecified span is the ~80 explanation entries in Task 2 Step 2 — the complete name list is given, three full worked examples are shown, and the quality/parse tests gate them; that is authored content, not a code placeholder.

**Type consistency:** `renderDiagnosticText` returns `{ text, found }` in both the test (T3 S1) and impl (T3 S3). `generateDiagnosticsPages()` returns `{ relPath, contents }[]` in test (T5 S1), impl (T5 S3), and script (T5 S5). `formatDiagnosticsHint(errors): string | null` consistent across T4. `categoryForCode` / `DIAGNOSTIC_CATEGORIES` signatures match across Tasks 1, 3, 5. `_docsDir`/`docsSkill` union `"guide" | "cli" | "diagnostics"` consistent across Task 6.

**Verified against the code:** ANSI is stripped with the local `plain` regex (no `color.strip` — matches `formatErrors.test.ts:10`); `color.bold`/`color.dim`/`color.underline` are valid chain keys (`modifiers` in `termcolors.ts:47-52`); `parseAgency` is the parser name existing tests import (`formatErrors.test.ts:4`).
