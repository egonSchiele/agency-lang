# Code Literals (`[| ... |]`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the code-literal spec (`/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-23-code-literals-design.md`, review-revised): inline `[| ... |]` templates that parse at compile time and evaluate to ordinary `Code` values.

**Architecture:** A new `codeLiteral` expression node whose body is parsed (unlowered template mode) by the literal's own parser at parse time of the enclosing file. The node is a leaf for every host-side pass. Codegen embeds the canonical printed body and reconstructs the `Code` value at runtime through the one source→AST path. The formatter reformats bodies. A small, separately-committed `fill` relaxation (expr fragments fill statements holes) closes the only gap kind inference leaves.

**Tech Stack:** TypeScript, tarsec parser combinators, vitest, the Agency test runner (`pnpm run agency test`).

## Global Constraints

- Work on a branch in a new worktree inside `/Users/adityabhargava/agency-lang/` (never the home directory, never on main). Fetch first.
- **No `walkNodes` changes** — and none are needed: an unregistered node kind is a leaf for free. The plan relies on that; if you find yourself editing `lib/utils/node.ts`, stop and re-read Task 4.
- Never force-push or amend. Commit messages and PR bodies go in a file first (apostrophes break the CLI).
- Objects instead of maps, arrays instead of sets, types instead of interfaces, no dynamic imports.
- Only modify `.mustache` files under `lib/templates/`, never their generated `.ts` twins; run `pnpm run templates` after.
- Run `make` after touching anything stdlib-adjacent; `make doc` if docstrings change.
- Save test output to files; do not rerun to re-read failures. Do not run the full agency suite locally (CI does).
- Verify every Agency snippet in tests parses (`pnpm run ast` on a scratch file inside the repo — never `/tmp`) before building assertions on it.
- Audit the final diff against `packages/agency-lang/docs/dev/anti-patterns.md` before the PR.
- Commit-message footers: use the Co-Authored-By line the executing agent's own harness specifies — do not copy one from this plan.
- Anyone eyeballing the LOCAL `main` checkout may not find `WALKER_EXCLUDED_FIELDS` or the reachability tripwire — that tree is several PRs stale. They are in `origin/main` (`lib/utils/expressionSlots.test.ts`, #669/#670), which this plan branches from after `git fetch`.

All file paths are relative to `/Users/adityabhargava/agency-lang/packages/agency-lang/` unless they start with `/`.

---

## Background: what this builds and where the risk is

Template Agency's composition workflow keeps producing *small* fragments, and both existing routes are poor for them: a separate file per three-line fragment (the reader of a generator can't see the shape being generated), or `parseStatements("...\n...")` strings that fail at *runtime* in whoever calls the generator. A code literal is real Agency code, inline, with holes:

```ts
const guardTpl = [|
  def guarded(): string {
    const ms: number = #minutes
    #body
  }
|]
```

The body parses when the enclosing file parses — a typo'd template is a compile error with a mapped location — and the value at runtime is indistinguishable from a file-loaded template.

The spec's key decisions, each load-bearing for a task below:

1. **Brackets `[| ... |]`**, verified unclaimed (`[|` is a parse error today; `|]` appears nowhere in the corpus). Backticks are dead — they're a string delimiter (`parsers.ts:684`).
2. **Zero escaping**: the end-scan for `|]` is string- and comment-aware, so `|]` inside body strings/comments is inert, and `|]` in code position isn't legal Agency. Nested `[|` is a directive parse error.
3. **Kind inference smallest-first** (expr → statements → program), with the **expr-fills-statements relaxation** in `fill` shipped as its own commit — `statements` holes already accept `program` fragments (`fill.ts:221`), so expr-into-statements is the only gap inference leaves.
4. **Holes are the only parameterization.** No `$( )` splices; `${...}` in the body belongs to the generated program's strings and passes through raw.
5. **The node is a host-side leaf**, enforced by four specific levers (Task 4), not by a walker edit.
6. **Codegen embeds printed source** and reconstructs at runtime via the canonical parse — no second `Code` representation.
7. **`fmt` reformats literal bodies.** This is the riskiest v1 promise, so the round-trip suite is a GATE and runs first (Task 1).

Where the risk actually lives, in order: the formatter gate (unknown generator quality on unlowered template-mode nodes), the end-scan's interpolation corner (a string containing `${ f("nested |] string") }`), and location mapping (the offset machinery is module-global and set once per parse — nested parses must save/restore *additively*).

---

### Task 0: Worktree and branch

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/adityabhargava/agency-lang
git fetch origin
git worktree add worktree-code-literals -b adit/code-literals origin/main
cd worktree-code-literals && pnpm install
cd packages/agency-lang
make > /tmp/claude-cl-make0.log 2>&1; tail -2 /tmp/claude-cl-make0.log
```

- [ ] **Step 2: Confirm** — `git branch --show-current` → `adit/code-literals`. All later paths relative to `worktree-code-literals/packages/agency-lang/`.

---

### Task 1: The formatter gate — round-trip and idempotence on template-mode code

**Files:**
- Create: `lib/backends/agencyGenerator.roundtrip.test.ts`

**Interfaces:**
- Consumes: `parseAgency(src, {}, false, false)` (format-path parse: no prelude template, no lowering — the exact mode `loadTemplate` and the literal body will use), `generateAgency`, `replaceBlankLines` from `lib/parser.js`.
- Produces: a passing gate. Every later formatter claim rests on this. If it finds generator gaps, **fixing them precedes everything else in this plan** — each fix is its own commit with a test pinning the shape that broke.

**Why this is first.** `fmt`-reformats-bodies is the one ambitious v1 promise, and it depends on the canonical generator being clean on unlowered nodes: holes as nodes, patterns unlowered, comprehensions intact. The template feature already leans on this round-trip (`_writeAST`, serialization-as-source), but no test sweeps the whole corpus through the *unlowered* parse↔print cycle. Before building a feature whose formatter story fails as "fmt corrupts my template," prove the cycle.

- [ ] **Step 1: Write the gate**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgency, replaceBlankLines } from "../parser.js";
import { generateAgency } from "./agencyGenerator.js";

function collectAgencyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectAgencyFiles(full));
    else if (entry.endsWith(".agency")) out.push(full);
  }
  return out;
}

function parseTemplateMode(source: string) {
  const parsed = parseAgency(replaceBlankLines(source), {}, false, false);
  if (!parsed.success) throw new Error(parsed.message);
  return parsed.result;
}

// Strip fields that legitimately differ across a print/re-parse cycle.
function normalized(nodes: unknown): unknown {
  return JSON.parse(
    JSON.stringify(nodes, (key, value) => (key === "loc" ? undefined : value)),
  );
}

describe("formatter gate: unlowered template-mode round-trip", () => {
  const root = join(__dirname, "../..");
  const files = [
    ...collectAgencyFiles(join(root, "stdlib")),
    ...collectAgencyFiles(join(root, "tests/typescriptGenerator")),
    ...collectAgencyFiles(join(root, "tests/agency/templates")),
  ];
  expect(files.length).toBeGreaterThan(50);

  it("print → re-parse is structurally identity on the whole corpus", { timeout: 60_000 }, () => {
    for (const file of files) {
      const first = parseTemplateMode(readFileSync(file, "utf8"));
      const printed = generateAgency(first);
      const second = parseTemplateMode(printed);
      expect(normalized(second.nodes), file).toEqual(normalized(first.nodes));
    }
  });

  it("printing is idempotent on the whole corpus", { timeout: 60_000 }, () => {
    for (const file of files) {
      const once = generateAgency(parseTemplateMode(readFileSync(file, "utf8")));
      const twice = generateAgency(parseTemplateMode(once));
      expect(twice, file).toBe(once);
    }
  });
});
```

