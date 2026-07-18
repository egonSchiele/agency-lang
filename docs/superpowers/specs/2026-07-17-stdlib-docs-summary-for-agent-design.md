# Giving the Agency agent the standard-library docs

**Date:** 2026-07-17
**Status:** Design approved, ready for planning
**Branch:** `worktree-stdlib-docs-summary`

## What this is about, in one paragraph

The Agency agent can read the language *guide* but knows nothing about
the standard *library* — the 64 modules under `std::` that do the real
work (`std::http`, `std::thread`, `std::date`, and so on). We want to
hand the agent those docs. The docs already exist, and the agent already
has a mechanism for browsing a folder of docs. The missing pieces are
small but specific: the stdlib docs carry no one-line summary the agent
can scan, and the agent's doc-browsing tool doesn't know the stdlib docs
exist. This spec explains how the agent gets docs today, names the two
gaps precisely, and lays out a fix that leans on machinery already in the
codebase rather than adding new language syntax.

---

## Background: how the agent learns about docs today

To understand the fix, you need to understand one helper and one piece of
metadata. This section walks through both with real examples. If you
already know how `docsSkill` and front matter interact, skip to "The two
gaps."

### The agent browses docs through a "skill tool"

The agent doesn't get the docs pasted into its prompt. That would be
enormous and mostly wasted — a single turn rarely needs more than one or
two doc pages. Instead the agent gets a *tool* it can call to read one
doc file at a time, on demand. The tool's description lists every file
available, so the model can pick the right one.

That tool is built by `docsSkill(...)`, defined in
`stdlib/skills.agency`. The code subagent, for example, wires up three of
them (`lib/agents/agency-agent/subagents/code.agency:71`):

```ts
static const docSkill = docsSkill("guide")          // the language guide
static const cliSkill = docsSkill("cli")            // the CLI reference
static const diagnosticsSkill = docsSkill("diagnostics")  // AG#### codes
```

`docsSkill` and its cousin `skillsDir` (which does the same thing for a
user-supplied folder) both funnel into one helper, `buildSkillsTool`
(`stdlib/skills.agency:187`). For each Markdown file in the directory,
`buildSkillsTool` reads the file's *front matter* (explained next) and
renders one XML block into the tool's description:

```text
<skill>
  <name>http</name>
  <description>Fetch URLs from Agency code. Returns text, JSON, or Markdown.</description>
  <location>http.md</location>
</skill>
```

The model reads that block, decides `std::http` is what it needs, and
calls the tool with `filename: "http.md"` to pull the full page. So the
`<description>` line is the *only* thing the model sees about a module
before choosing to open it. If that line is blank, the model is choosing
blind — guessing from the filename alone.

### Front matter is the metadata block at the top of a doc

"Front matter" is the small block fenced by `---` at the very top of a
Markdown file. Here is the top of the hand-written guide page
`docs/site/guide/basic-syntax.md`:

```markdown
---
name: Basic syntax
description: Overview of Agency's TypeScript-derived syntax, covering
  primitive types, variables, arrays, objects, functions, and other core
  language constructs.
---

# Basic syntax
...
```

The `description:` field is exactly what `buildSkillsTool` renders into
the `<description>` line above. The guide pages are written by hand, so
their authors wrote those descriptions by hand too.

The stdlib pages are different: they are **generated** by the `agency
doc` command from the `.agency` source (see the note in the root
`CLAUDE.md`). Here is the top of the generated `docs/site/stdlib/http.md`:

```markdown
---
name: "http"
---

# http

Fetch URLs from Agency code. Returns the response as text, JSON, or
Markdown...
```

Notice what's missing: there's a `name:` but **no `description:`**. The
generator only ever writes `name:` (`lib/cli/doc.ts:170`):

```ts
const frontmatter = `---\nname: "${safeName}"\n---`;
```

So even if we pointed the agent's doc tool at the stdlib folder today,
every module would render as `<description></description>` — an empty
line. The agent would see 64 module names and no hint of what any of them
is for.

### Where the summary text could come from

Here is the lucky part. The generator already parses each module's
top-of-file doc comment — the `/** @module ... */` block — into
`program.docComment`, and renders it as the page body
(`lib/cli/doc.ts:178`). And 63 of the 64 stdlib modules already have one.
Better still, these comments almost always **open with plain prose stating
what the module is for**, before any code example:

