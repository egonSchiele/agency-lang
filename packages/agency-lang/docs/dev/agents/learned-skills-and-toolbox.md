# Learned skills and the wired-in toolbox

The agency agent can be taught. The user tells the coordinator to save a
skill for a named subagent, or to have a tool written into that
subagent's toolbox; a review interrupt shows the complete artifact
before anything lands on disk; and the target subagent carries the
result from its next invocation on — in the same session, and in every
later one. This note records how the pieces fit and the decisions
behind them. The spec is
`2026-08-31-learned-skills-and-toolbox-spec.md` at the package root
while the arc is in flight.

## What "learned" means here

Two kinds of artifact, both user-directed (the agent never decides on
its own to save something):

- A **skill** is reference prose: a flat-layout markdown file with
  `name` and `description` frontmatter, the same format the bundled
  skills use. The target agent's skills tool lists it and reads it on
  demand. Skills never become slash commands — a slash command is
  user-invoked, a skill is model-invoked.
- A **tool** is executable: a `std::toolbox` tool directory produced by
  the `writeTool` pipeline (drafting agent, review agent, sandbox
  compile and typecheck, generated tests for pure tools, review
  interrupt, staged publish).

## Storage

Everything lives under the agent home, namespaced by the coordinator's
wrapper names (`code`, `research`, `explorer`, `oracle`, `review`,
`writing`, `rewrite`):

```
<agent home>/
  skills/<subagent>/<skill-name>.md
  tools/<subagent>/<tool-name>/...
```

Global only: project-scoped directories were deliberately deferred. The
bundled skills stay immutable in the package; learned skills are an
overlay served through a second tool, `learned_skills_<agent>`.

## The catalogs (`lib/agents/agency-agent/lib/learned.agency`)

Session state sits in two module globals — a top-level `let`, not a
`static const`. The CLI agent is one long-lived run, so a global lives
for the whole session and, unlike a static, can be dropped mid-session
when something is saved (`docs/site/guide/global-vs-static.md`).

Loading is lazy and interrupt-bounded: the skills catalog loads with
ONE `std::skills::skillsDir` interrupt covering the whole skills root
(`scanSkillsSubdirs` in `stdlib/skills.agency`, which takes the subagent
names as a parameter — each validated as a bare path segment, so a
compound or `..` name can never carry the root's approval outside the
root — and scans each subdirectory with its own file cap); the toolbox
catalog loads with one `listTools` scan per agent directory that
exists. A missing root loads as an empty catalog with no interrupt, and
a rejected scan caches an empty catalog rather than the Failure value.

The catalogs are only a cache of the disk, never a second copy of the
truth: a save calls `invalidateLearned()` (both globals to null), and
the next access rescans. An earlier design updated the catalogs in
place after a save; it saved one scan interrupt per save and bought a
whole class of cache-coherence bugs (a stale entry surviving a
delete-and-reteach, duplicate entries, a record pushed into a copy the
cache never held), so it was replaced. Saves are rare and
user-directed, and the same policy scope that approved the first scan
approves the rescan.

Learned tools with an over-long name (one whose `learned_` prefix would
break the 64-character provider cap — possible only for a directory
dropped in by hand, since `writeToolFor` refuses such names) stay
visible in the inventory but are never offered to the model: one bad
name would fail every LLM call the target makes.

Each subagent invocation calls `learnedExtrasFor(<wrapper name>)`
inside the wrapper function body — never at module top level — and
passes the result through the stdlib agents' `extraTools` parameter
(the code subagent appends to its local tool list instead). Building
per invocation is what makes a skill saved this turn live on the
target's next call.

Learned tools are renamed `learned_<name>` before the model sees them.
That prefix is the whole collision story: no built-in tool starts with
`learned_` (a test pins this for the code agent's list), so a learned
tool can never shadow or trip the provider's unique-name rule against a
built-in.

## The write paths

`writeSkill(dir, name, description, body)` lives in `std::skills` so
user-written agents get the same primitive. It composes the frontmatter
through tarsec's `stringifyFrontmatter` (the encode half of the parser
`std::markdown` wraps, added in tarsec 0.5.4 for exactly this: a
hand-rolled encoder against a grammar it does not own kept producing
silent read-back corruption — flow syntax, quote escapes, bare-numeric
coercion). The serializer round-trips every value it accepts and throws
on the rare one it cannot hold, which `writeSkill` surfaces as a clean
failure. A raw-content parameter was rejected because a description
could then extend the frontmatter. It validates the name against
kebab-case rather than rewriting it, refuses duplicates before raising
anything, then shows the complete file in a
`std::skills::reviewSkill` interrupt. The
handler answers accept (or bare `approve()`), revise-with-feedback —
returned to the caller so the coordinator redrafts and tries again — or
reject, which fails the call. Only an accepted draft touches disk, via
ordinary `std::mkdir`/`std::write`.

`writeToolFor(target, ...)` on the coordinator is a thin wrapper over
`writeTool` rooted at `<agent home>/tools/<target>`; the pipeline and
its own review interrupt are used as-is.

## Policy

The built-in read scope covers
`{<agent-home>/skills/**,<agent-home>/tools/**}`
(`readScopeRules` in `lib/runtime/builtinPolicies.ts`, the
`<agent-home>` placeholder in `lib/runtime/policy.ts`). This is a
deliberate widening, stated as a trade: without it, every learned-skill
read, catalog scan, and `runTool` call (which rescans its tool
directory) would prompt on every use and auto-reject headless. The
directories are the agent's own home and are written only through
review interrupts; a stricter custom policy overrides the rule like any
other. `docs/dev/agents/approval-policies.md` documents the
placeholder.

`runTool`'s use-count bookkeeping has its own effect,
`std::toolbox::recordUse`, approved under `recommended` for the
agent-home toolboxes. A `std::write` rule scoped to `meta.json` was
tried first and reverted: a dir+filename glob cannot tell the stdlib's
own bookkeeping apart from ANY program writing arbitrary content into a
tool's `meta.json`, whose `purpose`/`request` text `listTools` then
trusts — so the rule was a content-injection hole. The dedicated effect
approves only the mutation the stdlib composes, and it is best-effort:
a declined `recordUse` never fails a run that succeeded. Writes are NOT
widened: saving a skill or publishing a tool raises the ordinary write
interrupts on top of the review gate, and under with-writes
(cwd-scoped) a home-directory write surfaces for explicit approval. For
"the agent is permanently teaching itself something," that double
visibility is intended.

The scope rules live in the shared `readScopeRules()`, so a non-agent
`agency run --policy recommended` script gets them too; the built-in
policy descriptions disclose it. Layering them agent-side was
considered and rejected: the policy handler flushes its whole
in-memory policy to the user's `policy.json` on an "always" decision,
so a session-layered rule would either leak into the saved file or
force every default session's always-decisions onto the session-only
path.

Interactively, the review interrupts answer with approve (a bare
approve counts as accept) or reject; the revise verdict is a
structured answer only a handler or policy can give today. The
coordinator still round-trips revisions by relaying the user's words
and calling the tool again with a fresh draft.

## The user surface

`/skills` and `/toolbox` (`lib/agents/agency-agent/lib/learnedView.agency`)
render the inventory grouped by subagent, with a one-line hint when
nothing has been learned. There is no dedicated remove flow: deleting a
learned artifact is an ordinary file operation, picked up at the next
session's scan.

## Deferred on purpose

Project-scoped directories; the coordinator as a learning target;
promoting a learned skill to a slash command; agent-initiated learning;
migrating the bundled skills tools off statics.