Including `tests/agency/templates/` puts hole-bearing files in the gate. Note `generateAgency` mutates its input (it partitions `program.nodes`) — parse fresh for each call, as above, rather than reusing a tree.

- [ ] **Step 2: Run it and triage**

Run: `pnpm test:run lib/backends/agencyGenerator.roundtrip.test.ts > /tmp/claude-cl-gate.log 2>&1; tail -30 /tmp/claude-cl-gate.log`

If green: commit and move on. If red: each failure is a generator bug on unlowered nodes. Fix in `lib/backends/agencyGenerator.ts` with a minimal pinned repro test per fix, one commit per coherent fix, full suite after each. If a failure looks structural (a node kind the generator cannot round-trip at all), STOP and surface it — that may change the fmt-reformats-bodies decision and the owner decides, not the plan.

- [ ] **Step 3: Commit**

```bash
git add lib/backends/agencyGenerator.roundtrip.test.ts
git status   # only intended files
printf 'Formatter gate: unlowered round-trip and idempotence over the corpus\n\nCode literals commit fmt to reformatting template bodies, which rests\non the canonical generator being clean on unlowered template-mode\nnodes. This suite is the gate: parse (no template, no lowering), print,\nre-parse, compare structurally; and printing twice equals printing\nonce.\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude-cl-c1.txt
git commit -F /tmp/claude-cl-c1.txt
```

---

### Task 2: The expr-fills-statements relaxation (own commit — widens `fill` for all callers)

**Files:**
- Modify: `lib/runtime/template/fill.ts` (`assertKindMatchesSort`)
- Modify: `lib/runtime/template/fill.test.ts` (one inverted test + new cases)
- Modify: `docs/dev/template-agency.md` (admissibility table prose)

**Interfaces:**
- Consumes: `assertKindMatchesSort`'s `allowed` table (`fill.ts:218-225`): today `statements: ["statements", "program"]`.
- Produces: `statements: ["statements", "program", "expr"]`. An expr fragment grafts into a statements hole as an expression statement — in the AST an expression statement *is* the expression node in the body array, so `nodesFor`'s existing return (the fragment's single node) is already the correct graft; only the admissibility check changes.

- [ ] **Step 1: Invert the existing rejection test and add the new cases**

In `fill.test.ts`, the test `"rejects an expr fragment in a statements hole"` (currently: `_parseExpr("42")` into a statements hole throws) **changes meaning deliberately**. Replace it with:

```ts
it("an expr fragment fills a statements hole as an expression statement", () => {
  const out = fillAndPrint(stmtTemplate, { setup: _parseExpr("print(99)") });
  expect(out).toContain("print(99)");
});

it("an odd expr-statement grafts fine and is judged at the generated programs compile", () => {
  // `1 + 2` as a bare statement is legal to GRAFT; whether it means
  // anything is the completed program compilers business — the correct
  // stage for that judgment.
  const out = fillAndPrint(stmtTemplate, { setup: _parseExpr("1 + 2") });
  expect(out).toContain("1 + 2");
});

it("expr holes still reject multi-statement fragments", () => {
  expect(() =>
    fillHoles(load(`node main() {\n  const x = #v\n}\n`), {
      v: _parseStatements("print(1)\nprint(2)"),
    }),
  ).toThrow(/expr/);
});

// Guards on the rows the edit must PRESERVE — an append that became a
// replace would break these, and nothing else in the suite would notice
// (the compose fixture routes program fragments into a DECL hole).
it("a program fragment still fills a statements hole", () => {
  const out = fillAndPrint(stmtTemplate, {
    setup: _loadTemplateFromString("def g(): number {\n  return 1\n}\n"),
  });
  expect(out).toContain("def g(): number");
});

it("decl holes still reject expr and statements fragments", () => {
  const declTemplate = `#helpers\n\nnode main() {\n  return 1\n}\n`;
  expect(() => fillHoles(load(declTemplate), { helpers: _parseExpr("1") })).toThrow(/decl/);
  expect(() =>
    fillHoles(load(declTemplate), { helpers: _parseStatements("print(1)") }),
  ).toThrow(/decl/);
});
```

For the two graft-success tests, prefer asserting the grafted node landed in the BODY (parse the output and find the expression node among the node body's statements) over bare `toContain` — `toContain("1 + 2")` is position-blind and formatter-spacing-brittle; a structural check is neither.

(Match the file's real helper names — `fillAndPrint`, `load`, `stmtTemplate` exist; verify the template variable name at the top of the file.)

- [ ] **Step 2: Run to verify the first two fail** — `pnpm test:run lib/runtime/template/fill.test.ts > /tmp/claude-cl-t2red.log 2>&1` — expected: the two new graft tests FAIL with the kind/sort error; the reject test passes.

- [ ] **Step 3: Implement** — in `assertKindMatchesSort`. First, verify the graft hypothesis once rather than asserting it: fill a statements hole with an expr fragment under the relaxed table and inspect the grafted tree — the body array must hold the expression node ITSELF (no wrapper statement node exists to wrap it in). One console check, then delete it. Then the table edit:

```ts
  const allowed: Record<Hole["sort"], string[]> = {
    expr: ["expr"],
    // "expr" is admissible because an expression IS a legal statement in
    // Agency (an expression statement is the expression node itself in
    // the body array). Whether a particular bare expression is a
    // MEANINGFUL statement is judged at the completed programs compile —
    // the right stage. This is what makes smallest-first kind inference
    // for code literals lossless: statements already accepted "program",
    // and this closes the only remaining gap.
    statements: ["statements", "program", "expr"],
    decl: ["program"],
    identifier: [],
  };