- `std::http` → "Fetch URLs from Agency code. Returns the response as
  text, JSON, or Markdown. Aborting tears down the in-flight request."
- `std::math` → "Small deterministic arithmetic helpers: round, add,
  subtract, multiply, and a divide that returns a Result so you can
  handle division by zero."
- `std::object` → "Helpers for working with objects: read their keys,
  values, and entries, and transform them with `mapValues`, `mapEntries`,
  and `filterEntries`."

That opening prose is a ready-made summary. The generator is already
holding it; it just isn't putting it into the front matter. Note the
length varies: some openings are a single crisp sentence, but others run
two to four sentences (`std::date`'s is ~230 characters). The extraction
rule below takes the whole opening paragraph, so the longer ones will be
capped and truncated — see the note under Part A on when a `@summary`
override is worth adding.

---

## The two gaps, precisely

The end goal — "the agent knows what each stdlib module is for" — breaks
into two independent gaps. Both must be closed; neither depends on the
other.

**Gap 1 — no summary in the stdlib front matter.** `agency doc` writes
only `name:`. We need it to also write a `description:`, sourced from the
module's `@module` comment. This is a change to `lib/cli/doc.ts` only.

**Gap 2 — the agent can't reach the stdlib docs at all.** `docsSkill`
accepts only `"guide" | "cli" | "diagnostics"`, and the build only stages
those three doc folders into the shipped package. There is no `"stdlib"`
option, and nothing wires a stdlib doc tool into any subagent. Closing
this touches the makefile, `lib/stdlib/skills.ts`, `stdlib/skills.agency`,
and the subagents. It also has a sharp edge described below (nested
docs).

---

## Approaches considered for Gap 1

We weighed three ways to get a summary into the front matter.

**A. A hand-curated prompt listing every module.** Write one document
that lists all 64 modules with a sentence each, and feed it to the agent.
Rejected: it duplicates information that already lives next to the code,
and it drifts — every new module means remembering to edit a central
file, and there is no check that catches you when you forget.

**B. A dedicated `@summary` tag, hand-written per module.** Add a new
doc-comment tag whose text becomes the `description`. Explicit and
single-purpose, but it moves the maintenance burden rather than removing
it: someone still hand-writes 64 summaries now and must remember one for
every future module. It also implies new language-parser surface for what
is really a documentation concern.

**C. Derive the summary from the existing `@module` comment, with an
optional override.** The generator takes the opening line of the
`@module` comment as the `description`. Because 63 of 64 modules already
have a good opening line, this gives near-total coverage for free and
**cannot drift** — it regenerates from the same source that produces the
page body. For the rare module whose opening line is a poor summary, an
optional override lets the author supply a better one.

**Decision: C.** It reuses content that already exists, needs no new
language syntax, and stays correct on its own.

---

## The design

Three parts. Parts A and B close Gap 1 (the summary). Part C closes Gap 2
(the wiring).

### Part A — Derive `description` from the `@module` comment

In `lib/cli/doc.ts`, when a file has a `program.docComment`, compute a
one-line summary from it and emit it as a `description:` field in the
generated front matter, alongside the existing `name:`.

**Extraction rule.** Take the text of the `@module` comment and keep only
its leading prose:

1. Start at the first non-blank line of the comment body.
2. Stop at the first blank line **or** the first code fence, whichever
   comes first. This discards the code examples that usually follow the
   summary. **Detect the fence after trimming each line's leading
   whitespace** — `@module` bodies are indented, so the fence renders as
   `  ```ts`, not a line that literally begins with ` ``` ` (verified in
   the generated `http.md`). A `startsWith("```")` check on the raw line
   misses it; today a blank line happens to precede every fence and masks
   the bug, but that is incidental — trim first.
3. Collapse all internal whitespace and newlines to single spaces, and
   trim.
4. If the result is longer than a cap (proposed: **200 characters**),
   truncate at the last word boundary before the cap and append `…`.

Worked example — `std::http`, whose comment is:

```text
/** @module
  Fetch URLs from Agency code. Returns the response as text, JSON, or Markdown.
  Aborting tears down the in-flight request.

  ```ts
  import { fetch, fetchJSON } from "std::http"
  ...
*/
```

The rule stops at the blank line before the code fence, giving:

```text
Fetch URLs from Agency code. Returns the response as text, JSON, or
Markdown. Aborting tears down the in-flight request.
```

which is emitted as:

```markdown
---
name: "http"
description: "Fetch URLs from Agency code. Returns the response as text, JSON, or Markdown. Aborting tears down the in-flight request."
---
```

**Why "first paragraph" and not "first sentence."** A first-sentence rule
needs to split on `. `, which trips on abbreviations ("e.g.", "i.e.") and
would occasionally cut a summary in half. The first-paragraph rule has
unambiguous delimiters (blank line / code fence) and no natural-language
parsing. It can run two to four sentences long; the length cap keeps it
bounded, and the Part B override handles anything that reads badly. Expect
the initial regeneration to leave several long summaries truncated at the
cap (`std::date` is the clearest case) — a first-pass sweep adding
`@summary` overrides to the longest handful is worthwhile before shipping,
not deferred indefinitely.

**Emitting the value: quoted, with `"` and `\` stripped — not bare, not
escaped.** This is subtle because the generated front matter has *two*
consumers with different YAML rules, and they pull in opposite directions:

- The **agent** reads it through `std::markdown`'s `frontmatter`, which is
  tarsec's parser. Tarsec's quoted-value path is `map(quotedString,
  stripQuotes)`, and `stripQuotes` is `s.slice(1, -1)` — it removes the
  outer quotes and **unescapes nothing**. So an *escaped* value like
  `description: "...e.g. \"America/New_York\"..."` reaches the agent with
  literal backslashes. Escaping is therefore wrong.
- The **docs site** reads it through VitePress (`docs/site/.vitepress/`),
  whose gray-matter/js-yaml is a *strict* YAML parser. A **bare** value is
  rejected when it contains `: ` (colon-space), which many stdlib
  summaries do (`std::math` → "…helpers: round, add…"; `std::object` →
  "…objects: read their keys…"). So bare emission would break the docs
  build.

The value that satisfies both: a **double-quoted** scalar whose content
has had `"` and `\` **removed** (mirroring exactly what `name` already
does at `lib/cli/doc.ts:169`, `title.replace(/["\\\n]/g, "")`). Quoting
makes colon-space, `#`, `[`, and apostrophes safe for strict YAML;
removing (not escaping) `"`/`\` means tarsec's `stripQuotes` returns clean
text with no stray backslashes. `std::date`'s `e.g. "America/New_York"`
becomes `e.g. America/New_York` in the emitted value — lossy on the inner
quotes, but readable and correct in both parsers. Replacing `"` with `'`
instead of deleting it is an acceptable nicety; deleting matches the
existing `name` precedent. The acceptance test is a genuine round-trip:
run a value containing `"` and `: ` through `agency doc`, then read it
back with `std::markdown`'s `frontmatter`, and assert the string matches
what was intended with no backslashes.

**Files with no `@module` comment.** One stdlib module (`std::mcp`) lacks
a `@module` comment today. When there is no comment, emit no
`description:` field (exactly today's behavior) — do not emit an empty
one. The agent falls back to the module name, no worse off than now.

**Files with no `@module` comment.** One stdlib module lacks a `@module`
comment today. When there is no comment, emit no `description:` field
(exactly today's behavior) — do not emit an empty one. The agent falls
back to the module name, no worse off than now.

### Part B — An optional override, inside the `@module` comment

For the handful of modules whose opening prose is a poor summary, let the
author supply an explicit one. Crucially, this override lives **inside
the `@module` comment** and is parsed by the doc command — it is **not** a
new language-level tag, so it touches no parser or preprocessor code.

The convention: if the first line of the `@module` body is `@summary
<text>`, that text becomes the `description`, and the `@summary` line is
stripped from the rendered page body (so it never shows up as literal
text on the page). If there is no `@summary` line, Part A's derivation
applies.

Example:

```text
/** @module
  @summary Read and write the system clipboard.
  The clipboard module exposes copy/paste over the OS pasteboard, with
  the usual platform caveats described below...
*/
```

produces `description: "Read and write the system clipboard."` regardless
of how the body prose reads, and the page body begins at "The clipboard
module exposes...".

**Why a doc-command convention rather than a real tag.** A summary is
documentation metadata, not program structure. Keeping it inside the
comment and parsing it in `lib/cli/doc.ts` means the language parser, the
preprocessor, and the AST are all untouched. The blast radius is one
file.

### Part C — Wire the stdlib docs into the agent

Four steps, all mechanical, but one has a sharp edge (step 3).

**1. Stage the docs into the shipped package.** The makefile copies
`docs/site/{guide,cli,diagnostics}` into `stdlib/docs/` so they ship
inside the installed package (see `stage-stdlib-docs` in the makefile,
referenced from `lib/stdlib/skills.ts:31`). Add `docs/site/stdlib` to
that staging so `stdlib/docs/stdlib/` exists in both dev and npm installs.

**2. Add a `"stdlib"` section.** Two coordinated edits:
   - `_docsDir` in `lib/stdlib/skills.ts:36` — widen its parameter type
     from `"guide" | "cli" | "diagnostics"` to include `"stdlib"`, so it
     resolves `stdlib/docs/stdlib`.
   - `docsSkill` in `stdlib/skills.agency:239` — widen the same union in
     its signature and docstring.

**3. Make the stdlib doc tool glob recursively.** This is the sharp edge.
29 of the 64 stdlib docs live in subdirectories — `ui/table.md`,
`auth/oauth.md`, `web/search.md`, `agency/local.md`, and so on. The
"flat" layout that `docsSkill` uses globs `*.{md,markdown}`, and a single
`*` does not descend into subdirectories. So a naive `docsSkill("stdlib")`
would list only the 35 top-level modules and **silently drop the other
29** — worse than useless, because it looks complete.

The stdlib doc tool must glob recursively so all 64 modules appear, each
with its subdirectory-qualified `location` (e.g. `ui/table.md`) that
`read` can resolve. The pattern `**/*.{md,markdown}` is confirmed to do
this: run against `_glob`, `*.{md,markdown}` matches 35 (top-level only)
while `**/*.{md,markdown}` matches all 64 — tarsec's glob does *not* hit
the classic "`**/` excludes top-level files" trap, and `_glob`'s
`walkDir` already recurses the whole tree, so the only change is the
pattern's regex. The plan should choose the least-invasive way to route
this recursive pattern to the stdlib docs case without changing the
behavior of existing `skillsDir(..., "flat")` callers — options include a
recursive-flat variant or a dedicated glob for the docs path. The
acceptance check is concrete: the generated tool description must list all
64 modules, including the nested ones.

**4. Register the tool in the subagents.** Add `docsSkill("stdlib")` to
the tool lists of the subagents that answer standard-library questions —
**code**, **research**, and **explorer** — and add a one-line note to each
of their system prompts describing it, mirroring how `docSkill` /
`cliSkill` are introduced today (e.g. `code.agency:100`). The oracle is
out of scope for now; it can be added later if it proves useful.

---

## How we'll know it works

- **Part A/B, unit level.** Table-driven tests over the extraction rule:
  a comment with a code fence stops at the fence; a multi-paragraph
  comment stops at the first blank line; a `@summary` line overrides and
  is stripped from the body; an indented code fence (`  ```ts`) is still
  detected as a fence; a comment longer than the cap truncates on a word
  boundary; a file with no `@module` emits no `description:`. A dedicated
  round-trip test: emit a value containing `"` and `: `, then read it back
  with `std::markdown`'s `frontmatter` and assert the string is clean (no
  stray backslashes, quotes handled as the strip rule specifies).
- **Part A/B, integration.** Run `agency doc` over `stdlib/` and assert a
  spot-check set (`http`, `date`, `math`, `object`, a nested one like
  `ui/table`) each gain a sensible `description:`, and that VitePress's
  YAML parser accepts the generated front matter (the colon-space cases
  `math` / `object` are the ones a bare value would have broken).
- **Part C.** Build the tool via `docsSkill("stdlib")` and assert its
  description lists all 64 modules (the nested-glob regression), each with
  a non-empty `<description>`. Confirm the code/research/explorer
  subagents carry the tool.
- **End to end.** Regenerate the stdlib docs (`make` / the doc step) so
  the committed `docs/site/stdlib/*.md` show the new front matter.

---

## Out of scope

- No new language syntax or AST changes. `@summary` is a doc-command
  convention, not a tag the compiler knows about.
- No change to how the guide / CLI / diagnostics docs are authored or
  rendered.
- No rewrite of any `@module` comment for content. If a module's opening
  line is a weak summary, adding a `@summary` override is a follow-up per
  module, not part of this work.
- The oracle subagent does not get the stdlib tool in this pass.
