# Giving the Agency agent the standard-library docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Agency agent a browsable, per-module-summarized view of the 64 `std::` standard-library docs, so it knows what each module is for.

**Architecture:** Two independent pieces. (1) The `agency doc` generator learns to emit a `description:` frontmatter field for each module, derived from the module's existing `@module` comment (with an optional `@summary` override), so the summary the agent's doc tool already renders is finally populated. (2) A new `"stdlib"` section is added to `docsSkill`, staged into the shipped docs, globbed recursively (29 of 64 modules are nested), and registered as a tool in the code / research / explorer subagents.

**Tech Stack:** TypeScript (the compiler / doc generator, `lib/cli/doc.ts`; the skills helpers, `lib/stdlib/skills.ts`), Agency (`stdlib/skills.agency` and the three subagent `.agency` files), GNU make (staging), Vitest (TS tests), the Agency execution-test runner (`pnpm run agency test`).

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-07-17-stdlib-docs-summary-for-agent-design.md`). Every task implicitly includes these.

- **No new language syntax or AST changes.** `@summary` is a convention parsed inside `lib/cli/doc.ts`, not a tag the language parser/preprocessor/AST knows about.
- **The `description` value must be valid for BOTH consumers.** Emit it as a **double-quoted** scalar whose content has had `"` and `\` **removed** (mirror `name`'s `title.replace(/["\\\n]/g, "")` at `lib/cli/doc.ts:169`). NOT bare (breaks VitePress strict YAML on colon-space summaries). NOT escaped (`\"` survives literally through tarsec's `stripQuotes` and reaches the agent).
- **Fence detection trims leading whitespace first.** `@module` code fences render indented (`  ```ts`), so a raw `startsWith("```")` misses them.
- **Length cap: 200 characters**, truncated at the last word boundary, with `…` appended.
- **A module with no `@module` comment emits no `description:` field** (today's behavior) — never an empty one. `std::mcp` is the one such module.
- **Do not add code comments explaining the change** (repo rule, `CLAUDE.md`); preserve existing comments. Mimic surrounding style. Run `typecheck`/tests before claiming done.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/cli/doc.ts` | Doc generator | Add pure helpers to derive the description from `@module`; emit `description:` in frontmatter; strip the `@summary` line from the rendered body. |
| `lib/cli/doc.test.ts` | Doc generator tests | New unit tests for the helpers + integration tests through `generateDoc`. |
| `packages/agency-lang/makefile` | Build/staging | Add `docs/site/stdlib` to `stage-stdlib-docs`. |
| `lib/stdlib/skills.ts` | Skills TS helpers | Widen `_docsDir`'s section union to include `"stdlib"`. |
| `lib/stdlib/skills.test.ts` | Skills helper tests | Add `_docsDir("stdlib")` test + recursive-glob regression test. |
| `stdlib/skills.agency` | `docsSkill` / `buildSkillsTool` | Widen the `docsSkill` union; add a `recursive` flag to `buildSkillsTool`; `docsSkill` opts in. |
| `lib/agents/agency-agent/subagents/code.agency` | Code subagent | Register `docsSkill("stdlib")` + prompt note. |
| `lib/agents/agency-agent/subagents/research.agency` | Research subagent | Register `docsSkill("stdlib")` + prompt note. |
| `lib/agents/agency-agent/subagents/explorer.agency` | Explorer subagent | Register `docsSkill("stdlib")` + prompt note. |
| `docs/site/stdlib/*.md` | Generated stdlib docs (committed) | Regenerated with `description:` frontmatter (Task 4). |
| Selected `stdlib/*.agency` | Stdlib sources | `@summary` overrides for the few over-long first paragraphs (Task 4). |

All commands below run from `packages/agency-lang/` unless stated otherwise.

---

## Task 1: Derive and emit the `description` frontmatter in `agency doc`

This is the whole of Gap 1 and the highest-value change. All logic is pure TypeScript in `lib/cli/doc.ts`, tested with fast Vitest unit + integration tests.

**Files:**
- Modify: `lib/cli/doc.ts` (add helpers near the other formatting functions; edit the frontmatter emission at `:170` and the module-body push at `:178-180`)
- Test: `lib/cli/doc.test.ts`

**Interfaces:**
- Consumes: `program.docComment?: AgencyMultiLineComment` (already populated by `preprocessProgram` → `attachDocComments`); `AgencyMultiLineComment` is already imported at `doc.ts:6`.
- Produces (exported, for tests and Task-1 reuse):
  - `extractSummaryOverride(content: string): { override: string | null; body: string }`
  - `firstParagraph(body: string): string`
  - `sanitizeDescription(raw: string): string`
  - `moduleDescription(comment: AgencyMultiLineComment | undefined): string | null`

- [ ] **Step 1: Write the failing unit tests for the helpers**

Add to `lib/cli/doc.test.ts` (top-level, after the existing imports add the new imports):

```ts
import {
  extractSummaryOverride,
  firstParagraph,
  sanitizeDescription,
  moduleDescription,
} from "./doc.js";
import type { AgencyMultiLineComment } from "@/types.js";

function moduleComment(content: string): AgencyMultiLineComment {
  return {
    type: "multiLineComment",
    content,
    isDoc: true,
    isModuleDoc: true,
  } as AgencyMultiLineComment;
}

describe("firstParagraph", () => {
  it("takes the leading prose and stops at a blank line", () => {
    expect(firstParagraph("\n  One. Two.\n\n  Later.")).toBe("One. Two.");
  });

  it("stops at an indented code fence (trims before the check)", () => {
    expect(firstParagraph("\n  First line.\n  ```ts\n  code\n  ```\n")).toBe(
      "First line.",
    );
  });

  it("collapses internal whitespace and newlines to single spaces", () => {
    expect(firstParagraph("\n  a\n  b   c\n")).toBe("a b c");
  });

  it("returns empty string when there is no prose", () => {
    expect(firstParagraph("\n\n")).toBe("");
  });
});

describe("extractSummaryOverride", () => {
  it("pulls a leading @summary line and removes it from the body", () => {
    const { override, body } = extractSummaryOverride(
      "\n  @summary Short thing.\n  Long body prose.\n",
    );
    expect(override).toBe("Short thing.");
    expect(body).not.toContain("@summary");
    expect(body).toContain("Long body prose.");
  });

  it("returns null override and unchanged body when there is no @summary", () => {
    const { override, body } = extractSummaryOverride("\n  Just prose.\n");
    expect(override).toBeNull();
    expect(body).toBe("\n  Just prose.\n");
  });

  it("treats a bare @summary with no text as no override", () => {
    const { override } = extractSummaryOverride("\n  @summary\n  Body.\n");
    expect(override).toBeNull();
  });
});

describe("sanitizeDescription", () => {
  it("removes double quotes and backslashes", () => {
    expect(sanitizeDescription('e.g. "America/New_York" path\\x')).toBe(
      "e.g. America/New_York pathx",
    );
  });

  it("caps at 200 chars on a word boundary and appends an ellipsis", () => {
    const long = "word ".repeat(60).trim(); // ~299 chars
    const out = sanitizeDescription(long);
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("wor…"); // no mid-word cut
  });
});

describe("moduleDescription", () => {
  it("derives from the first paragraph when there is no @summary", () => {
    expect(
      moduleDescription(moduleComment("\n  Fetch URLs. Returns text.\n\n  ```ts\n  x\n  ```")),
    ).toBe("Fetch URLs. Returns text.");
  });

  it("prefers an explicit @summary override", () => {
    expect(
      moduleDescription(moduleComment("\n  @summary Short.\n  Long prose.")),
    ).toBe("Short.");
  });

  it("returns null when the comment is missing", () => {
    expect(moduleDescription(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run lib/cli/doc.test.ts 2>&1 | tee /tmp/t1.txt`
Expected: FAIL — the four new symbols are not exported from `./doc.js`.

- [ ] **Step 3: Implement the helpers in `lib/cli/doc.ts`**

Add this block near the other top-level helper functions (e.g. just above `formatDocComment` at `:275`):

```ts
const DESCRIPTION_CAP = 200;

export function extractSummaryOverride(content: string): {
  override: string | null;
  body: string;
} {
  const lines = content.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return { override: null, body: content };
  const first = lines[firstIdx].trim();
  if (first.startsWith("@summary")) {
    const text = first.slice("@summary".length).trim();
    const rest = lines.slice(0, firstIdx).concat(lines.slice(firstIdx + 1));
    return {
      override: text === "" ? null : text,
      body: rest.join("\n"),
    };
  }
  return { override: null, body: content };
}

export function firstParagraph(body: string): string {
  const out: string[] = [];
  let started = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!started) {
      if (trimmed === "") continue;
      started = true;
    }
    if (trimmed === "" || trimmed.startsWith("```")) break;
    out.push(trimmed);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

export function sanitizeDescription(raw: string): string {
  const cleaned = raw.replace(/["\\]/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= DESCRIPTION_CAP) return cleaned;
  const slice = cleaned.slice(0, DESCRIPTION_CAP);
  const lastSpace = slice.lastIndexOf(" ");
  const truncated = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return truncated + "…";
}

export function moduleDescription(
  comment: AgencyMultiLineComment | undefined,
): string | null {
  if (!comment) return null;
  const { override, body } = extractSummaryOverride(comment.content);
  const raw = override ?? firstParagraph(body);
  if (!raw) return null;
  const value = sanitizeDescription(raw);
  return value === "" ? null : value;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run lib/cli/doc.test.ts 2>&1 | tee /tmp/t1.txt`
Expected: PASS (all new `describe` blocks green).

- [ ] **Step 5: Write the failing integration tests through `generateDoc`**

Add to `lib/cli/doc.test.ts`, inside the existing `describe("generateDoc", ...)` block:

```ts
it("emits a description derived from the @module comment", () => {
  const inputDir = path.join(tmpDir, "input-desc");
  const outputDir = path.join(tmpDir, "output-desc");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "m.agency"),
    "/** @module\n" +
      "  Fetch URLs from Agency code. Returns text, JSON, or Markdown.\n\n" +
      "  ```ts\n  import { fetch } from \"std::http\"\n  ```\n*/\n" +
      "export def f(): string { return \"\" }\n",
  );
  generateDoc({}, path.join(inputDir, "m.agency"), outputDir);
  const out = fs.readFileSync(path.join(outputDir, "m.md"), "utf-8");
  expect(out).toContain(
    'description: "Fetch URLs from Agency code. Returns text, JSON, or Markdown."',
  );
});

it("removes quotes but keeps colon-space safe (valid for both YAML parsers)", () => {
  const inputDir = path.join(tmpDir, "input-quote");
  const outputDir = path.join(tmpDir, "output-quote");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "q.agency"),
    "/** @module\n" +
      "  Helpers: builds strings, e.g. \"America/New_York\" values.\n*/\n" +
      "export def f(): string { return \"\" }\n",
  );
  generateDoc({}, path.join(inputDir, "q.agency"), outputDir);
  const out = fs.readFileSync(path.join(outputDir, "q.md"), "utf-8");
  expect(out).toContain(
    'description: "Helpers: builds strings, e.g. America/New_York values."',
  );
  expect(out).not.toContain('\\"'); // never escaped — would survive literally through tarsec
});