```

- [ ] **Step 4: Verify** — `pnpm test:run lib/runtime/template/ > /tmp/claude-cl-t2green.log 2>&1` — all pass.

- [ ] **Step 5: Update `docs/dev/template-agency.md`** — find its kind-vs-sort admissibility prose and add the expr-into-statements row with the one-sentence rationale above.

- [ ] **Step 6: Commit** (message notes it widens `fill` for every caller, names the inverted test).

---

### Task 3: The `codeLiteral` node and parser

**Files:**
- Create: `lib/types/codeLiteral.ts`
- Modify: `lib/types.ts` (export + `AgencyNode` union + `EXPRESSION_NODE_TYPES`)
- Modify: `lib/parsers/parsers.ts` (the literal parser + `baseAtom` wiring)
- Modify: `lib/parser.ts` (export what the parser needs, if anything)
- Create: `lib/parsers/codeLiteral.test.ts`

**Interfaces:**
- Consumes: `exprParser`, `bodyParser`, `parseAgency` (via a late import or injection — see Step 3), `setTemplateOffset` machinery.
- Produces: `CodeLiteral` node `{ type: "codeLiteral"; nodes: AgencyNode[]; kind: "expr" | "statements" | "program" }`, parsed and kind-inferred at parse time. Tasks 4-7 consume exactly this shape.

- [ ] **Step 1: The node type**

`lib/types/codeLiteral.ts`:

```ts
import { BaseNode } from "./base.js";
import type { AgencyNode } from "../types.js";

/** An inline template: `[| ... |]`. The body is PARSED at parse time of
 *  the enclosing file (unlowered template mode, holes intact) and stored
 *  as real nodes — that is what lets the formatter reformat bodies and
 *  makes a malformed template a compile error. The node is a host-side
 *  LEAF: quoted names belong to the generated program, not the host
 *  scope (see the leaf-ness levers in docs/dev/template-agency.md). */
export type CodeLiteral = BaseNode & {
  type: "codeLiteral";
  nodes: AgencyNode[];
  kind: "expr" | "statements" | "program";
};
```

Export from `lib/types.ts`, add to the `AgencyNode` union, and add `"codeLiteral"` to `EXPRESSION_NODE_TYPES`.

- [ ] **Step 2: The end-scan — driven by the existing parsers, not a second lexer**

In `parsers.ts`, near the string parsers. The scan finds the closing `|]` in code position by *reusing the real lexing parsers* to skip non-code regions — the spec's words are "using the lexing rules the parser already has," and that is literal: at each code position, try the comment parsers, try the string parser (which already consumes escapes and `${...}` interpolations, nested strings and all), then look for the delimiters. There is deliberately NO hand-rolled string/escape/brace scanner here — that would be a second lexer that drifts from the real one, and the drift would surface as exactly the mis-scan bug the zero-escaping design exists to prevent.

```ts
const CODE_LITERAL_OPEN = "[|";
const CODE_LITERAL_CLOSE = "|]";

/** Scan from just after `[|` to the matching `|]` in CODE position.
 *  Strings and comments are skipped by the SAME parsers the grammar
 *  uses (escapes, all three delimiters, `${...}` interpolations —
 *  nested strings included), so `|]` inside them is inert; that is what
 *  makes code literals need zero escaping rules, and reusing the real
 *  parsers is what makes the scan and the grammar agree by
 *  construction. Nested `[|` in code position is a hard error with a
 *  directive message. */
function scanCodeLiteralBody(
  input: string,
): { ok: true; body: string; consumed: number } | { ok: false; error: string } {
  let i = 0;
  while (i < input.length) {
    if (input.startsWith(CODE_LITERAL_CLOSE, i)) {
      return { ok: true, body: input.slice(0, i), consumed: i + CODE_LITERAL_CLOSE.length };
    }
    if (input.startsWith(CODE_LITERAL_OPEN, i)) {
      return {
        ok: false,
        error:
          "nested code literals are not supported; build the inner piece as its own value and graft it into a hole",
      };
    }
    const ch = input[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const skipped = consumeWith(stringLiteralParserForScan, input, i);
      if (skipped === -1) {
        return { ok: false, error: "unclosed string inside code literal" };
      }
      i = skipped;
      continue;
    }
    if (ch === "/" && (input[i + 1] === "/" || input[i + 1] === "*")) {
      const skipped =
        input[i + 1] === "/"
          ? consumeWith(commentParser, input, i)
          : consumeWith(multiLineCommentParser, input, i);
      if (skipped === -1) {
        return { ok: false, error: "unclosed comment inside code literal" };
      }
      i = skipped;
      continue;
    }
    i += 1;
  }
  return { ok: false, error: "unclosed code literal: expected |] before end of input" };
}

/** Run a parser at input[from...] purely to measure how much it
 *  consumes. Returns the index after the consumed region, or -1. */
function consumeWith(parser: Parser<unknown>, input: string, from: number): number {
  const result = parser(input.slice(from));
  if (!result.success) {
    return -1;
  }
  return from + (input.length - from - result.rest.length);
}
```

Implementation notes, bounded:

- `stringLiteralParserForScan` is whichever existing string parser consumes a full string *with* interpolations — `_stringParser` is the interpolation-aware one; if it is not exported, export it (it is the canonical string lexer; the scan is a legitimate second consumer). Do NOT reimplement its behavior.
- `commentParser` (`parsers.ts:294`) / `multiLineCommentParser` (`parsers.ts:311`) are the comment consumers — same rule.
- The `BLANK_LINE_SENTINEL` question: the enclosing parse runs on `replaceBlankLines`d input, so the scan may meet sentinel characters; they are inert to this scan (not quotes, not slashes, not delimiters) and pass through into the body, where the body parse handles them exactly as the template path does. State this in a comment; add a body-with-blank-lines test.
- Consequence of parser reuse worth a test either way: `|]` in interpolation CODE position — `"${ a |] b }"` — is consumed by the string parser as part of the interpolation and is therefore INERT (it belongs to the generated program's string). That is the pinned decision; the test asserts the literal survives it and the string content round-trips.

- [ ] **Step 3: The literal parser — body parse, kind inference, location mapping**

```ts
export const codeLiteralParser: Parser<CodeLiteral> = withLoc((input: string) => {
  if (!input.startsWith("[|")) return failure("expected [|", input);
  const scanned = scanCodeLiteralBody(input.slice(2));
  if (!scanned.ok) return failure(scanned.error, input);
  const parsed = parseCodeLiteralBody(scanned.body);
  if (!parsed.ok) return failure(parsed.error, input);
  return {
    success: true,
    result: { type: "codeLiteral", nodes: parsed.nodes, kind: parsed.kind },
    rest: input.slice(2 + scanned.consumed),
  };
});

/** Smallest-first kind inference: a lone expression, else a statement
 *  list, else a program. Each attempt must consume the whole body. */
/** Smallest-first kind inference. EXPORTED: the runtime constructor
 *  (__codeLiteral, Task 6) calls this same function so compile-time and
 *  runtime reconstruction cannot diverge by drift.
 *
 *  Location honesty: the body is trimmed before the expr/statements
 *  attempts, and the LENGTH OF THE STRIPPED PREFIX must survive to the
 *  caller — the post-hoc loc shift adds it, or every node in a body
 *  that opens with a newline (every multi-line literal) maps early. */