it("uses @summary as the description and strips it from the body", () => {
  const inputDir = path.join(tmpDir, "input-sum");
  const outputDir = path.join(tmpDir, "output-sum");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "s.agency"),
    "/** @module\n" +
      "  @summary Read and write the clipboard.\n" +
      "  The clipboard module exposes copy and paste.\n*/\n" +
      "export def f(): string { return \"\" }\n",
  );
  generateDoc({}, path.join(inputDir, "s.agency"), outputDir);
  const out = fs.readFileSync(path.join(outputDir, "s.md"), "utf-8");
  expect(out).toContain('description: "Read and write the clipboard."');
  expect(out).toContain("The clipboard module exposes copy and paste.");
  expect(out).not.toContain("@summary");
});

it("emits no description when there is no @module comment", () => {
  const inputDir = path.join(tmpDir, "input-nomod");
  const outputDir = path.join(tmpDir, "output-nomod");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(
    path.join(inputDir, "n.agency"),
    "export def f(): string { return \"\" }\n",
  );
  generateDoc({}, path.join(inputDir, "n.agency"), outputDir);
  const out = fs.readFileSync(path.join(outputDir, "n.md"), "utf-8");
  expect(out).not.toContain("description:");
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `pnpm exec vitest run lib/cli/doc.test.ts 2>&1 | tee /tmp/t1.txt`
Expected: FAIL — the generator does not yet emit `description:`, and does not strip `@summary` from the body.

- [ ] **Step 7: Wire the helpers into `generateDocForFile`**

In `lib/cli/doc.ts`, replace the frontmatter line (currently `:170`):

```ts
  const frontmatter = `---\nname: "${safeName}"\n---`;
```

with:

```ts
  const fmLines = [`name: "${safeName}"`];
  const description = moduleDescription(program.docComment);
  if (description) {
    fmLines.push(`description: "${description}"`);
  }
  const frontmatter = `---\n${fmLines.join("\n")}\n---`;
```

Then replace the module-body push (currently `:178-180`):

```ts
  if (program.docComment) {
    sections.push(formatDocComment(program.docComment));
  }
```

with (strip the `@summary` line so it never renders on the page):

```ts
  if (program.docComment) {
    const { body } = extractSummaryOverride(program.docComment.content);
    sections.push(body.trim());
  }
```

- [ ] **Step 8: Run the full doc test file to verify everything passes**

Run: `pnpm exec vitest run lib/cli/doc.test.ts 2>&1 | tee /tmp/t1.txt`
Expected: PASS (helpers + integration + the pre-existing tests still green).

- [ ] **Step 9: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | tee /tmp/tc1.txt`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add lib/cli/doc.ts lib/cli/doc.test.ts
git commit -m "agency doc: emit a description frontmatter field from @module"
```

---

## Task 2: Add the `"stdlib"` docs section (stage + resolve + recursive glob)

Wire the stdlib docs into the packaged docs and teach `docsSkill` to serve them, including the 29 nested modules.

**Files:**
- Modify: `packages/agency-lang/makefile` (the `stage-stdlib-docs` define, `:31-37`)
- Modify: `lib/stdlib/skills.ts` (`_docsDir`, `:36`)
- Modify: `stdlib/skills.agency` (`buildSkillsTool` `:187`, `docsSkill` `:239`)
- Test: `lib/stdlib/skills.test.ts`

**Interfaces:**
- Consumes: `_glob(pattern, dir, maxResults, allowedPaths)` from `lib/stdlib/shell.ts` (recurses via `walkDir`); `getStdlibDir()` from `lib/importPaths.js`.
- Produces: `_docsDir("stdlib")` resolving to `<stdlib>/docs/stdlib`; `docsSkill("stdlib")` returning a tool whose description lists all 64 modules with their `location` (subdir-qualified for nested ones).

- [ ] **Step 1: Write the failing `_docsDir` + recursion tests**

Add to `lib/stdlib/skills.test.ts`. Extend the imports to include `_glob`, then add:

```ts
import { _glob } from "./shell.js";

describe("_docsDir stdlib section", () => {
  it("resolves the stdlib section under docs/", () => {
    expect(
      _docsDir("stdlib").endsWith(path.join("docs", "stdlib")),
    ).toBe(true);
  });
});

describe("stdlib docs recursive glob", () => {
  // The stdlib docs tree has nested modules (ui/table.md, auth/oauth.md, …).
  // A non-recursive `*.{md,markdown}` drops them; `**/*.{md,markdown}` must not.
  const stdlibDocs = path.resolve(__dirname, "../../docs/site/stdlib");

  it("includes nested modules that the flat pattern misses", async () => {
    const flat = await _glob("*.{md,markdown}", stdlibDocs, 500, []);
    const recursive = await _glob("**/*.{md,markdown}", stdlibDocs, 500, []);
    expect(recursive.length).toBeGreaterThan(flat.length);
    expect(recursive).toContain("ui/table.md"); // nested
    expect(recursive).toContain("array.md"); // top-level still present
  });
});
```

- [ ] **Step 2: Run to verify the recursion test passes and `_docsDir` fails to typecheck/compile**

Run: `pnpm exec vitest run lib/stdlib/skills.test.ts 2>&1 | tee /tmp/t2.txt`
Expected: the recursion test PASSES already (it only exercises `_glob`, which recurses); the `_docsDir("stdlib")` test FAILS to compile because `"stdlib"` is not in the section union yet.

- [ ] **Step 3: Widen `_docsDir` in `lib/stdlib/skills.ts`**

Replace (`:36`):

```ts
export function _docsDir(section: "guide" | "cli" | "diagnostics"): string {
```

with:

```ts
export function _docsDir(section: "guide" | "cli" | "diagnostics" | "stdlib"): string {
```

- [ ] **Step 4: Run to verify the skills tests pass**

Run: `pnpm exec vitest run lib/stdlib/skills.test.ts 2>&1 | tee /tmp/t2.txt`
Expected: PASS (both new describes green).

- [ ] **Step 5: Add the `recursive` flag to `buildSkillsTool` and opt `docsSkill` in (`stdlib/skills.agency`)**

Replace the `buildSkillsTool` signature and pattern block (`:187-190`):

```ts
def buildSkillsTool(dir: string, layout: "flat" | "standard", name: string = "") {
  let pattern = "*/SKILL.md"
  if (layout == "flat") {
    pattern = "*.{md,markdown}"
  }
```

with:

```ts
def buildSkillsTool(dir: string, layout: "flat" | "standard", name: string = "", recursive: boolean = false) {
  let pattern = "*/SKILL.md"
  if (layout == "flat") {
    pattern = "*.{md,markdown}"
    if (recursive) {
      pattern = "**/*.{md,markdown}"
    }
  }
```

Replace the `docsSkill` signature (`:239`) and its body call (`:255`). Signature:

```ts
export def docsSkill(section: "guide" | "cli" | "diagnostics") {
```

becomes:

```ts
export def docsSkill(section: "guide" | "cli" | "diagnostics" | "stdlib") {
```

and update its docstring `@param` line to mention stdlib, e.g.:

```
  @param section - Which documentation set to serve: "guide", "cli", "diagnostics", or "stdlib" (the standard-library reference).
```

Then the body call:

```ts
  return buildSkillsTool(_docsDir(section), "flat")
```

becomes (guide/cli/diagnostics are flat with no nested files, so recursion is a safe no-op for them; it is required for stdlib):

```ts
  return buildSkillsTool(_docsDir(section), "flat", "", true)
```

- [ ] **Step 6: Add `docs/site/stdlib` to the makefile staging**

In `packages/agency-lang/makefile`, replace the `stage-stdlib-docs` define (`:31-37`):

```make
define stage-stdlib-docs
	mkdir -p stdlib/docs
	rm -rf stdlib/docs/guide stdlib/docs/cli stdlib/docs/diagnostics
	cp -r docs/site/guide stdlib/docs/guide
	cp -r docs/site/cli stdlib/docs/cli
	cp -r docs/site/diagnostics stdlib/docs/diagnostics
endef
```

with:

```make
define stage-stdlib-docs
	mkdir -p stdlib/docs
	rm -rf stdlib/docs/guide stdlib/docs/cli stdlib/docs/diagnostics stdlib/docs/stdlib
	cp -r docs/site/guide stdlib/docs/guide
	cp -r docs/site/cli stdlib/docs/cli
	cp -r docs/site/diagnostics stdlib/docs/diagnostics
	cp -r docs/site/stdlib stdlib/docs/stdlib
endef
```

- [ ] **Step 7: Build (compiles the doc.ts change from Task 1 into dist, recompiles stdlib, stages docs)**

Run: `make build && make stdlib 2>&1 | tee /tmp/build2.txt`
Expected: build succeeds; `make stdlib` recompiles `stdlib/skills.agency` and runs `stage-stdlib-docs`, creating `stdlib/docs/stdlib/`.

- [ ] **Step 8: Verify the staged stdlib docs and the compiled skills module exist**

Run: `ls stdlib/docs/stdlib/array.md stdlib/docs/stdlib/ui/table.md && echo OK`
Expected: both paths listed, `OK` printed (top-level and nested both staged).

- [ ] **Step 9: Typecheck**

Run: `pnpm exec tsc --noEmit 2>&1 | tee /tmp/tc2.txt`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/agency-lang/makefile lib/stdlib/skills.ts lib/stdlib/skills.test.ts stdlib/skills.agency stdlib/skills.js
git commit -m "docsSkill: add a recursive stdlib docs section"
```

Note: `stdlib/skills.js` is the agency-compiled sibling regenerated by `make stdlib`; it is committed alongside its source (the repo commits compiled stdlib `.js`). `stdlib/docs/**` is gitignored — do not add it.

---

## Task 3: Register `docsSkill("stdlib")` in the code / research / explorer subagents

Give the three subagents that answer stdlib questions the new tool plus a one-line prompt note.

**Files:**
- Modify: `lib/agents/agency-agent/subagents/code.agency`
- Modify: `lib/agents/agency-agent/subagents/research.agency`
- Modify: `lib/agents/agency-agent/subagents/explorer.agency`
- Test: `lib/agents/agency-agent/tests/toolWiring.agency` (already pings each tool list; the new tool must not collide or produce an invalid schema)

**Interfaces:**
- Consumes: `docsSkill` from `std::skills` (already imported in each subagent).
- Produces: a `stdlibSkill` tool in `codeTools`, `researchTools`, `explorerTools`.

- [ ] **Step 1: code.agency — add the tool constant, list entry, and prompt note**

After the existing docs-skill constants (`code.agency:71-73`):

```ts
static const docSkill = docsSkill("guide")
static const cliSkill = docsSkill("cli")
static const diagnosticsSkill = docsSkill("diagnostics")
```

add:

```ts
static const stdlibSkill = docsSkill("stdlib")
```

In `codeTools`, after `diagnosticsSkill,` (`code.agency:400`) add `stdlibSkill,`.

In `codeSysPrompt`, in the bundled-docs bullet list (`code.agency:99-106`), after the `diagnosticsSkill` bullet add:

```
  * `stdlibSkill` — the standard-library reference (`std::http`,
                 `std::thread`, `std::date`, …); each module lists a
                 one-line summary. Use it to discover which `std::`
                 module does what before importing.
```

- [ ] **Step 2: research.agency — same three edits**

After (`research.agency:32-34`):

```ts
static const docSkill = docsSkill("guide")
static const cliSkill = docsSkill("cli")
static const diagnosticsSkill = docsSkill("diagnostics")
```

add:

```ts
static const stdlibSkill = docsSkill("stdlib")
```

In `researchTools`, after `diagnosticsSkill,` (`research.agency:117`) add `stdlibSkill,`.

In `researchSysPrompt`, in the Agency-docs bullet list (`research.agency:52-58`), after the `diagnosticsSkill` bullet add:

```
    * `stdlibSkill`   — standard-library reference (`std::http`,
                        `std::thread`, …), one summary per module
```

- [ ] **Step 3: explorer.agency — same three edits**

After (`explorer.agency:24-26`):

```ts
static const docSkill = docsSkill("guide")
static const cliSkill = docsSkill("cli")
static const diagnosticsSkill = docsSkill("diagnostics")
```

add:

```ts
static const stdlibSkill = docsSkill("stdlib")
```

In `explorerTools`, after `diagnosticsSkill,` (`explorer.agency:112`) add `stdlibSkill,`.

In `explorerSysPrompt`, in the "How to respond" section (after the "Cast a wide net" bullet, `explorer.agency:51`), add:

```
- **Use the standard-library reference.** For any question about what
  `std::` modules exist or what they do, call `stdlibSkill` — it lists
  every module with a one-line summary, then lets you read any page.
```

- [ ] **Step 4: Rebuild the agents**

Run: `make agents 2>&1 | tee /tmp/build3.txt`
Expected: the three subagent `.agency` files recompile with no errors.

- [ ] **Step 5: Run the tool-wiring execution test**

Run: `pnpm run agency test lib/agents/agency-agent/tests/toolWiring.agency 2>&1 | tee /tmp/toolwiring.txt`
Expected: PASS — `codeToolsHaveUniqueNames`, `researchToolsHaveUniqueNames`, `explorerToolsHaveUniqueNames` each return `ok` (no duplicate tool name, valid schema for the new tool). Under `AGENCY_USE_TEST_LLM_PROVIDER` this needs no API key.

- [ ] **Step 6: Commit**

```bash
git add lib/agents/agency-agent/subagents/code.agency lib/agents/agency-agent/subagents/code.js \
        lib/agents/agency-agent/subagents/research.agency lib/agents/agency-agent/subagents/research.js \
        lib/agents/agency-agent/subagents/explorer.agency lib/agents/agency-agent/subagents/explorer.js
git commit -m "agency-agent: give code/research/explorer the stdlib docs tool"
```

---

## Task 4: Regenerate the stdlib docs and sweep `@summary` overrides onto the long ones

Produce the committed `docs/site/stdlib/*.md` with descriptions, and fix the few whose first paragraph truncates badly.

**Files:**
- Modify (generated, committed): `docs/site/stdlib/**/*.md`
- Modify (sources, as needed): selected `stdlib/*.agency` — add `@summary` lines
- No test file; verification is by inspection + the round-trip already covered in Task 1

**Interfaces:**
- Consumes: the Task 1 generator (already built into `dist/` after Task 2 Step 7).

- [ ] **Step 1: Regenerate the stdlib docs**

Run: `rm -f .agency-build/doc.stamp && make doc 2>&1 | tee /tmp/doc4.txt`
Expected: `agency doc stdlib -o docs/site/stdlib/` runs and rewrites the pages. (Removing the stamp forces regeneration regardless of the incremental cache.)

- [ ] **Step 2: Confirm descriptions landed and spot-check the shape**

Run: `grep -c '^description:' docs/site/stdlib/http.md docs/site/stdlib/math.md docs/site/stdlib/object.md docs/site/stdlib/ui/table.md; grep '^description:' docs/site/stdlib/math.md docs/site/stdlib/object.md`
Expected: each spot-checked file has exactly one `description:` line; `math` and `object` descriptions contain the colon-space text unbroken and wrapped in double quotes (proves the both-parsers rule).

- [ ] **Step 3: Confirm `std::mcp` has no description (no `@module`)**

Run: `grep -c '^description:' docs/site/stdlib/mcp.md || true`
Expected: `0` — the one module without a `@module` comment emits no description, as specified.

- [ ] **Step 4: Find the descriptions that truncated at the cap**

Run: `grep -rl '…"$' docs/site/stdlib | tee /tmp/truncated.txt`
Expected: a short list (e.g. `date.md`). These are the modules whose first paragraph exceeded 200 chars.

- [ ] **Step 5: Add a `@summary` override to each truncated module's source**

For each file listed in Step 4, open the corresponding `stdlib/<name>.agency`, and add a `@summary` as the first line inside its `@module` comment. Example for `stdlib/date.agency`:

```ts
/** @module
  @summary Build timezone-aware ISO 8601 date strings for APIs like Google Calendar.
  Builds timezone-aware ISO 8601 date strings, the format that APIs like Google
  Calendar expect. Every function returns a string, not a Date object. ...
*/
```

Keep each `@summary` under 200 characters and free of `"`/`\`. Do not alter the body prose.

- [ ] **Step 6: Regenerate and re-check truncation is gone for the swept modules**

Run: `rm -f .agency-build/doc.stamp && make doc && grep '^description:' $(cat /tmp/truncated.txt)`
Expected: the swept modules now show the crisp `@summary` text (no trailing `…`).

- [ ] **Step 7: Re-stage the fresh docs so the agent (dev) reads current descriptions**

Run: `make stdlib && grep '^description:' stdlib/docs/stdlib/date.md`
Expected: the staged copy matches the regenerated `docs/site/stdlib/date.md`.

- [ ] **Step 8: Sanity-check the whole tree parses as strict YAML (VitePress guard)**

Run:
```bash
node -e '
const fs=require("fs"),cp=require("child_process");
const files=cp.execSync("find docs/site/stdlib -name \"*.md\"").toString().trim().split("\n");
const m=require("gray-matter");
let bad=0;
for(const f of files){ try{ m(fs.readFileSync(f,"utf8")); }catch(e){ bad++; console.log("YAML FAIL",f,e.message);} }
console.log(bad===0?"all frontmatter valid":`${bad} invalid`);
'
```
Expected: `all frontmatter valid`. (gray-matter is VitePress's front-matter parser; if it is not resolvable, use the repo's `std::markdown` frontmatter via a small `.agency` script instead — either way the check is "every generated page parses.")

- [ ] **Step 9: Commit the regenerated docs and any `@summary` source edits**

```bash
git add docs/site/stdlib stdlib/*.agency stdlib/*.js
git commit -m "stdlib docs: regenerate with descriptions; @summary sweep for long modules"
```

---

## Final verification

- [ ] **Run the two touched TS test files and the wiring test together**

Run:
```bash
pnpm exec vitest run lib/cli/doc.test.ts lib/stdlib/skills.test.ts 2>&1 | tee /tmp/final-ts.txt
pnpm run agency test lib/agents/agency-agent/tests/toolWiring.agency 2>&1 | tee /tmp/final-wiring.txt
```
Expected: all green.

- [ ] **Drive the real agent to confirm it sees the summaries end to end**

Run: `pnpm run agency agent -p "Without reading any files, list the std:: modules you have summaries for and say what std::thread is for."`
Expected: the agent names several `std::` modules and correctly describes `std::thread` from the tool listing's `<description>` (proving the summary reaches the model, not just the file). If it instead reads a file first, that is also acceptable evidence the tool is wired.

- [ ] **Anti-pattern audit before PR**

Review the full diff against `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md` (per the repo's pre-PR rule). Confirm: no code comments added to explain changes; existing comments preserved; style matched; no `as any`; the description rule is strip-not-escape and quoted-not-bare everywhere.

---

## Self-review notes (author)

- **Spec coverage:** Part A → Task 1 (derive + emit + cap + no-`@module`). Part B (`@summary` override, doc-command-only) → Task 1 Steps 3/7 + Task 4 Step 5. Part C step 1 (stage) → Task 2 Step 6. C step 2 (`_docsDir`/`docsSkill` union) → Task 2 Steps 3/5. C step 3 (recursive glob, all 64) → Task 2 Steps 1/5/8. C step 4 (register in subagents) → Task 3. Test plan (round-trip, fence-trim, VitePress-accepts) → Task 1 Steps 1/5, Task 4 Step 8.
- **Both-parsers rule** is enforced in one place (`sanitizeDescription` strips `"`/`\`; emission wraps in quotes) and asserted by the Task 1 "removes quotes but keeps colon-space" test (`not.toContain('\\"')`) and the Task 4 gray-matter sweep.
- **Ordering nuance:** `make all` stages stdlib docs during `compile-agency`, before `doc` regenerates them, so a single `make all` can leave `stdlib/docs/stdlib` one generation stale. Task 2/4 avoid this by explicitly sequencing `make doc` then `make stdlib`; publish regenerates from the committed (already-current) `docs/site/stdlib`, so the tarball is correct.
- **Type consistency:** `moduleDescription` / `extractSummaryOverride` / `firstParagraph` / `sanitizeDescription` names are identical across Task 1 test and implementation; `stdlibSkill` is the constant name in all three subagents.