export function parseCodeLiteralBody(
  body: string,
):
  | { ok: true; nodes: AgencyNode[]; kind: CodeLiteral["kind"]; strippedPrefix: string }
  | { ok: false; error: string } {
  const trimmed = body.trimStart();
  const strippedPrefix = body.slice(0, body.length - trimmed.length);
  const asExpr = exprParser(trimmed.trimEnd());
  if (asExpr.success && asExpr.rest.trim() === "") {
    return { ok: true, nodes: [asExpr.result as AgencyNode], kind: "expr", strippedPrefix };
  }
  const asStatements = bodyParser(trimmed.trimEnd());
  if (asStatements.success && asStatements.rest.trim() === "") {
    return { ok: true, nodes: asStatements.result, kind: "statements", strippedPrefix };
  }
  const asProgram = parseProgramForLiteral(body);
  if (asProgram.ok) {
    return { ok: true, nodes: asProgram.nodes, kind: "program", strippedPrefix: "" };
  }
  return { ok: false, error: asProgram.error };
}
```

Two implementation notes the executor must resolve here, both bounded:

- **The program-mode parse: default to injection.** The wrapper `parseAgency` lives in `lib/parser.ts` and delegates to `_parseAgency` — also in `parser.ts`, NOT in `parsers.ts` — so a direct call from `parsers.ts` is the import cycle this design must avoid, and hunting for "the right in-file production" mid-implementation is a rabbit hole. Default: `parseProgramForLiteral` is a module-level slot in `parsers.ts` that `lib/parser.ts` fills at its own module init (`registerProgramParserForLiterals(fn)`) — a known injection pattern, cycle-free by construction. Only if the executor happens to spot a clean, already-exported top-level production inside `parsers.ts` may the direct call replace the slot.
- **Location mapping: post-hoc, additive, prefix-aware.** Nested `exprParser`/`bodyParser`/program parses produce locs relative to the *body text they were given*, while `currentTemplateOffset` is set for the *enclosing* parse. Do not fight the global: after a successful body parse, shift every loc by the sum of (i) the literal's start position in the enclosing source (known from the input offset `withLoc` sees) and (ii) the line/col extent of `strippedPrefix` — the whitespace `trimStart` removed before the expr/statements attempts, which is nonempty for every multi-line literal (they open with a newline). Dropping (ii) maps every node early; that is finding #2 of the plan review and the location tests are written to catch exactly it. The shift walker is a small generic recursion over objects with a `loc` — deliberately NOT `walkNodesArray`, and that is a documented ruling, not an accident: `walkNodesArray` skips positions on purpose (patterns, parameter defaults — the #668 gap list), and locs in skipped positions still need shifting. A comment on the shifter says so, so nobody "deduplicates" it into the walker and silently un-shifts pattern locs. The additive property is what makes the already-offset case (a literal in a prelude-template-parsed file) come out right, and it has a dedicated test.

Also reject holes nowhere: holes in the body parse by the existing position rules with zero new code — but the body parses must run in the same *mode* the template path uses (no lowering). `exprParser`/`bodyParser` are mode-free (lowering happens in `parseAgency`), so this holds by construction for kinds 1-2; for kind 3, use the unlowered program production.

- [ ] **Step 4: Wire into `baseAtom` — ordering is load-bearing**

`baseAtom` (`parsers.ts:2937`) has documented ordering discipline for `[`-led parsers: `bracketAccessParser`, then `comprehensionParser`, then `agencyArrayParser`, each with a MUST-precede comment. Insert the literal FIRST among the `[`-led alternatives — `[|` is two fixed characters, the check is cheap, and no other `[`-led form can begin with `|`:

```ts
  lazy(() => interruptExprParser),
  // MUST precede every other `[`-led parser (bracketAccessParser,
  // comprehensionParser, agencyArrayParser): `[|` is unambiguous after
  // two characters, and agencyArrayParser would otherwise consume `[`
  // and die inside the body. Same discipline as the comprehension/array
  // ordering documented below.
  lazy(() => codeLiteralParser),
  lazy(() => bracketAccessParser),
```

- [ ] **Step 5: Parser tests** (`lib/parsers/codeLiteral.test.ts`) — write these FIRST within this task if you prefer strict TDD; either way all must pass before the commit:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

function parseExprStmt(source: string): any {
  const r = parseAgency(source, {}, false, false);
  if (!r.success) throw new Error(r.message);
  return r.result.nodes;
}

describe("code literals: parsing and kind inference", () => {
  it("a lone expression infers expr", () => {
    const [assign] = parseExprStmt(`node main() {\n  const t = [| 1 + 2 |]\n}\n`)
      .find((n: any) => n.type === "graphNode").body
      .filter((n: any) => n.type === "assignment");
    expect(assign.value.type).toBe("codeLiteral");
    expect(assign.value.kind).toBe("expr");
  });

  it("f(1) infers expr (the known ambiguity, resolved by the fill relaxation)", () => { /* same harness, body `[| f(1) |]`, kind "expr" */ });
  it("two statements infer statements", () => { /* body `[| const a = 1\n  print(a) |]`, kind "statements" */ });
  it("a def infers program", () => { /* body with `def g(): number { return 1 }`, kind "program" */ });
  it("holes parse inside bodies by position", () => { /* body with `const x: number = #n`; find hole node, sort "expr" */ });

  it("array literals and comprehensions are untouched by the ordering", () => {
    // The regression pin for baseAtom ordering.
    expect(parseAgency(`node main() {\n  const a = [1, 2]\n}\n`, {}, false, false).success).toBe(true);
    expect(parseAgency(`node main() {\n  const b = [n * 2 for n in xs]\n}\n`, {}, false, false).success).toBe(true);
  });

  // ── End-scan tests: assert BODY CONTENT structurally, never just
  // `.success`. These guard the riskiest code path, and a scan that
  // terminates early can coincidentally still parse — a bare success
  // check is a false green waiting to happen.
  it("|] inside a body string is inert, content intact", () => {
    const lit = firstLiteral(`node main() {\n  const t = [| return "Pick: [x|y|]" |]\n}\n`);
    const text = stringTextOf(lit.nodes[0]); // helper: concat the string nodes text segments
    expect(text).toBe("Pick: [x|y|]");
  });
  it("|] inside a body comment is inert", () => {
    // Body: a comment containing |] followed by a real statement — the
    // statement must be IN the body (the scan did not end at the comment).
    const lit = firstLiteral(
      `node main() {\n  const t = [|\n    // options render as [a|b|]\n    print(1)\n  |]\n}\n`,
    );
    expect(lit.nodes.some((n: any) => n.type === "functionCall" && n.functionName === "print")).toBe(true);
  });
  it("|] inside an interpolations nested string is inert, content intact", () => {
    const lit = firstLiteral(
      `node main() {\n  const t = [| return "\${f("has |] here")}" |]\n}\n`,
    );
    // The interpolations inner string still contains the sequence.
    const printed = generateAgency({ type: "agencyProgram", nodes: lit.nodes });
    expect(printed).toContain("has |] here");
  });
  it("|] in interpolation CODE position is inert (pinned decision)", () => {
    // `"\${ a |] b }"` — the |] is interpolation content of the GENERATED
    // programs string; the string parser consumes the whole interpolation,
    // so the literal does not end there. (The body may then fail to PARSE
    // as Agency — thats fine and separate; this test uses a form that
    // parses: a valid expression around the sequence is not constructible,
    // so pin via the scan alone if needed: the literal must extend past
    // the interpolation. Simplest parseable pin:)
    const lit = firstLiteral(
      `node main() {\n  const t = [| return "\${join(xs, "|]")}" |]\n}\n`,
    );
    const printed = generateAgency({ type: "agencyProgram", nodes: lit.nodes });
    expect(printed).toContain('join(xs, "|]")');
  });
  it("blank lines inside a body survive the sentinel round-trip", () => {
    const lit = firstLiteral(
      `node main() {\n  const t = [|\n    print(1)\n\n    print(2)\n  |]\n}\n`,
    );
    expect(lit.nodes.filter((n: any) => n.type === "functionCall")).toHaveLength(2);
  });
  it("nested [| is a directive error", () => {
    const r = parseAgency(`node main() {\n  const t = [| const x = [| 1 |] |]\n}\n`, {}, false, false);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.message).toMatch(/build the inner piece/);
  });
  it("unclosed literal reports the missing |]", () => {
    const r = parseAgency(`node main() {\n  const t = [| print(1)\n}\n`, {}, false, false);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.message).toMatch(/\|\]/);
  });

  // ── Location mapping: expected lines computed BY HAND from intent,
  // written before running the code. If the observed value disagrees,
  // that is a bug to fix, not a number to copy — this pair exists to
  // catch the stripped-prefix and additivity mistakes specifically.
  it("a parse error inside the body maps to the enclosing files line (no prelude offset)", () => {
    // File (applyTemplate=false, 0-indexed): line 0 `node main() {`,
    // line 1 opens the literal, body line at file line 2 holds the
    // error. Expected reported line: 2.
    const r = parseAgency(`node main() {\n  const t = [|\n    const = broken\n  |]\n}\n`, {}, false, false);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.message).toMatch(/[Ll]ine 3|line: 2/); // adjust to the messages 0/1-index convention — but to the HAND-COMPUTED value
  });
  it("mapping is additive under the prelude template offset", () => {
    // Same source parsed with applyTemplate=true: user-coordinate lines
    // must be IDENTICAL to the previous test (the prelude offset is
    // subtracted globally; the literal shift must not double- or
    // under-count it).
    const r = parseAgency(`node main() {\n  const t = [|\n    const = broken\n  |]\n}\n`, {}, true, false);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.message).toMatch(/[Ll]ine 3|line: 2/); // same hand-computed value as above
  });

  it("empty body is a parse error (decided, not inherited)", () => {
    // Spec open question 2, DECIDED: an empty literal is an error, the
    // same ruling parseStatements("") applies. Asserted as a decision —
    // if parseStatements ever changes, this test forces the literal
    // ruling to be revisited deliberately rather than drifting.
    expect(parseAgency(`node main() {\n  const t = [| |]\n}\n`, {}, false, false).success).toBe(false);
  });
});
```

`firstLiteral(source)` is a local helper: parse (template mode), walk with `walkNodesArray`, return the first `codeLiteral` node (throw if none). `stringTextOf` concatenates a string nodes text segments. The one- vs zero-index convention in error messages: read one real parse-error message first, then write BOTH location tests against the hand-computed line in that convention — never against an observed literal-test output.

- [ ] **Step 6: Run, iterate, commit** — `pnpm test:run lib/parsers/ > /tmp/claude-cl-t3.log 2>&1` until green, then full suite; commit.

---

### Task 4: Host-side leaf-ness — four levers, each with its enforcement

**Files:**
- Modify: `lib/utils/expressionSlots.ts` (`NO_EXPRESSION_SLOTS`)
- Modify: `lib/utils/expressionSlots.test.ts` (`WALKER_EXCLUDED_FIELDS`)
- Modify: `lib/utils/bodySlots.ts` (comment only)
- Create: additions to `lib/utils/bodySlots.test.ts`

The spec names four levers. Three need edits; one needs only its test.

- [ ] **Step 1: `NO_EXPRESSION_SLOTS`** — in `expressionSlots.ts`, after the `hole` entry:

```ts
  // A code literal is a leaf like `hole`: it STANDS FOR a value; its
  // body is quoted code whose names belong to the generated program.
  // Host rewriters must never enter it.
  codeLiteral: true,
```

The completeness test then passes only with this registered — that's the forcing function; no new test needed.

- [ ] **Step 2: The tripwire ruling** — in `expressionSlots.test.ts`, `WALKER_EXCLUDED_FIELDS`:

```ts
  "codeLiteral.nodes":
    "quoted code: names belong to the generated program, not the host scope; " +
    "hygiene for them runs at fill time on the runtime Code value",
```

Without this, the structural-reachability invariant fails on the first corpus file containing a literal (none exist yet — Task 8's fixtures make this live; the entry goes in now so the invariant never goes red in between). The corpus ALSO needs a literal-bearing file for the ruling to shield anything — that arrives with Task 8's generator fixture; note it in the entry's commit message.

- [ ] **Step 3: `bodySlots` non-registration** — this lever is the *absence* of a case, so it gets a comment where someone would helpfully add one (in `bodySlots.ts`, near the switch's default) and a pinning test:

```ts
// codeLiteral is deliberately ABSENT from this table. Its `nodes` field
// looks like a statement body but is QUOTED code — registering it would
// send walkNodes (and every consumer of the generic body descent) into
// the generated program's names. See docs/dev/template-agency.md.
```

Test in `bodySlots.test.ts`:

```ts
it("codeLiteral is not a body-bearing node (quoted code stays quoted)", () => {
  const parsed = parseAgency(`node main() {\n  const t = [| print(1) |]\n}\n`, {}, false, false);
  if (!parsed.success) throw new Error(parsed.message);
  const lit = walkNodesArray(parsed.result.nodes)
    .map((v) => v.node)
    .find((n) => n.type === "codeLiteral");
  expect(lit).toBeDefined();
  expect(bodySlots(lit as AgencyNode)).toEqual([]);
  // And the walker never yields the quoted call:
  const yielded = walkNodesArray(parsed.result.nodes).map((v) => v.node);
  expect(yielded.some((n: any) => n.type === "functionCall" && n.functionName === "print")).toBe(false);
});
```

- [ ] **Step 4: The old corpus invariants** — no code change. They descend into bodies by design (node-local checks hold for any well-formed node). Confirm by running the whole `expressionSlots.test.ts` file after Task 8's fixture exists.

- [ ] **Step 5: Run affected suites, full suite, commit.**

---

### Task 5: Formatter printing

**Files:**
- Modify: `lib/backends/agencyGenerator.ts` (a `codeLiteral` case)
- Modify: `lib/backends/agencyGenerator.roundtrip.test.ts` (literal fixtures join the gate)

- [ ] **Step 1: The printing case** — in the generator's expression dispatch, print `[|`, the body one indent level deeper via the generator's own node printing, `|]`:

```
[|
  <canonically formatted body, at +1 indent>
|]
```

Follow the file's existing indent conventions (`this.increaseIndent()` / `indentStr`) — study `processTypeAlias` and the block-printing neighbors first and mirror them. An `expr`-kind body prints inline when it fits: `[| 1 + 2 |]`. Decide single-line-vs-multi-line by the same rule the formatter uses elsewhere (if there is one — otherwise: `expr` kind prints inline, other kinds print multi-line; record the rule in a comment).

- [ ] **Step 2: Extend the gate** — add to the round-trip test a small in-memory corpus of literal-bearing sources (expr kind, statements kind, program kind with holes, a body containing `|]` in a string, a mis-indented body) and assert: round-trip structural identity, idempotence, and that the mis-indented body comes out canonically formatted. Then `pnpm run fmt` on a scratch file in the repo containing a literal and eyeball once.

- [ ] **Step 3: Run the gate + full suite, commit.**

---

### Task 6: Codegen and the runtime constructor

**Files:**
- Create: `lib/runtime/template/literal.ts`
- Modify: `lib/runtime/index.ts` (export)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` (add `__codeLiteral` to the `"agency-lang/runtime"` import batch) + `pnpm run templates`
- Modify: `lib/backends/typescriptBuilder.ts` (a `codeLiteral` case in `processNode`)

**Interfaces:**
- Produces: generated TS containing `__codeLiteral(<sourceString>, <kind>)`, returning the same `Code` shape `loadTemplateFromString` builds. Task 7 types the literal; Task 8 executes it.

- [ ] **Step 1: The runtime constructor**

`lib/runtime/template/literal.ts` (runtime → parsers imports have precedent: `fill.ts` imports `LEGAL_IDENTIFIER` from parsers). The constructor does NOT run its own grammar choice — it calls the same exported `parseCodeLiteralBody` the compile-side parser used (Task 3), so compile-time and runtime reconstruction share one code path and cannot diverge by drift. The recorded kind double-checks the inference:

```ts
import { parseCodeLiteralBody } from "../../parsers/parsers.js";
import { Code } from "./code.js";

/** Reconstructs a code literals value at runtime from its canonical
 *  printed body, through the SAME per-kind parse (parseCodeLiteralBody)
 *  the compiler used — the program grammar alone would reject an
 *  expr-kind body, and sharing the entry point is what makes
 *  compile-time and runtime agree by construction. The body was already
 *  validated at compile time; a failure or kind mismatch here means the
 *  two stages parsed differently, which is a bug worth a loud error. */
export function __codeLiteral(source: string, kind: Code["kind"]): Code {
  const parsed = parseCodeLiteralBody(source);
  if (!parsed.ok) {
    throw new Error(
      `internal: a code literal that parsed at compile time failed to re-parse at runtime: ${parsed.error}`,
    );
  }
  if (parsed.kind !== kind) {
    throw new Error(
      `internal: a code literals kind changed between compile time (${kind}) and runtime (${parsed.kind})`,
    );
  }
  return { type: "agencyProgram", kind, nodes: parsed.nodes };
}
```

- [ ] **Step 2: Export + import template** — add `__codeLiteral` to `lib/runtime/index.ts` exports and to the `"agency-lang/runtime"` import list in `imports.mustache`; run `pnpm run templates`.

- [ ] **Step 3: The builder case** — in `processNode`, `case "codeLiteral"`: emit a call `__codeLiteral(<JSON.stringify of the canonical printed body>, <JSON.stringify of kind>)`. The printed body comes from the generator (Task 5's printing of `node.nodes` WITHOUT the brackets — factor the body-printing into a helper both the formatter case and the builder use, so what codegen embeds and what `fmt` shows are the same text, as the spec promises). Mirror the emission mechanics of an existing runtime-helper call — grep `__nn(` in `typescriptBuilder.ts` for the pattern of building a call in the TS IR.

- [ ] **Step 4: First execution proof** — compile-and-run by hand before writing fixtures:

```bash
printf 'import { toSource } from "std::agency"\n\nnode main(): string {\n  const t = [| print(1) |]\n  return toSource(t)\n}\n' > scratch-lit.agency
pnpm run agency scratch-lit.agency > /tmp/claude-cl-t6run.log 2>&1; tail -5 /tmp/claude-cl-t6run.log
rm scratch-lit.agency
```

Expected: prints `print(1)`. (Note `toSource` takes the `Code` directly — a literal is not a `Result`; nothing can fail at runtime.)

- [ ] **Step 5: Full suite, lint, commit.**

---

### Task 7: Typechecker

**Files:**
- Modify: `lib/typeChecker/synthesizer.ts` (a `codeLiteral` case)
- Create/extend: `lib/typeChecker/codeLiteral.test.ts` (or the existing holes.test.ts harness)

**Design, per the spec's open question 1, resolved structurally:** Agency record types are structural, so the literal synthesizes the *structural equivalent* of `stdlib/agency.agency`'s `Code` (`{ type: "agencyProgram"; kind?: ...; nodes: any[]; docComment?: any }` — verified at `agency.agency:522`). No nominal-naming mechanism needed: a literal-typed value flows into `fill(template: Code, ...)` by structural compatibility. Build the type once by parsing it with the type-hint parser (one source of truth, no hand-built node tree):

```ts
// In synthesizer.ts, module scope. The type/kind fields are the EXACT
// literal and union from stdlib Code — structural assignability into a
// literal-typed field is directional, so `type: string` here would be
// WIDER than Codes `type: "agencyProgram"` and the fill() call would
// fail to typecheck. Matching the literal/union exactly is what makes
// the compatibility proof below pass.
const CODE_LITERAL_TYPE = parseTypeHintOnce(
  '{ type: "agencyProgram", kind?: "program" | "statements" | "expr", nodes: any[], docComment?: any }',
);
```

(`parseTypeHintOnce` = call the existing type parser from `parsers.ts` at module init and assert success — find the type-hint parser's exported name; `holeParser`'s annotation capture uses it, so it exists and is exported or exportable.)

```ts
    case "codeLiteral":
      // A literal IS a Code value. Structural typing carries it into
      // fill()/holesOf()/toSource() without naming the stdlib alias.
      // The body is quoted — never type-checked here; the completed
      // program is checked in full at its own compile.
      return CODE_LITERAL_TYPE;
```

- [ ] **Step 1: Write the tests** — using the explicit-config harness pattern from `lib/typeChecker/holes.test.ts` (that file learned the hard way that default severities hide checks):
  - a literal assigned to a `Code`-annotated variable typechecks;
  - `fill(lit, {...})` through `std::agency` typechecks (the structural-compatibility proof — this is the test that matters);
  - names inside the body produce NO undefined-variable diagnostics in the host — and for this test to be non-vacuous the body MUST reference a name that would be undefined in host scope (e.g. the body calls `definitelyNotAHostName()`), with a sanity anchor asserting the same name at host level DOES diagnose;
  - a literal in a definite-return position doesn't confuse `definiteReturns` (a function whose body is `return [| ... |]` is definitely-returning).

- [ ] **Step 2: Implement, run, full suite, commit.**

---

### Task 8: Execution fixtures, docs, and the corpus literal

**Files:**
- Create: `tests/agency/templates/literalCompose.agency` + `.test.json`
- Create: `tests/agency/templates/literalAcrossCheckpoint.agency` + `.test.json`
- Create: `tests/typescriptGenerator/codeLiteral.agency` (+ regenerate fixtures)
- Modify: `docs/site/guide/templates.md`, `docs/dev/template-agency.md`

- [ ] **Step 1: The compose fixture** — the spec's worked example, trimmed to runner conventions (study `composeGuarded.agency` + its `.test.json` first; `isFailure` spelling; no `loadTemplate` interrupts needed since literals load nothing):

```
import { fill, holesOf, toSource, runCode } from "std::agency"

node main(): string {
  const guardTpl = [|
    def guarded(): string {
      const ms: number = #minutes
      #body
      return "lit-ok"
    }
  |]
  const mainTpl = [|
    #helpers

    export node main(): string {
      return guarded()
    }
  |]
  const body = [| print("step") |]
  const partial = fill(guardTpl, { body: body })
  if (isFailure(partial)) {
    return "guard fill failed: ${partial.error}"
  }
  const program = fill(mainTpl, { helpers: partial.value })
  if (isFailure(program)) {
    return "compose failed: ${program.error}"
  }
  const remaining = holesOf(program.value)
  if (remaining.length != 1) {
    return "wrong hole count: ${remaining.length}"
  }
  if (remaining[0].origin != "helpers") {
    return "origin missing"
  }
  const done = fill(program.value, { minutes: 120000 })
  if (isFailure(done)) {
    return "final fill failed: ${done.error}"
  }
  return runCode(toSource(done.value))
}
```

Expected output `"lit-ok"` (`.test.json` per house convention; `runCode` may need a handler/approve depending on effects — mirror how composeGuarded's json handles it). This one fixture exercises: inline literals of all three kinds (`expr` body via the relaxation, `program` kinds), partial fill, composition, origin, and the generated program actually running.

- [ ] **Step 2: The checkpoint fixture** — mirror `codeAcrossCheckpoint.agency`: hold a literal-built `Code` in a variable across an interrupt/resume, then `toSource` it after — pins serialization (the spec's "indistinguishable from file-loaded" claim under state restoration). Interrupt handling in the `.test.json` mirrors the existing fixture.

- [ ] **Step 3: The corpus literal** — `tests/typescriptGenerator/codeLiteral.agency` with literals of each kind (this is what makes Task 4's `WALKER_EXCLUDED_FIELDS` ruling live — the tripwire's staleness expectations and reachability invariant now exercise real literal nodes) plus its generated `.mjs` via `make fixtures`. Then run the whole `expressionSlots.test.ts` and confirm every invariant is green with literals in the corpus.

- [ ] **Step 4: The equivalence test** — unit test: `toSource` of a literal-built value equals `generateAgency` of the equivalent file-template parse. This tests one printer, not two: `_toSource` IS `generateAgency` (`lib/stdlib/template.ts:33`, verified), so equality here pins the "indistinguishable from file-loaded" property rather than comparing independent implementations.

- [ ] **Step 4b: The `${}` passthrough fixture** — the no-splice divergence is a headline promise with no end-to-end proof yet. Execution fixture: a literal whose body is `return "got ${x}"` inside a generated def taking `x`; fill nothing related to `x`; `runCode` the program with the def called on a known value; expected output proves the interpolation ran in the GENERATED program (and `holesOf` never saw an `x` hole). Sibling unit assertion: `toSource` of the literal contains `${x}` verbatim.

- [ ] **Step 4c: The compile-error fixture** — the whole pitch is "compile error, not runtime error," tested so far only at parser-unit level. Use the `expectedCompileError` runner mode (#662): `tests/agency/templates/literalBadBody.agency` containing a literal whose body is malformed, with a `.test.json` expecting compilation to fail — proving the error surfaces through the real compile path, not just the unit harness.

- [ ] **Step 4d: The golden fmt fixture** — eyeballing is not a regression test. Add a formatter golden pair: an input `.agency` file containing literals (mis-indented body, an expr-kind literal, a body with a comment) and the exact expected `fmt` output, asserted byte-for-byte in a unit test (follow whatever golden-file convention the formatter tests already use; if none exists, an inline expected-string in `agencyGenerator.roundtrip.test.ts` is fine). This is the only thing that catches a text-level formatting regression later — the structural gate cannot.

- [ ] **Step 5: Docs** — guide (`templates.md`): a "Writing templates inline" section after the loading section — the literal form, kind inference in one sentence, the no-`$()` note for TH readers, `${}`-passes-through example, fmt-reformats-bodies behavior, nesting ban with the compose-instead idiom. Dev doc (`template-agency.md`): the four leaf-ness levers, the end-scan, the shared body-print helper between formatter and codegen, the runtime constructor contract.

- [ ] **Step 6: Run the two agency fixtures individually, full unit suite, lint, commit.**

---

### Task 9: PR

- [ ] **Step 1: Anti-pattern audit** — `git diff origin/main...HEAD` against `docs/dev/anti-patterns.md`.
- [ ] **Step 2: LSP smoke note** — the LSP treats the literal as an opaque expression; run the LSP test suite (`pnpm test:run lib/lsp/ > /tmp/claude-cl-lsp.log 2>&1`) and note any literal-file behavior in the PR rather than fixing beyond tolerance.
- [ ] **Step 3: Push and open the PR** — body written to a file; covers: the spec link, the formatter gate results (and any generator fixes it forced), the relaxation as a standalone commit (with the inverted test named), the four leaf-ness levers, the end-scan zero-escaping design with the interpolation corner test, location-mapping additivity, the structural-`Code` typing decision (spec open question 1 resolved structurally, with the `fill()` compatibility test as proof), and the empty-body ruling (open question 2: parse error, matching `parseStatements("")`). Standard footer. CI runs the agency suite.

---

## Self-review notes

- **Spec coverage:** every design-section commitment maps to a task — end-scan/zero-escaping (T3), kind inference + relaxation (T2, T3), nesting ban (T3), AST node + parse timing + location mapping (T3), leaf-ness levers (T4), codegen/runtime construction (T6), fmt-reformats-bodies + gate (T1, T5), holes-unchanged (T3 test), worked example (T8), equivalence property (T8), both open questions resolved and pinned (T7 structural typing; T3 empty-body test). Out-of-scope items (splices, variant quoters, LSP highlighting, nested literals) appear only as tests of their absence or PR notes.
- **Known unknowns, called out in place:** whether the program-grammar entry point is directly callable from `parsers.ts` without a cycle (T3 Step 3, with the injection fallback); the type-hint parser's exported name (T7); the generator's inline-vs-multiline convention (T5); `runCode` handler needs in the compose fixture's json (T8). Each is a look-and-mirror, not a design hole.
- **Order rationale:** the gate first (it can change the fmt decision, which is owner-level); the relaxation second (independent, and T3's inference tests reference it); parser before leaf-ness (T4's tests need parseable literals); formatter before codegen (T6 reuses T5's body-print helper); fixtures last (they make T4's tripwire ruling live).
- **Type consistency:** `CodeLiteral { nodes, kind }` used identically in T3/T4/T5/T6/T7; `parseCodeLiteralBody` is one exported function consumed by both the T3 parser and T6's `__codeLiteral`; `WALKER_EXCLUDED_FIELDS["codeLiteral.nodes"]` matches the T4 entry and T8's corpus activation; the synthesized type's `type`/`kind` fields are the exact literal/union from stdlib `Code`.
- **Plan-review findings applied (2026-07-24):** #1 exact literal/union in the synthesized type; #2 strippedPrefix folded into the loc shift, location tests hand-computed with an additive prelude-offset sibling; #3 `__codeLiteral` shares `parseCodeLiteralBody` (the contradicted program-grammar block is gone); #4 injection is the default for the program parse; the end-scan is rebuilt on the existing comment/string parsers (no second lexer, no magic numbers, no one-line ifs); end-scan tests assert body content structurally, incl. the interpolation-code-position pin; relaxation gains preserved-row guards; `${}` passthrough, expectedCompileError, and golden-fmt fixtures added; the loc-shift walker's non-reuse of `walkNodesArray` is a documented ruling (walker gaps still need shifting); empty-body is asserted as a decision.
